/**
 * NonceStore — Durable Object for HMAC-SHA256 nonce issuance and revocation.
 *
 * Nonces prevent replay of the captcha-bypass trick: each peek issues a
 * short-lived (5-minute) nonce; the access endpoint validates and immediately
 * revokes it. Revocation is handled inside the DO to avoid KV race conditions.
 *
 * State per-instance (one DO per deployment, not per share):
 *   nonce:{nonce} → { shareId, expiresAt }
 *
 * Cleanup of expired entries happens lazily during get/revoke.
 */

interface NonceEntry {
  shareId: string;
  expiresAt: number; // unix ms
}

export class NonceStore {
  private state: DurableObjectState;
  private readonly TTL_MS = 5 * 60 * 1000;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const action = url.pathname.slice(1);

    if (request.method === "POST" && action === "issue") {
      return this.handleIssue(request);
    }
    if (request.method === "POST" && action === "validate") {
      return this.handleValidate(request);
    }
    return new Response("Not found", { status: 404 });
  }

  /** Issue a new nonce for shareId. Returns { nonce }. */
  private async handleIssue(request: Request): Promise<Response> {
    const { shareId } = (await request.json()) as { shareId: string };
    const nonce = crypto.randomUUID();
    const expiresAt = Date.now() + this.TTL_MS;
    await this.state.storage.put<NonceEntry>(`nonce:${nonce}`, { shareId, expiresAt });
    return Response.json({ nonce, expiresAt });
  }

  /**
   * Validate-and-revoke a nonce.
   * Returns { valid: true, shareId } or { valid: false }.
   * Uses blockConcurrencyWhile for atomicity.
   */
  private async handleValidate(request: Request): Promise<Response> {
    const { nonce, shareId } = (await request.json()) as { nonce: string; shareId: string };
    const key = `nonce:${nonce}`;

    let result: { valid: boolean; shareId?: string } = { valid: false };

    await this.state.blockConcurrencyWhile(async () => {
      const entry = await this.state.storage.get<NonceEntry>(key);
      if (!entry) return;
      if (entry.expiresAt < Date.now()) {
        await this.state.storage.delete(key);
        return;
      }
      if (entry.shareId !== shareId) return;

      // Valid — revoke immediately
      await this.state.storage.delete(key);
      result = { valid: true, shareId: entry.shareId };
    });

    return Response.json(result);
  }
}
