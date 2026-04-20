import crypto from "crypto";
import { Router, type IRouter, type Request, type Response } from "express";
import {
  createShare,
  getShare,
  markAccessed,
  deleteShare,
  fireWebhook,
  getAvailableMemoryMb,
} from "../services/shareManager.js";
import { checkRateLimit } from "../services/rateLimiter.js";
import {
  CreateShareBody,
  GetShareParams,
  DeleteShareParams,
  PeekShareParams,
  TestWebhookBody,
} from "@workspace/api-zod";

const router: IRouter = Router();

const HCAPTCHA_SECRET = process.env.HCAPTCHA_SECRET_KEY ?? "";
const HCAPTCHA_VERIFY_URL = "https://api.hcaptcha.com/siteverify";

// ── Access nonce (stateless HMAC-SHA256 token issued at peek, verified at access) ──
const NONCE_SECRET = process.env["SESSION_SECRET"] ?? "dev-nonce-secret";
const NONCE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function generateAccessNonce(shareId: string, ip: string): string {
  const ts = Date.now().toString();
  const payload = `${shareId}:${ip}:${ts}`;
  const sig = crypto.createHmac("sha256", NONCE_SECRET).update(payload).digest("base64url");
  return `${sig}.${ts}`;
}

function validateAccessNonce(nonce: string, shareId: string, ip: string): boolean {
  const dot = nonce.lastIndexOf(".");
  if (dot === -1) return false;
  const sig = nonce.slice(0, dot);
  const ts = nonce.slice(dot + 1);
  const tsNum = parseInt(ts, 10);
  if (isNaN(tsNum) || Date.now() - tsNum > NONCE_TTL_MS) return false;
  const payload = `${shareId}:${ip}:${ts}`;
  const expected = crypto.createHmac("sha256", NONCE_SECRET).update(payload).digest("base64url");
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expected);
  if (sigBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(sigBuf, expectedBuf);
}

async function verifyCaptcha(token: string, ip: string): Promise<boolean> {
  const params = new URLSearchParams({
    secret: HCAPTCHA_SECRET,
    response: token,
    remoteip: ip,
  });
  const res = await fetch(HCAPTCHA_VERIFY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const data = (await res.json()) as { success: boolean };
  return data.success === true;
}

const MAX_SHARE_SIZE_BYTES = 2.5 * 1024 * 1024; // 2.5 MB
const MIN_MEMORY_MB = 10; // Require at least 10 MB free

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
  return HUMOROUS_ERRORS[Math.floor(Math.random() * HUMOROUS_ERRORS.length)];
}

function getClientIp(req: Request): string {
  if (process.env["TRUST_PROXY"] === "true") {
    const forwarded = req.headers["x-forwarded-for"];
    if (typeof forwarded === "string") {
      const ips = forwarded.split(",").map((s) => s.trim());
      return ips[ips.length - 1] || req.socket?.remoteAddress || "unknown";
    }
  }
  return req.socket?.remoteAddress ?? "unknown";
}

// POST /api/shares — create a share
router.post("/shares", async (req: Request, res: Response) => {
  const ip = getClientIp(req);
  const rateLimit = checkRateLimit(ip);
  if (!rateLimit.allowed) {
    res.status(429).json({
      error: "rate_limit_exceeded",
      message: "We're busy right now. Please wait.",
      retryAfterSeconds: rateLimit.retryAfterSeconds,
    });
    return;
  }

  // hCaptcha verification (skipped when HCAPTCHA_SECRET_KEY is not configured)
  if (HCAPTCHA_SECRET) {
    const token = (req.body as Record<string, unknown>)?.captchaToken;
    if (!token || typeof token !== "string") {
      res.status(400).json({
        error: "captcha_failed",
        message: "CAPTCHA validation failed. Please try again.",
      });
      return;
    }
    try {
      const valid = await verifyCaptcha(token, ip);
      if (!valid) {
        res.status(400).json({
          error: "captcha_failed",
          message: "CAPTCHA validation failed. Please try again.",
        });
        return;
      }
    } catch {
      res.status(400).json({
        error: "captcha_error",
        message: "CAPTCHA validation failed. Please try again.",
      });
      return;
    }
  }

  const parsed = CreateShareBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "validation_error",
      message: parsed.error.issues
        .map((issue: { message: string }) => issue.message)
        .join(", "),
    });
    return;
  }

  const body = parsed.data;

  if (body.totalSize > MAX_SHARE_SIZE_BYTES) {
    res.status(413).json({
      error: "payload_too_large",
      message: "Total payload exceeds 2.5 MB limit",
    });
    return;
  }

  if (body.fileMetadata && body.fileMetadata.length > 10) {
    res.status(400).json({
      error: "too_many_files",
      message: "Maximum 10 files per share",
    });
    return;
  }

  const availableMb = getAvailableMemoryMb();
  if (availableMb < MIN_MEMORY_MB) {
    res.status(507).json({
      error: "insufficient_memory",
      message: "Platform is busy. Please try again later.",
    });
    return;
  }

  if (!/^[A-Za-z0-9+/=_-]+$/.test(body.encryptedData)) {
    res.status(400).json({
      error: "invalid_data",
      message: "encryptedData must be valid base64",
    });
    return;
  }

  const share = createShare({
    encryptedData: body.encryptedData,
    ttl: body.ttl,
    passwordHash: body.passwordHash,
    passwordSalt: body.passwordSalt,
    webhookUrl: body.webhookUrl,
    webhookMessage: body.webhookMessage,
    fileMetadata: body.fileMetadata as typeof body.fileMetadata,
    shareType: body.shareType,
    totalSize: body.totalSize,
  });

  res.status(201).json({
    shareId: share.id,
    expiresAt: new Date(share.expiresAt).toISOString(),
  });
});

// GET /api/shares/:shareId/peek — peek without consuming
router.get("/shares/:shareId/peek", async (req: Request, res: Response) => {
  const shareId = req.params["shareId"] as string;
  const ip = getClientIp(req);

  // hCaptcha verification (skipped when HCAPTCHA_SECRET_KEY is not configured)
  if (HCAPTCHA_SECRET) {
    const token = req.query["captchaToken"];
    if (!token || typeof token !== "string") {
      res.status(400).json({
        error: "captcha_failed",
        message: "CAPTCHA validation failed. Please try again.",
      });
      return;
    }
    try {
      const valid = await verifyCaptcha(token, ip);
      if (!valid) {
        res.status(400).json({
          error: "captcha_failed",
          message: "CAPTCHA validation failed. Please try again.",
        });
        return;
      }
    } catch {
      res.status(400).json({
        error: "captcha_error",
        message: "CAPTCHA validation failed. Please try again.",
      });
      return;
    }
  }

  const share = getShare(shareId);

  if (!share) {
    res.status(404).json({
      error: "not_found",
      message: "Share not found or expired",
      humorousMessage: randomHumorous(),
    });
    return;
  }

  const now = Date.now();
  if (now > share.expiresAt) {
    deleteShare(shareId);
    res.status(410).json({
      error: "expired",
      message: "Share has expired",
      humorousMessage: "No droids here",
    });
    return;
  }

  if (share.accessed) {
    res.status(410).json({
      error: "already_accessed",
      message: "Share already accessed",
      humorousMessage: "There is no cake",
    });
    return;
  }

  // Issue a short-lived HMAC nonce so the access endpoint can verify the
  // visitor passed through the captcha gate without requiring a second solve.
  const accessNonce = HCAPTCHA_SECRET ? generateAccessNonce(shareId, ip) : undefined;

  res.json({
    totalSize: share.totalSize,
    passwordRequired: share.passwordHash !== null,
    shareType: share.shareType,
    fileCount: share.fileMetadata?.length ?? 0,
    expiresAt: new Date(share.expiresAt).toISOString(),
    ...(accessNonce !== undefined ? { accessNonce } : {}),
  });
});

// GET /api/shares/:shareId — retrieve and mark accessed
router.get("/shares/:shareId", async (req: Request, res: Response) => {
  const shareId = req.params["shareId"] as string;
  const ip = getClientIp(req);

  // Verify the nonce issued at peek time (skipped in dev mode without hCaptcha key)
  if (HCAPTCHA_SECRET) {
    const nonce = req.query["accessNonce"];
    if (!nonce || typeof nonce !== "string" || !validateAccessNonce(nonce, shareId, ip)) {
      res.status(403).json({
        error: "invalid_nonce",
        message: "Access denied. Please return to the share link and try again.",
      });
      return;
    }
  }

  const share = getShare(shareId);

  if (!share) {
    res.status(404).json({
      error: "not_found",
      message: "Share not found or expired",
      humorousMessage: randomHumorous(),
    });
    return;
  }

  const now = Date.now();
  if (now > share.expiresAt) {
    deleteShare(shareId);
    res.status(410).json({
      error: "expired",
      message: "Share has expired",
      humorousMessage: "No droids here",
    });
    return;
  }

  if (share.accessed) {
    res.status(410).json({
      error: "already_accessed",
      message: "Share has already been accessed",
      humorousMessage: "There is no cake",
    });
    return;
  }

  markAccessed(shareId);

  res.json({
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

// DELETE /api/shares/:shareId — delete after download complete
router.delete("/shares/:shareId", async (req: Request, res: Response) => {
  const shareId = req.params["shareId"] as string;

  const share = getShare(shareId);

  if (!share) {
    res.status(404).json({
      error: "not_found",
      message: "Share not found",
    });
    return;
  }

  // Fire webhook if configured
  if (share.webhookUrl) {
    fireWebhook(share.webhookUrl, share.webhookMessage ?? undefined).catch(
      () => {}
    );
  }

  deleteShare(shareId);

  res.json({
    success: true,
    message: "Share deleted successfully",
  });
});

// Block RFC-1918, loopback, link-local, and cloud-metadata hostnames (SSRF guard)
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

// POST /api/webhook/test
router.post("/webhook/test", async (req: Request, res: Response) => {
  // Rate-limit webhook test by IP (3 attempts per minute, shared bucket with share creation)
  const ip = getClientIp(req);
  const rateLimit = checkRateLimit(`webhook:${ip}`);
  if (!rateLimit.allowed) {
    res.status(429).json({
      error: "rate_limit_exceeded",
      message: "Too many webhook test requests. Please wait.",
      retryAfterSeconds: rateLimit.retryAfterSeconds,
    });
    return;
  }

  const parsed = TestWebhookBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "validation_error",
      message: "Invalid request body",
    });
    return;
  }

  const { webhookUrl } = parsed.data;

  // Validate URL
  let url: URL;
  try {
    url = new URL(webhookUrl);
  } catch {
    res.status(400).json({
      error: "invalid_url",
      message: "Invalid webhook URL format",
    });
    return;
  }

  if (url.protocol !== "https:") {
    res.status(400).json({
      error: "invalid_url",
      message: "Webhook URL must use HTTPS",
    });
    return;
  }

  // SSRF protection: block internal/private hosts
  if (isBlockedHost(url.hostname)) {
    res.status(400).json({
      error: "invalid_url",
      message: "Webhook URL must point to a public host",
    });
    return;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "VaultDrop webhook test",
        timestamp: new Date().toISOString(),
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    res.json({
      success: true,
      statusCode: response.status,
      message: `Webhook responded with status ${response.status}`,
    });
  } catch (err) {
    res.status(200).json({
      success: false,
      statusCode: null,
      message:
        err instanceof Error ? err.message : "Webhook test failed",
    });
  }
});

export default router;
