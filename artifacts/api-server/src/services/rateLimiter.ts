interface RateLimitEntry {
  count: number;
  windowStart: number;
}

const limitMap = new Map<string, RateLimitEntry>();

const WINDOW_MS = 60_000; // 1 minute
const MAX_PER_WINDOW = 3;

// Cleanup old entries every minute
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of limitMap.entries()) {
    if (now - entry.windowStart > WINDOW_MS) {
      limitMap.delete(ip);
    }
  }
}, 60_000);

export function checkRateLimit(ip: string): {
  allowed: boolean;
  retryAfterSeconds: number;
} {
  const now = Date.now();
  const entry = limitMap.get(ip);

  if (!entry || now - entry.windowStart > WINDOW_MS) {
    limitMap.set(ip, { count: 1, windowStart: now });
    return { allowed: true, retryAfterSeconds: 0 };
  }

  if (entry.count >= MAX_PER_WINDOW) {
    const elapsed = now - entry.windowStart;
    const retryAfterMs = WINDOW_MS - elapsed;
    return {
      allowed: false,
      retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
    };
  }

  entry.count++;
  return { allowed: true, retryAfterSeconds: 0 };
}
