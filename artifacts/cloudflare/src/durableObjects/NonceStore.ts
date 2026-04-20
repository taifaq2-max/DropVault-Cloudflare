/**
 * NonceStore — Durable Object for single-use nonce revocation.
 *
 * The Worker issues HMAC-SHA256 nonces (bound to shareId + IP + timestamp).
 * This DO serves as the distributed revocation registry: once a nonce is
 * consumed by the access endpoint, it is recorded here so that no other
 * Worker instance can replay it within its TTL window.
 *
 * The DO does NOT issue nonces — that's done by CloudflareAdapter using
 * the SESSION_SECRET, which keeps nonce generation stateless (no storage write
 * on every peek, only on every access).
 *
 * State:
 *   used:{nonce} → expiresAt (unix ms)
 *
 * Cleanup of expired entries happens lazily on each revoke call.
 */

export class NonceStore {
  private state: DurableObjectState;
  private readonly TTL_MS = 5 * 60 * 1000;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const action = url.pathname.slice(1);

    if (request.method === "POST" && action === "revoke") {
      return this.handleRevoke(request);
    }
    if (request.method === "POST" && action === "is-consumed") {
      return this.handleIsConsumed(request);
    }
    return new Response("Not found", { status: 404 });
  }

  /**
   * Atomically check if a nonce is already consumed; if not, consume it.
   * Returns { consumed: false } if the nonce was free and is now marked.
   * Returns { consumed: true }  if the nonce was already consumed.
   *
   * This is the primary safe-consume operation — callers should use this
   * rather than separate check + revoke calls.
   */
  private async handleRevoke(request: Request): Promise<Response> {
    const { nonce, expiresAt } = (await request.json()) as {
      nonce: string;
      expiresAt: number;
    };
    const key = `used:${nonce}`;

    let alreadyConsumed = false;

    await this.state.blockConcurrencyWhile(async () => {
      // Lazy cleanup: remove all expired entries while we have the lock
      const all = await this.state.storage.list<number>({ prefix: "used:" });
      const now = Date.now();
      const toDelete: string[] = [];
      for (const [k, exp] of all) {
        if (exp < now) toDelete.push(k);
      }
      if (toDelete.length > 0) {
        await this.state.storage.delete(toDelete);
      }

      const existing = await this.state.storage.get<number>(key);
      if (existing !== undefined) {
        alreadyConsumed = true;
        return;
      }

      await this.state.storage.put(key, expiresAt);
    });

    return Response.json({ consumed: alreadyConsumed });
  }

  /** Check without consuming — used for read-only inspection. */
  private async handleIsConsumed(request: Request): Promise<Response> {
    const { nonce } = (await request.json()) as { nonce: string };
    const key = `used:${nonce}`;
    const entry = await this.state.storage.get<number>(key);
    const consumed = entry !== undefined && entry > Date.now();
    return Response.json({ consumed });
  }
}
