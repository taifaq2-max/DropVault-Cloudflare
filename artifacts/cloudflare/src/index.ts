/**
 * VaultDrop Cloudflare Worker — Hono entry point.
 *
 * This file handles HTTP plumbing (CORS, captcha, rate limiting, response
 * serialisation). All business logic lives in framework-agnostic handler
 * functions under src/handlers/ that accept a StorageAdapter and return typed
 * result objects.
 *
 * New endpoints over the Express dev server:
 *   POST /api/shares/upload-url  — issue a presigned R2 PUT URL (420 MB path)
 *   POST /api/shares/confirm     — activate a share after direct R2 upload
 *
 * Storage: KV (metadata) + R2 (encrypted blobs) + Durable Objects (atomicity).
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./types/env.js";
import { CloudflareAdapter } from "./adapters/cloudflare.js";
import { ShareAccessGate } from "./durableObjects/ShareAccessGate.js";
import { NonceStore } from "./durableObjects/NonceStore.js";
import { RateLimiter } from "./durableObjects/RateLimiter.js";
import {
  handleCreateShare,
  handleUploadUrl,
  handleConfirmUpload,
  handlePeekShare,
  handleAccessShare,
  handleDeleteShare,
  MAX_SHARE_BYTES,
  MAX_FILES,
} from "./handlers/shares.js";
import { handleTestWebhook, fireWebhook } from "./handlers/webhook.js";
import { handleHealth } from "./handlers/health.js";

// ── Re-export Durable Object classes (required by wrangler) ──────────────────
export { ShareAccessGate, NonceStore, RateLimiter };

// ── Constants ────────────────────────────────────────────────────────────────
const HCAPTCHA_VERIFY_URL = "https://api.hcaptcha.com/siteverify";
const RATE_LIMIT_WINDOW_MS = 60_000;
// Match Express dev-server defaults: 3 creates/min, 10 peeks/min.
const RATE_LIMIT_MAX_CREATES = 3;
const RATE_LIMIT_MAX_PEEKS = 10;
const MAX_INLINE_BYTES = 4 * 1024 * 1024;

// ── Helpers ───────────────────────────────────────────────────────────────────

function getClientIp(req: Request): string {
  const cfIp = req.headers.get("CF-Connecting-IP");
  if (cfIp) return cfIp;
  return req.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ?? "unknown";
}

async function verifyCaptcha(secretKey: string, token: string, ip: string): Promise<boolean> {
  const params = new URLSearchParams({ secret: secretKey, response: token, remoteip: ip });
  const res = await fetch(HCAPTCHA_VERIFY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const data = (await res.json()) as { success: boolean };
  return data.success === true;
}

/**
 * Parse JSON body from a Hono context. Returns null on parse error.
 */
async function parseBody(c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown> | null> {
  try {
    return (await c.req.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Gate: check captcha (if enabled) and rate limit. Returns an error response
 * or null if the request is allowed.
 */
async function gateCaptchaAndRateLimit(
  c: Parameters<typeof cors>[0] extends never ? never : import("hono").Context<{ Bindings: Env }>,
  adapter: CloudflareAdapter,
  ip: string,
  rateLimitKey: string,
  maxHits: number,
  captchaToken?: string
): Promise<Response | null> {
  const rl = await adapter.checkRateLimit(rateLimitKey, RATE_LIMIT_WINDOW_MS, maxHits);
  if (!rl.allowed) {
    return c.json(
      {
        error: "rate_limit_exceeded",
        message: "We're busy right now. Please wait.",
        retryAfterSeconds: rl.retryAfterSeconds,
      },
      429
    );
  }

  if (c.env.HCAPTCHA_SECRET_KEY) {
    if (!captchaToken) {
      return c.json(
        { error: "captcha_failed", message: "CAPTCHA validation failed. Please try again." },
        400
      );
    }
    let captchaOk = false;
    try {
      captchaOk = await verifyCaptcha(c.env.HCAPTCHA_SECRET_KEY, captchaToken, ip);
    } catch {
      captchaOk = false;
    }
    if (!captchaOk) {
      return c.json(
        { error: "captcha_failed", message: "CAPTCHA validation failed. Please try again." },
        400
      );
    }
  }

  return null;
}

// ── Hono app ─────────────────────────────────────────────────────────────────
const app = new Hono<{ Bindings: Env }>();

// CORS — allow the configured frontend origin (or * when not set, dev-only).
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
  const result = handleHealth({
    captchaEnabled: Boolean(c.env.HCAPTCHA_SECRET_KEY),
    r2Enabled: Boolean(c.env.R2_ACCESS_KEY_ID && c.env.R2_ACCESS_KEY_SECRET),
    maxShareBytes: MAX_SHARE_BYTES,
    maxInlineBytes: MAX_INLINE_BYTES,
  });
  if (!result.ok) return c.json({ error: result.error, message: result.message }, result.status as 500);
  return c.json(result.data, result.status as 200);
});

// ── POST /api/shares — inline share creation (≤ 4 MB) ───────────────────────
app.post("/api/shares", async (c) => {
  const ip = getClientIp(c.req.raw);
  const adapter = new CloudflareAdapter(c.env);
  const body = await parseBody(c);
  if (!body) return c.json({ error: "invalid_json", message: "Request body must be valid JSON." }, 400);

  const gate = await gateCaptchaAndRateLimit(
    c, adapter, ip, `create:${ip}`, RATE_LIMIT_MAX_CREATES,
    body["captchaToken"] as string | undefined
  );
  if (gate) return gate;

  const result = await handleCreateShare(
    {
      encryptedData: (body["encryptedData"] as string) ?? "",
      ttl: (body["ttl"] as number) ?? 0,
      shareType: body["shareType"] as "text" | "files",
      totalSize: (body["totalSize"] as number) ?? 0,
      passwordHash: (body["passwordHash"] as string | null) ?? null,
      passwordSalt: (body["passwordSalt"] as string | null) ?? null,
      webhookUrl: (body["webhookUrl"] as string | null) ?? null,
      webhookMessage: (body["webhookMessage"] as string | null) ?? null,
      fileMetadata: Array.isArray(body["fileMetadata"]) ? (body["fileMetadata"] as import("./adapters/types.js").FileMetaItem[]) : null,
      captchaRequired: Boolean(c.env.HCAPTCHA_SECRET_KEY),
    },
    adapter
  );

  if (!result.ok) return c.json({ error: result.error, message: result.message, ...result.extra }, result.status as 400 | 413);
  return c.json(result.data, result.status as 201);
});

// ── POST /api/shares/upload-url — presigned R2 PUT URL ───────────────────────
app.post("/api/shares/upload-url", async (c) => {
  const ip = getClientIp(c.req.raw);
  const adapter = new CloudflareAdapter(c.env);
  const body = await parseBody(c);
  if (!body) return c.json({ error: "invalid_json", message: "Request body must be valid JSON." }, 400);

  const gate = await gateCaptchaAndRateLimit(
    c, adapter, ip, `create:${ip}`, RATE_LIMIT_MAX_CREATES,
    body["captchaToken"] as string | undefined
  );
  if (gate) return gate;

  const result = await handleUploadUrl(
    {
      ttl: (body["ttl"] as number) ?? 0,
      shareType: body["shareType"] as "text" | "files",
      totalSize: (body["totalSize"] as number) ?? 0,
      passwordHash: (body["passwordHash"] as string | null) ?? null,
      passwordSalt: (body["passwordSalt"] as string | null) ?? null,
      webhookUrl: (body["webhookUrl"] as string | null) ?? null,
      webhookMessage: (body["webhookMessage"] as string | null) ?? null,
      fileMetadata: Array.isArray(body["fileMetadata"]) ? (body["fileMetadata"] as import("./adapters/types.js").FileMetaItem[]) : null,
      captchaRequired: Boolean(c.env.HCAPTCHA_SECRET_KEY),
    },
    adapter
  );

  if (!result.ok) return c.json({ error: result.error, message: result.message }, result.status as 400 | 413 | 501);
  return c.json(result.data, result.status as 200);
});

// ── POST /api/shares/confirm — activate share after R2 upload ────────────────
app.post("/api/shares/confirm", async (c) => {
  const adapter = new CloudflareAdapter(c.env);
  const body = await parseBody(c);
  if (!body) return c.json({ error: "invalid_json", message: "Request body must be valid JSON." }, 400);

  const pendingShareId = body["shareId"];
  if (!pendingShareId || typeof pendingShareId !== "string") {
    return c.json({ error: "validation_error", message: "shareId is required." }, 400);
  }

  const result = await handleConfirmUpload(pendingShareId, adapter);
  if (!result.ok) return c.json({ error: result.error, message: result.message }, result.status as 404);
  return c.json(result.data, result.status as 201);
});

// ── GET /api/shares/:shareId/peek ─────────────────────────────────────────────
app.get("/api/shares/:shareId/peek", async (c) => {
  const shareId = c.req.param("shareId");
  const ip = getClientIp(c.req.raw);
  const adapter = new CloudflareAdapter(c.env);

  const rlGate = await adapter.checkRateLimit(`peek:${ip}`, RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX_PEEKS);
  if (!rlGate.allowed) {
    c.header("Retry-After", String(rlGate.retryAfterSeconds));
    return c.json(
      { error: "rate_limit_exceeded", message: "Too many requests. Please wait.", retryAfterSeconds: rlGate.retryAfterSeconds },
      429
    );
  }

  if (c.env.HCAPTCHA_SECRET_KEY) {
    const token = c.req.query("captchaToken");
    if (!token) return c.json({ error: "captcha_failed", message: "CAPTCHA validation failed. Please try again." }, 400);
    let ok = false;
    try { ok = await verifyCaptcha(c.env.HCAPTCHA_SECRET_KEY, token, ip); } catch { ok = false; }
    if (!ok) return c.json({ error: "captcha_failed", message: "CAPTCHA validation failed. Please try again." }, 400);
  }

  const result = await handlePeekShare(shareId, ip, Boolean(c.env.HCAPTCHA_SECRET_KEY), adapter);

  if (!result.ok) return c.json({ error: result.error, message: result.message, ...result.extra }, result.status as 404 | 410);
  return c.json(result.data, result.status as 200);
});

// ── GET /api/shares/:shareId — access and consume ────────────────────────────
app.get("/api/shares/:shareId", async (c) => {
  const shareId = c.req.param("shareId");
  const ip = getClientIp(c.req.raw);
  const adapter = new CloudflareAdapter(c.env);
  const nonce = c.req.query("accessNonce");

  const result = await handleAccessShare(shareId, ip, nonce, Boolean(c.env.HCAPTCHA_SECRET_KEY), adapter);

  if (!result.ok) return c.json({ error: result.error, message: result.message, ...result.extra }, result.status as 403 | 404 | 410);
  return c.json(result.data, result.status as 200);
});

// ── DELETE /api/shares/:shareId — delete (fires webhook = "download complete") ─
app.delete("/api/shares/:shareId", async (c) => {
  const shareId = c.req.param("shareId");
  const adapter = new CloudflareAdapter(c.env);

  const result = await handleDeleteShare(shareId, adapter, async (url, message) => {
    // Use waitUntil so the webhook doesn't block the response.
    c.executionCtx.waitUntil(fireWebhook(url, message));
  });

  if (!result.ok) return c.json({ error: result.error, message: result.message }, result.status as 404);
  return c.json(result.data, result.status as 200);
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

  const body = await parseBody(c);
  if (!body) return c.json({ error: "invalid_json", message: "Request body must be valid JSON." }, 400);

  const result = await handleTestWebhook(body["webhookUrl"], adapter);
  if (!result.ok) return c.json({ error: result.error, message: result.message }, result.status as 400);
  return c.json(result.data, result.status as 200);
});

// ── 404 catch-all ─────────────────────────────────────────────────────────────
app.notFound((c) => c.json({ error: "not_found", message: "Endpoint not found." }, 404));

// ── Export ────────────────────────────────────────────────────────────────────
export default app;
