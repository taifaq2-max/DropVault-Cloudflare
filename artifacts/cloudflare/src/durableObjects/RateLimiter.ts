/**
 * RateLimiter — Durable Object for sliding-window rate limiting.
 *
 * One global DO instance handles all rate limit checks. Each check is keyed
 * by a string (typically IP + endpoint). State is a Map of key → timestamps[]
 * (sliding window of hit times). All timestamps outside the window are pruned
 * on each check to keep storage lean.
 *
 * Request body: { key: string, windowMs: number, maxHits: number }
 * Response:     { allowed: boolean, remaining: number, retryAfterSeconds?: number }
 */

interface WindowEntry {
  hits: number[]; // array of unix-ms timestamps within the window
}

export class RateLimiter {
  private state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const action = url.pathname.slice(1);

    if (request.method === "POST" && action === "check") {
      return this.handleCheck(request);
    }
    return new Response("Not found", { status: 404 });
  }

  private async handleCheck(request: Request): Promise<Response> {
    const { key, windowMs, maxHits } = (await request.json()) as {
      key: string;
      windowMs: number;
      maxHits: number;
    };

    let result: { allowed: boolean; remaining: number; retryAfterSeconds?: number } = {
      allowed: true,
      remaining: maxHits,
    };

    await this.state.blockConcurrencyWhile(async () => {
      const storeKey = `rl:${key}`;
      const now = Date.now();
      const windowStart = now - windowMs;

      const entry = (await this.state.storage.get<WindowEntry>(storeKey)) ?? { hits: [] };

      // Prune expired hits
      const activeHits = entry.hits.filter((t) => t > windowStart);

      if (activeHits.length >= maxHits) {
        // Rate limited — find earliest hit to compute retry-after
        const earliest = Math.min(...activeHits);
        const retryAfterMs = earliest + windowMs - now;
        result = {
          allowed: false,
          remaining: 0,
          retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
        };
        // Still persist pruned hits (no new hit recorded)
        await this.state.storage.put<WindowEntry>(storeKey, { hits: activeHits });
        return;
      }

      // Allowed — record hit
      activeHits.push(now);
      await this.state.storage.put<WindowEntry>(storeKey, { hits: activeHits });

      result = {
        allowed: true,
        remaining: maxHits - activeHits.length,
      };
    });

    return Response.json(result);
  }
}
