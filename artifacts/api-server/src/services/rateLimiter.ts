interface RateLimitEntry {
  count: number;
  windowStart: number;
}

const WINDOW_MS = 60_000; // 1 minute
const MAX_PER_WINDOW = 3;

export const PEEK_RATE_LIMIT_MAX =
  parseInt(process.env["PEEK_RATE_LIMIT_MAX"] ?? "", 10) || 10;

function createLimitMap(): Map<string, RateLimitEntry> {
  const map = new Map<string, RateLimitEntry>();

  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of map.entries()) {
      if (now - entry.windowStart > WINDOW_MS) {
        map.delete(key);
      }
    }
  }, 60_000);

  return map;
}

function makeChecker(
  map: Map<string, RateLimitEntry>,
  maxPerWindow: number,
): (key: string) => { allowed: boolean; retryAfterSeconds: number } {
  return function checkLimit(
    key: string,
  ): { allowed: boolean; retryAfterSeconds: number } {
    const now = Date.now();
    const entry = map.get(key);

    if (!entry || now - entry.windowStart > WINDOW_MS) {
      map.set(key, { count: 1, windowStart: now });
      return { allowed: true, retryAfterSeconds: 0 };
    }

    if (entry.count >= maxPerWindow) {
      const elapsed = now - entry.windowStart;
      const retryAfterMs = WINDOW_MS - elapsed;
      return {
        allowed: false,
        retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
      };
    }

    entry.count++;
    return { allowed: true, retryAfterSeconds: 0 };
  };
}

const defaultLimitMap = createLimitMap();
export const checkRateLimit = makeChecker(defaultLimitMap, MAX_PER_WINDOW);

const peekLimitMap = createLimitMap();
export const checkPeekRateLimit = makeChecker(peekLimitMap, PEEK_RATE_LIMIT_MAX);
