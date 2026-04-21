import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

vi.mock("../services/rateLimiter.js", () => ({
  checkRateLimit: vi.fn(() => ({ allowed: true, retryAfterSeconds: 0 })),
  checkPeekRateLimit: vi.fn(() => ({ allowed: true, retryAfterSeconds: 0 })),
}));

const { default: app } = await import("../app.js");
const { checkPeekRateLimit } = await import("../services/rateLimiter.js");

const VALID_SHARE_BODY = {
  encryptedData: "aGVsbG93b3JsZA==",
  ttl: 3600,
  shareType: "text",
  totalSize: 12,
  captchaToken: "",
};

describe("POST /api/shares", () => {
  it("creates a share and returns 201 with shareId and expiresAt", async () => {
    const res = await request(app).post("/api/shares").send(VALID_SHARE_BODY);
    expect(res.status).toBe(201);
    expect(typeof res.body.shareId).toBe("string");
    expect(res.body.shareId.length).toBeGreaterThan(0);
    expect(typeof res.body.expiresAt).toBe("string");
  });

  it("rejects a request with missing required fields (400)", async () => {
    const res = await request(app).post("/api/shares").send({ ttl: 3600 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("validation_error");
  });

  it("rejects a payload exceeding 2.5 MB (413)", async () => {
    const res = await request(app)
      .post("/api/shares")
      .send({ ...VALID_SHARE_BODY, totalSize: 3 * 1024 * 1024 });
    expect(res.status).toBe(413);
    expect(res.body.error).toBe("payload_too_large");
  });

  it("rejects encryptedData with invalid characters (400)", async () => {
    const res = await request(app)
      .post("/api/shares")
      .send({ ...VALID_SHARE_BODY, encryptedData: "!!!invalid!!!" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_data");
  });

  it("rejects more than 10 files (400)", async () => {
    const fileMetadata = Array.from({ length: 11 }, (_, i) => ({
      name: `file${i}.txt`,
      size: 10,
      type: "text/plain",
      originalIndex: i,
    }));
    const res = await request(app)
      .post("/api/shares")
      .send({ ...VALID_SHARE_BODY, shareType: "files", fileMetadata });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("too_many_files");
  });
});

describe("GET /api/shares/:shareId/peek", () => {
  it("returns share metadata without consuming it", async () => {
    const createRes = await request(app)
      .post("/api/shares")
      .send(VALID_SHARE_BODY);
    expect(createRes.status).toBe(201);
    const { shareId } = createRes.body as { shareId: string };

    const peekRes = await request(app).get(`/api/shares/${shareId}/peek`);
    expect(peekRes.status).toBe(200);
    expect(peekRes.body.passwordRequired).toBe(false);
    expect(peekRes.body.shareType).toBe("text");
    expect(typeof peekRes.body.expiresAt).toBe("string");

    const peekAgain = await request(app).get(`/api/shares/${shareId}/peek`);
    expect(peekAgain.status).toBe(200);
  });

  it("returns 410 already_accessed after share is consumed — no captcha token needed (early check priority)", async () => {
    // Create a share, consume it via the GET endpoint, then verify that peek returns
    // already_accessed *without* a captcha token.  This is the contract the frontend
    // re-check relies on: the server evaluates share state before captcha verification,
    // so a consumed share always surfaces already_accessed regardless of captcha config.
    const createRes = await request(app)
      .post("/api/shares")
      .send(VALID_SHARE_BODY);
    expect(createRes.status).toBe(201);
    const { shareId } = createRes.body as { shareId: string };

    // Consume the share
    await request(app).get(`/api/shares/${shareId}`);

    // Tokenless re-peek (as the frontend re-check does) must return already_accessed
    const peekRes = await request(app).get(`/api/shares/${shareId}/peek`);
    expect(peekRes.status).toBe(410);
    expect(peekRes.body.error).toBe("already_accessed");
  });

  it("returns 404 for a nonexistent share", async () => {
    const res = await request(app).get("/api/shares/nonexistent-id-xyz/peek");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  it("returns 429 with Retry-After header when peek rate limit is exceeded", async () => {
    vi.mocked(checkPeekRateLimit).mockReturnValueOnce({
      allowed: false,
      retryAfterSeconds: 42,
    });

    const res = await request(app).get("/api/shares/any-share-id/peek");

    expect(res.status).toBe(429);
    expect(res.body.error).toBe("rate_limit_exceeded");
    expect(res.body.retryAfterSeconds).toBe(42);
    expect(res.headers["retry-after"]).toBe("42");
  });
});

describe("GET /api/shares/:shareId", () => {
  it("retrieves a share and marks it as accessed", async () => {
    const createRes = await request(app)
      .post("/api/shares")
      .send(VALID_SHARE_BODY);
    expect(createRes.status).toBe(201);
    const { shareId } = createRes.body as { shareId: string };

    const getRes = await request(app).get(`/api/shares/${shareId}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.encryptedData).toBe(VALID_SHARE_BODY.encryptedData);
    expect(getRes.body.shareType).toBe("text");
  });

  it("returns 410 when share is accessed a second time", async () => {
    const createRes = await request(app)
      .post("/api/shares")
      .send(VALID_SHARE_BODY);
    expect(createRes.status).toBe(201);
    const { shareId } = createRes.body as { shareId: string };

    await request(app).get(`/api/shares/${shareId}`);

    const secondGet = await request(app).get(`/api/shares/${shareId}`);
    expect(secondGet.status).toBe(410);
    expect(secondGet.body.error).toBe("already_accessed");
  });

  it("returns 404 for a nonexistent share", async () => {
    const res = await request(app).get("/api/shares/nonexistent-id-xyz");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });
});

describe("DELETE /api/shares/:shareId", () => {
  it("deletes a share and returns success", async () => {
    const createRes = await request(app)
      .post("/api/shares")
      .send(VALID_SHARE_BODY);
    expect(createRes.status).toBe(201);
    const { shareId } = createRes.body as { shareId: string };

    const delRes = await request(app).delete(`/api/shares/${shareId}`);
    expect(delRes.status).toBe(200);
    expect(delRes.body.success).toBe(true);
  });

  it("returns 404 when deleting a nonexistent share", async () => {
    const res = await request(app).delete("/api/shares/nonexistent-id-xyz");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  it("share is gone after deletion (peek returns 404)", async () => {
    const createRes = await request(app)
      .post("/api/shares")
      .send(VALID_SHARE_BODY);
    expect(createRes.status).toBe(201);
    const { shareId } = createRes.body as { shareId: string };

    await request(app).delete(`/api/shares/${shareId}`);

    const peekRes = await request(app).get(`/api/shares/${shareId}/peek`);
    expect(peekRes.status).toBe(404);
  });
});
