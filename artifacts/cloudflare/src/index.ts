/**
 * VaultDrop Cloudflare Worker — Hono-based API server.
 *
 * Implements the same REST surface as the Express dev server plus two new
 * endpoints for the R2 direct-upload flow:
 *   POST /api/shares/upload-url  → issue a presigned R2 PUT URL
 *   POST /api/shares/confirm     → activate a share after direct upload
 *
 * Storage is backed by KV (metadata), R2 (encrypted blobs), and Durable Objects
 * (atomic access-once, nonce store, rate limiter).
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./types/env.js";
import { CloudflareAdapter } from "./adapters/cloudflare.js";
import { ShareAccessGate } from "./durableObjects/ShareAccessGate.js";
import { NonceStore } from "./durableObjects/NonceStore.js";
import { RateLimiter } from "./durableObjects/RateLimiter.js";

// ── Re-export Durable Object classes (required by wrangler) ──────────────────
export { ShareAccessGate, NonceStore, RateLimiter };

// ── Constants ────────────────────────────────────────────────────────────────
const HCAPTCHA_VERIFY_URL = "https://api.hcaptcha.com/siteverify";
const NONCE_TTL_MS = 5 * 60 * 1000;

/**
 * Maximum size for the inline KV path.
 * Larger payloads MUST use the upload-url / confirm flow.
 */
const MAX_INLINE_BYTES = 4 * 1024 * 1024; // 4 MB

/**
 * Maximum total share size (420 MB).
 * Enforced for both inline and R2 paths.
 */
const MAX_SHARE_BYTES = 420 * 1024 * 1024;

const MAX_FILES = 10;

const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX_CREATES = 10;
const RATE_LIMIT_MAX_PEEKS = 30;

const HUMOROUS_ERRORS = [
  "We can't find what you're looking for",
  "No droids here",
  "There is no cake",
  "This share has evaporated",
  "The data has left the building",
  "404: Share not found in this dimension",
  "Whatever you're looking for, it isn't here",
];

function randomHumorous(): string {
  return HUMOROUS_ERRORS[Math.floor(Math.random() * HUMOROUS_ERRORS.length)] ?? "Not found";
}

// ── SSRF guard ───────────────────────────────────────────────────────────────
const BLOCKED_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2[0-9]|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^::1$/,
  /^fc00:/i,
  /^fe80:/i,
  /metadata\.google\.internal$/i,
  /metadata\.googleusercontent\.com$/i,
];

function isBlockedHost(hostname: string): boolean {
  return BLOCKED_HOST_PATTERNS.some((p) => p.test(hostname));
}

// ── hCaptcha helper ──────────────────────────────────────────────────────────
async function verifyCaptcha(
  secretKey: string,
  token: string,
  ip: string
): Promise<boolean> {
  const params = new URLSearchParams({ secret: secretKey, response: token, remoteip: ip });
  const res = await fetch(HCAPTCHA_VERIFY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const data = (await res.json()) as { success: boolean };
  return data.success === true;
}

// ── Client IP helper ─────────────────────────────────────────────────────────
function getClientIp(req: Request, cf?: IncomingRequestCfProperties): string {
  // Cloudflare always populates CF-Connecting-IP
  const cfIp = req.headers.get("CF-Connecting-IP");
  if (cfIp) return cfIp;
  return req.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ?? "unknown";
}

// ── TTL validation ────────────────────────────────────────────────────────────
const VALID_TTLS = new Set([300, 600, 1800, 3600, 14400, 86400, 604800]);

// ── Hono app ─────────────────────────────────────────────────────────────────
const app = new Hono<{ Bindings: Env }>();

// CORS — allow the configured frontend origin (or any origin when not set)
app.use("/api/*", async (c, next) => {
  const origin = c.env.FRONTEND_URL || "*";
  return cors({
    origin,
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type"],
    maxAge: 86400,
  })(c, next);
});

// ── Health ────────────────────────────────────────────────────────────────────
app.get("/api/health", (c) => {
  return c.json({
    status: "ok",
    captchaEnabled: Boolean(c.env.HCAPTCHA_SECRET_KEY),
    maxShareBytes: MAX_SHARE_BYTES,
    maxInlineBytes: MAX_INLINE_BYTES,
    r2Enabled: Boolean(c.env.R2_ACCESS_KEY_ID && c.env.R2_ACCESS_KEY_SECRET),
  });
});

// ── POST /api/shares — create inline share (≤ MAX_INLINE_BYTES) ──────────────
app.post("/api/shares", async (c) => {
  const ip = getClientIp(c.req.raw);
  const adapter = new CloudflareAdapter(c.env);

  // Rate limit
  const rl = await adapter.checkRateLimit(`create:${ip}`, RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX_CREATES);
  if (!rl.allowed) {
    return c.json(
      { error: "rate_limit_exceeded", message: "We're busy right now. Please wait.", retryAfterSeconds: rl.retryAfterSeconds },
      429
    );
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json", message: "Request body must be valid JSON." }, 400);
  }

  const b = body as Record<string, unknown>;

  // hCaptcha
  if (c.env.HCAPTCHA_SECRET_KEY) {
    const token = b["captchaToken"];
    if (!token || typeof token !== "string") {
      return c.json({ error: "captcha_failed", message: "CAPTCHA validation failed. Please try again." }, 400);
    }
    try {
      const valid = await verifyCaptcha(c.env.HCAPTCHA_SECRET_KEY, token, ip);
      if (!valid) {
        return c.json({ error: "captcha_failed", message: "CAPTCHA validation failed. Please try again." }, 400);
      }
    } catch {
      return c.json({ error: "captcha_error", message: "CAPTCHA validation failed. Please try again." }, 400);
    }
  }

  // Validate required fields
  const encryptedData = b["encryptedData"];
  const ttl = b["ttl"];
  const shareType = b["shareType"];
  const totalSize = b["totalSize"] ?? 0;
  const passwordHash = b["passwordHash"] ?? null;
  const passwordSalt = b["passwordSalt"] ?? null;
  const webhookUrl = b["webhookUrl"] ?? null;
  const webhookMessage = b["webhookMessage"] ?? null;
  const fileMetadata = b["fileMetadata"] ?? null;

  if (!encryptedData || typeof encryptedData !== "string") {
    return c.json({ error: "validation_error", message: "encryptedData is required." }, 400);
  }
  if (!/^[A-Za-z0-9+/=_-]+$/.test(encryptedData)) {
    return c.json({ error: "invalid_data", message: "encryptedData must be valid base64." }, 400);
  }
  if (typeof ttl !== "number" || !VALID_TTLS.has(ttl)) {
    return c.json({ error: "validation_error", message: "Invalid TTL value." }, 400);
  }
  if (shareType !== "text" && shareType !== "files") {
    return c.json({ error: "validation_error", message: "Invalid shareType." }, 400);
  }
  if (typeof totalSize !== "number" || totalSize < 0 || totalSize > MAX_SHARE_BYTES) {
    return c.json({ error: "payload_too_large", message: `Total payload exceeds ${MAX_SHARE_BYTES} byte limit.` }, 413);
  }
  if (encryptedData.length > MAX_INLINE_BYTES * 1.5) {
    return c.json(
      { error: "payload_too_large", message: "Payload too large for inline path. Use the upload-url flow." },
      413
    );
  }
  if (Array.isArray(fileMetadata) && fileMetadata.length > MAX_FILES) {
    return c.json({ error: "too_many_files", message: `Maximum ${MAX_FILES} files per share.` }, 400);
  }

  const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();

  const shareId = await adapter.createShare({
    encryptedData: encryptedData as string,
    shareType: shareType as "text" | "files",
    passwordHash: (passwordHash as string | null),
    passwordSalt: (passwordSalt as string | null),
    webhookUrl: (webhookUrl as string | null),
    webhookMessage: (webhookMessage as string | null),
    fileMetadata: (fileMetadata as null),
    totalSize: totalSize as number,
    ttl,
    captchaRequired: Boolean(c.env.HCAPTCHA_SECRET_KEY),
    expiresAt,
  });

  return c.json({ shareId, expiresAt }, 201);
});

// ── POST /api/shares/upload-url — issue presigned R2 PUT URL ─────────────────
app.post("/api/shares/upload-url", async (c) => {
  const ip = getClientIp(c.req.raw);
  const adapter = new CloudflareAdapter(c.env);

  // Rate limit (same bucket as share creation)
  const rl = await adapter.checkRateLimit(`create:${ip}`, RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX_CREATES);
  if (!rl.allowed) {
    return c.json(
      { error: "rate_limit_exceeded", message: "We're busy right now. Please wait.", retryAfterSeconds: rl.retryAfterSeconds },
      429
    );
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json", message: "Request body must be valid JSON." }, 400);
  }

  const b = body as Record<string, unknown>;

  // hCaptcha
  if (c.env.HCAPTCHA_SECRET_KEY) {
    const token = b["captchaToken"];
    if (!token || typeof token !== "string") {
      return c.json({ error: "captcha_failed", message: "CAPTCHA validation failed. Please try again." }, 400);
    }
    try {
      const valid = await verifyCaptcha(c.env.HCAPTCHA_SECRET_KEY, token, ip);
      if (!valid) {
        return c.json({ error: "captcha_failed", message: "CAPTCHA validation failed. Please try again." }, 400);
      }
    } catch {
      return c.json({ error: "captcha_error", message: "CAPTCHA validation failed. Please try again." }, 400);
    }
  }

  const ttl = b["ttl"];
  const shareType = b["shareType"];
  const totalSize = b["totalSize"] ?? 0;
  const passwordHash = (b["passwordHash"] ?? null) as string | null;
  const passwordSalt = (b["passwordSalt"] ?? null) as string | null;
  const webhookUrl = (b["webhookUrl"] ?? null) as string | null;
  const webhookMessage = (b["webhookMessage"] ?? null) as string | null;
  const fileMetadata = (b["fileMetadata"] ?? null) as null;

  if (typeof ttl !== "number" || !VALID_TTLS.has(ttl)) {
    return c.json({ error: "validation_error", message: "Invalid TTL value." }, 400);
  }
  if (shareType !== "text" && shareType !== "files") {
    return c.json({ error: "validation_error", message: "Invalid shareType." }, 400);
  }
  if (typeof totalSize !== "number" || totalSize < 0 || totalSize > MAX_SHARE_BYTES) {
    return c.json({ error: "payload_too_large", message: `Total payload exceeds ${MAX_SHARE_BYTES} byte limit.` }, 413);
  }

  // Generate a unique share ID and R2 object key
  const pendingShareId = crypto.randomUUID();
  const r2Key = `shares/${pendingShareId}`;
  const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();

  const pending = {
    shareId: pendingShareId,
    r2Key,
    ttl,
    shareType: shareType as "text" | "files",
    passwordHash,
    passwordSalt,
    webhookUrl,
    webhookMessage,
    fileMetadata,
    totalSize: totalSize as number,
    captchaRequired: Boolean(c.env.HCAPTCHA_SECRET_KEY),
    expiresAt,
  };

  const uploadUrl = await adapter.createPendingUpload(pending);

  if (!uploadUrl) {
    return c.json(
      { error: "r2_not_configured", message: "R2 direct-upload is not configured on this deployment." },
      501
    );
  }

  return c.json({ shareId: pendingShareId, uploadUrl, expiresAt }, 200);
});

// ── POST /api/shares/confirm — activate share after direct R2 upload ─────────
app.post("/api/shares/confirm", async (c) => {
  const ip = getClientIp(c.req.raw);
  const adapter = new CloudflareAdapter(c.env);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json", message: "Request body must be valid JSON." }, 400);
  }

  const b = body as Record<string, unknown>;
  const pendingShareId = b["shareId"];
  if (!pendingShareId || typeof pendingShareId !== "string") {
    return c.json({ error: "validation_error", message: "shareId is required." }, 400);
  }

  const realShareId = await adapter.confirmPendingUpload(pendingShareId);
  if (!realShareId) {
    return c.json(
      { error: "not_found", message: "Pending upload not found or R2 object missing. Upload may have failed." },
      404
    );
  }

  // Get the expiresAt from the newly created share
  const result = await adapter.getShare(realShareId);
  const expiresAt = result.found && !result.accessed ? result.share.expiresAt : new Date().toISOString();

  return c.json({ shareId: realShareId, expiresAt }, 201);
});

// ── GET /api/shares/:shareId/peek ─────────────────────────────────────────────
app.get("/api/shares/:shareId/peek", async (c) => {
  const shareId = c.req.param("shareId");
  const ip = getClientIp(c.req.raw);
  const adapter = new CloudflareAdapter(c.env);

  // Rate limit peeks
  const rl = await adapter.checkRateLimit(`peek:${ip}`, RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX_PEEKS);
  if (!rl.allowed) {
    c.header("Retry-After", String(rl.retryAfterSeconds));
    return c.json(
      { error: "rate_limit_exceeded", message: "Too many requests. Please wait before trying again.", retryAfterSeconds: rl.retryAfterSeconds },
      429
    );
  }

  // hCaptcha
  if (c.env.HCAPTCHA_SECRET_KEY) {
    const token = c.req.query("captchaToken");
    if (!token) {
      return c.json({ error: "captcha_failed", message: "CAPTCHA validation failed. Please try again." }, 400);
    }
    try {
      const valid = await verifyCaptcha(c.env.HCAPTCHA_SECRET_KEY, token, ip);
      if (!valid) {
        return c.json({ error: "captcha_failed", message: "CAPTCHA validation failed. Please try again." }, 400);
      }
    } catch {
      return c.json({ error: "captcha_error", message: "CAPTCHA validation failed. Please try again." }, 400);
    }
  }

  const result = await adapter.getShare(shareId);

  if (!result.found) {
    return c.json({ error: "not_found", message: "Share not found or expired", humorousMessage: randomHumorous() }, 404);
  }
  if (result.accessed) {
    return c.json({ error: "already_accessed", message: "Share already accessed", humorousMessage: "There is no cake" }, 410);
  }

  const { share } = result;

  // Check wall-clock expiry (belt-and-suspenders alongside KV TTL)
  if (Date.now() > new Date(share.expiresAt).getTime()) {
    await adapter.deleteShare(shareId);
    return c.json({ error: "expired", message: "Share has expired", humorousMessage: "No droids here" }, 410);
  }

  // Issue access nonce when captcha is enabled
  let accessNonce: string | undefined;
  if (c.env.HCAPTCHA_SECRET_KEY) {
    accessNonce = await adapter.issueNonce(shareId, ip);
  }

  return c.json({
    totalSize: share.totalSize,
    passwordRequired: share.passwordHash !== null,
    shareType: share.shareType,
    fileCount: share.fileMetadata?.length ?? 0,
    expiresAt: share.expiresAt,
    ...(accessNonce !== undefined ? { accessNonce } : {}),
  });
});

// ── GET /api/shares/:shareId — access and consume share ──────────────────────
app.get("/api/shares/:shareId", async (c) => {
  const shareId = c.req.param("shareId");
  const ip = getClientIp(c.req.raw);
  const adapter = new CloudflareAdapter(c.env);

  // Validate nonce when captcha is enabled
  if (c.env.HCAPTCHA_SECRET_KEY) {
    const nonce = c.req.query("accessNonce");
    if (!nonce) {
      return c.json({ error: "invalid_nonce", message: "Access denied. Please return to the share link and try again." }, 403);
    }
    const valid = await adapter.validateNonce(nonce, shareId);
    if (!valid) {
      return c.json({ error: "invalid_nonce", message: "Access denied. Please return to the share link and try again." }, 403);
    }
  }

  const result = await adapter.accessShare(shareId);

  if (!result.ok) {
    if (result.reason === "not_found") {
      return c.json({ error: "not_found", message: "Share not found or expired", humorousMessage: randomHumorous() }, 404);
    }
    if (result.reason === "already_accessed") {
      return c.json({ error: "already_accessed", message: "Share has already been accessed", humorousMessage: "There is no cake" }, 410);
    }
    if (result.reason === "expired") {
      return c.json({ error: "expired", message: "Share has expired", humorousMessage: "No droids here" }, 410);
    }
  }

  const { share } = result as { ok: true; share: import("./adapters/types.js").ShareMeta };

  // Fire webhook asynchronously (fire-and-forget)
  if (share.webhookUrl) {
    c.executionCtx.waitUntil(
      fetch(share.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: share.webhookMessage ?? "your submission has been downloaded",
          timestamp: new Date().toISOString(),
        }),
      }).catch(() => {})
    );
  }

  // Clean up R2 blob after serving (fire-and-forget)
  if (share.r2Key) {
    c.executionCtx.waitUntil(
      c.env.SHARE_R2.delete(share.r2Key).catch(() => {})
    );
  }

  return c.json({
    encryptedData: share.encryptedData,
    fileMetadata: share.fileMetadata,
    passwordRequired: share.passwordHash !== null,
    passwordSalt: share.passwordSalt,
    shareType: share.shareType,
    totalSize: share.totalSize,
    webhookUrl: share.webhookUrl,
    webhookMessage: share.webhookMessage,
  });
});

// ── DELETE /api/shares/:shareId ───────────────────────────────────────────────
app.delete("/api/shares/:shareId", async (c) => {
  const shareId = c.req.param("shareId");
  const adapter = new CloudflareAdapter(c.env);

  const result = await adapter.getShare(shareId);
  if (!result.found) {
    return c.json({ error: "not_found", message: "Share not found" }, 404);
  }

  await adapter.deleteShare(shareId);
  return c.json({ success: true, message: "Share deleted successfully" });
});

// ── POST /api/webhook/test ─────────────────────────────────────────────────────
app.post("/api/webhook/test", async (c) => {
  const ip = getClientIp(c.req.raw);
  const adapter = new CloudflareAdapter(c.env);

  const rl = await adapter.checkRateLimit(`webhook:${ip}`, RATE_LIMIT_WINDOW_MS, 3);
  if (!rl.allowed) {
    return c.json(
      { error: "rate_limit_exceeded", message: "Too many webhook test requests. Please wait.", retryAfterSeconds: rl.retryAfterSeconds },
      429
    );
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json", message: "Request body must be valid JSON." }, 400);
  }

  const b = body as Record<string, unknown>;
  const webhookUrl = b["webhookUrl"];

  if (!webhookUrl || typeof webhookUrl !== "string") {
    return c.json({ error: "validation_error", message: "Invalid request body." }, 400);
  }

  let url: URL;
  try {
    url = new URL(webhookUrl);
  } catch {
    return c.json({ error: "invalid_url", message: "Invalid webhook URL format." }, 400);
  }

  if (url.protocol !== "https:") {
    return c.json({ error: "invalid_url", message: "Webhook URL must use HTTPS." }, 400);
  }

  if (isBlockedHost(url.hostname)) {
    return c.json({ error: "invalid_url", message: "Webhook URL must point to a public host." }, 400);
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "VaultDrop webhook test", timestamp: new Date().toISOString() }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    return c.json({ success: true, statusCode: response.status, message: `Webhook responded with status ${response.status}` });
  } catch (err) {
    return c.json({
      success: false,
      statusCode: null,
      message: err instanceof Error ? err.message : "Webhook test failed",
    });
  }
});

// ── 404 catch-all ─────────────────────────────────────────────────────────────
app.notFound((c) => c.json({ error: "not_found", message: "Endpoint not found." }, 404));

// ── Export ────────────────────────────────────────────────────────────────────
export default app;
