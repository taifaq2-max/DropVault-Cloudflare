/**
 * ShareAccessGate — Durable Object that guarantees at-most-once share access.
 *
 * Each share gets its own instance keyed by shareId. When a receiver tries to
 * access a share we enter a critical section: check if it was already accessed,
 * and if not, atomically mark it as accessed. This prevents two concurrent
 * requests from both "winning" the access check due to KV eventual consistency.
 *
 * State stored in the DO's persistent storage:
 *   accessed: boolean
 *   accessedAt: string (ISO timestamp) | null
 */

export class ShareAccessGate {
  private state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const action = url.pathname.slice(1); // "check" or "mark"

    if (action === "check") {
      return this.handleCheck();
    }
    if (action === "mark") {
      return this.handleMark();
    }
    return new Response("Not found", { status: 404 });
  }

  /** Return whether the share has already been accessed. */
  private async handleCheck(): Promise<Response> {
    const accessed = (await this.state.storage.get<boolean>("accessed")) ?? false;
    const accessedAt = (await this.state.storage.get<string>("accessedAt")) ?? null;
    return Response.json({ accessed, accessedAt });
  }

  /**
   * Atomically check-and-mark. Returns:
   *   { ok: true }  — first access; share was not yet marked
   *   { ok: false } — already accessed
   *
   * Uses blockConcurrencyWhile to serialise concurrent requests.
   */
  private async handleMark(): Promise<Response> {
    let alreadyAccessed = false;

    await this.state.blockConcurrencyWhile(async () => {
      const current = (await this.state.storage.get<boolean>("accessed")) ?? false;
      if (current) {
        alreadyAccessed = true;
      } else {
        await this.state.storage.put("accessed", true);
        await this.state.storage.put("accessedAt", new Date().toISOString());
      }
    });

    if (alreadyAccessed) {
      return Response.json({ ok: false }, { status: 409 });
    }
    return Response.json({ ok: true });
  }
}
