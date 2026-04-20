import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import type { Express } from "express";
import request from "supertest";
import crypto from "node:crypto";

const TEST_HCAPTCHA_SECRET = "test-captcha-secret";
const TEST_SESSION_SECRET = "test-session-secret";

vi.mock("../services/rateLimiter.js", () => ({
  checkRateLimit: () => ({ allowed: true, retryAfterSeconds: 0 }),
  checkPeekRateLimit: () => ({ allowed: true, retryAfterSeconds: 0 }),
}));

const originalFetch = globalThis.fetch;

describe("Nonce protection (HCAPTCHA_SECRET_KEY enabled)", () => {
  let app: Express;

  beforeAll(async () => {
    vi.stubEnv("HCAPTCHA_SECRET_KEY", TEST_HCAPTCHA_SECRET);
    vi.stubEnv("SESSION_SECRET", TEST_SESSION_SECRET);
    vi.resetModules();

    globalThis.fetch = vi.fn(async (url: string | URL, opts?: RequestInit) => {
      const urlStr = url.toString();
      if (urlStr === "https://api.hcaptcha.com/siteverify") {
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return originalFetch(url, opts);
    }) as typeof fetch;

    const mod = await import("../app.js");
    app = mod.default;
  });

  afterAll(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    globalThis.fetch = originalFetch;
  });

  function makeNonce(shareId: string, ip: string, tsOverride?: number): string {
    const ts = (tsOverride ?? Date.now()).toString();
    const payload = `${shareId}:${ip}:${ts}`;
    const sig = crypto
      .createHmac("sha256", TEST_SESSION_SECRET)
      .update(payload)
      .digest("base64url");
    return `${sig}.${ts}`;
  }

  async function createShare(): Promise<string> {
    const res = await request(app)
      .post("/api/shares")
      .send({
        encryptedData: "aGVsbG93b3JsZA==",
        ttl: 3600,
        shareType: "text",
        totalSize: 12,
        captchaToken: "valid-token",
      });
    expect(res.status).toBe(201);
    return (res.body as { shareId: string }).shareId;
  }

  it("returns accessNonce in peek response when HCAPTCHA_SECRET_KEY is set", async () => {
    const shareId = await createShare();
    const res = await request(app)
      .get(`/api/shares/${shareId}/peek`)
      .query({ captchaToken: "valid-token" });
    expect(res.status).toBe(200);
    expect(typeof res.body.accessNonce).toBe("string");
    expect(res.body.accessNonce.length).toBeGreaterThan(0);
  });

  it("rejects access with no nonce (403 invalid_nonce)", async () => {
    const shareId = await createShare();
    const res = await request(app).get(`/api/shares/${shareId}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("invalid_nonce");
  });

  it("rejects access with a tampered nonce (403 invalid_nonce)", async () => {
    const shareId = await createShare();
    const validNonce = makeNonce(shareId, "::ffff:127.0.0.1");
    const [sig, ts] = validNonce.split(".");
    const tamperedNonce = `${sig}X.${ts}`;
    const res = await request(app)
      .get(`/api/shares/${shareId}`)
      .query({ accessNonce: tamperedNonce });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("invalid_nonce");
  });

  it("rejects access with an expired nonce (403 invalid_nonce)", async () => {
    const shareId = await createShare();
    const sixMinutesAgo = Date.now() - 6 * 60 * 1000;
    const expiredNonce = makeNonce(shareId, "::ffff:127.0.0.1", sixMinutesAgo);
    const res = await request(app)
      .get(`/api/shares/${shareId}`)
      .query({ accessNonce: expiredNonce });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("invalid_nonce");
  });

  it("grants access with a valid nonce from peek (200)", async () => {
    const shareId = await createShare();
    const peekRes = await request(app)
      .get(`/api/shares/${shareId}/peek`)
      .query({ captchaToken: "valid-token" });
    expect(peekRes.status).toBe(200);
    const { accessNonce } = peekRes.body as { accessNonce: string };

    const accessRes = await request(app)
      .get(`/api/shares/${shareId}`)
      .query({ accessNonce });
    expect(accessRes.status).toBe(200);
    expect(typeof accessRes.body.encryptedData).toBe("string");
  });

  it("rejects access when nonce was issued for a different shareId (403 invalid_nonce)", async () => {
    const shareIdA = await createShare();
    const shareIdB = await createShare();
    const nonceForA = makeNonce(shareIdA, "::ffff:127.0.0.1");
    const res = await request(app)
      .get(`/api/shares/${shareIdB}`)
      .query({ accessNonce: nonceForA });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("invalid_nonce");
  });

  it("rejects access when nonce was issued for a different IP (403 invalid_nonce)", async () => {
    const shareId = await createShare();
    const nonceForOtherIp = makeNonce(shareId, "1.2.3.4");
    const res = await request(app)
      .get(`/api/shares/${shareId}`)
      .query({ accessNonce: nonceForOtherIp });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("invalid_nonce");
  });

  it("rejects a replayed nonce within the TTL window (403, not 410)", async () => {
    const shareId = await createShare();

    // Peek to obtain a fresh, valid nonce
    const peekRes = await request(app)
      .get(`/api/shares/${shareId}/peek`)
      .query({ captchaToken: "valid-token" });
    expect(peekRes.status).toBe(200);
    const { accessNonce } = peekRes.body as { accessNonce: string };

    // First access — consumes both the nonce and the share
    const first = await request(app)
      .get(`/api/shares/${shareId}`)
      .query({ accessNonce });
    expect(first.status).toBe(200);

    // Replay the same nonce — must be rejected as invalid_nonce (403)
    // Without revocation this would return 410 already_accessed;
    // with revocation the nonce check fires first.
    const replay = await request(app)
      .get(`/api/shares/${shareId}`)
      .query({ accessNonce });
    expect(replay.status).toBe(403);
    expect(replay.body.error).toBe("invalid_nonce");
  });
});

describe("Server startup: fail fast if HCAPTCHA_SECRET_KEY set without SESSION_SECRET", () => {
  it("throws at module init when HCAPTCHA_SECRET_KEY is set but SESSION_SECRET is missing", async () => {
    vi.stubEnv("HCAPTCHA_SECRET_KEY", "some-captcha-secret");
    vi.stubEnv("SESSION_SECRET", "");
    vi.resetModules();

    await expect(import("../routes/shares.js")).rejects.toThrow("SESSION_SECRET must be set");

    vi.unstubAllEnvs();
    vi.resetModules();
  });
});
