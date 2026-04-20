/**
 * CloudflareAdapter — StorageAdapter backed by KV + R2 + Durable Objects.
 *
 * Share metadata is stored in KV (fast, globally replicated). Encrypted blobs
 * are stored in R2 (object storage). The adapter NEVER loads R2 blobs into
 * Worker memory — it generates presigned GET URLs for the browser to download
 * directly from R2, keeping large payloads out of the Worker entirely.
 *
 * Atomic access-once semantics are enforced by the ShareAccessGate DO.
 * Nonce issuance uses HMAC-SHA256 (stateless, bound to shareId + IP + ts).
 * Nonce revocation (single-use guarantee) goes through the NonceStore DO.
 * Rate limiting is handled by the RateLimiter DO.
 */

import type { Env } from "../types/env.js";
import { createR2PresignedPutUrl, createR2PresignedGetUrl } from "./r2sign.js";
import type {
  StorageAdapter,
  ShareMeta,
  CreateShareParams,
  GetShareResult,
  AccessShareResult,
  PendingUpload,
  RateLimitResult,
} from "./types.js";

const NONCE_TTL_MS = 5 * 60 * 1000;
const KV_PENDING_PREFIX = "pending:";
const KV_SHARE_PREFIX = "share:";

export class CloudflareAdapter implements StorageAdapter {
  private readonly env: Env;

  constructor(env: Env) {
    this.env = env;
  }

  // ── Key helpers ─────────────────────────────────────────────────────────
  private shareKey(shareId: string) { return `${KV_SHARE_PREFIX}${shareId}`; }
  private pendingKey(shareId: string) { return `${KV_PENDING_PREFIX}${shareId}`; }

  // ── DO stubs ─────────────────────────────────────────────────────────────
  private accessGateStub(shareId: string): DurableObjectStub {
    return this.env.SHARE_ACCESS_GATE.get(this.env.SHARE_ACCESS_GATE.idFromName(shareId));
  }
  private nonceStoreStub(): DurableObjectStub {
    return this.env.NONCE_STORE.get(this.env.NONCE_STORE.idFromName("global"));
  }
  private rateLimiterStub(): DurableObjectStub {
    return this.env.RATE_LIMITER.get(this.env.RATE_LIMITER.idFromName("global"));
  }

  // ── StorageAdapter implementation ─────────────────────────────────────────

  async createShare(params: CreateShareParams): Promise<string> {
    const shareId = crypto.randomUUID();
    const now = new Date().toISOString();
    const meta: ShareMeta = {
      id: shareId,
      encryptedData: params.encryptedData ?? null,
      r2Key: params.r2Key ?? null,
      shareType: params.shareType,
      passwordHash: params.passwordHash,
      passwordSalt: params.passwordSalt,
      webhookUrl: params.webhookUrl,
      webhookMessage: params.webhookMessage,
      fileMetadata: params.fileMetadata,
      totalSize: params.totalSize,
      ttl: params.ttl,
      captchaRequired: params.captchaRequired,
      expiresAt: params.expiresAt,
      createdAt: now,
      accessed: false,
      accessedAt: null,
    };

    const expiresInSeconds = Math.max(
      Math.ceil((new Date(params.expiresAt).getTime() - Date.now()) / 1000),
      60
    );

    await this.env.SHARE_KV.put(this.shareKey(shareId), JSON.stringify(meta), {
      expirationTtl: expiresInSeconds,
    });

    return shareId;
  }

  async getShare(shareId: string): Promise<GetShareResult> {
    const raw = await this.env.SHARE_KV.get(this.shareKey(shareId));
    if (!raw) return { found: false };

    const meta = JSON.parse(raw) as ShareMeta;

    if (Date.now() > new Date(meta.expiresAt).getTime()) {
      await this.env.SHARE_KV.delete(this.shareKey(shareId));
      if (meta.r2Key) await this.env.SHARE_R2.delete(meta.r2Key).catch(() => {});
      return { found: false };
    }

    if (!meta.accessed) {
      // Consult access gate DO for authoritative state (DO is the source of truth
      // for first-access atomicity; KV may lag after a Worker restart).
      const resp = await this.accessGateStub(shareId).fetch(new Request("https://do/check"));
      const { accessed: doAccessed, accessedAt } = (await resp.json()) as {
        accessed: boolean;
        accessedAt: string | null;
      };

      if (doAccessed) {
        meta.accessed = true;
        meta.accessedAt = accessedAt;
        // Write back so future reads skip the DO call.
        await this.env.SHARE_KV.put(this.shareKey(shareId), JSON.stringify(meta), {
          expirationTtl: 60,
        });
      }
    }

    // Always return the full share metadata so DELETE handlers can access
    // webhookUrl/webhookMessage regardless of access state.
    return { found: true, accessed: meta.accessed, share: meta };
  }

  async accessShare(shareId: string): Promise<AccessShareResult> {
    const raw = await this.env.SHARE_KV.get(this.shareKey(shareId));
    if (!raw) return { ok: false, reason: "not_found" };

    const meta = JSON.parse(raw) as ShareMeta;

    if (Date.now() > new Date(meta.expiresAt).getTime()) {
      await this.env.SHARE_KV.delete(this.shareKey(shareId));
      if (meta.r2Key) await this.env.SHARE_R2.delete(meta.r2Key).catch(() => {});
      return { ok: false, reason: "expired" };
    }

    // Atomically mark-and-check via the access gate DO.
    const resp = await this.accessGateStub(shareId).fetch(
      new Request("https://do/mark", { method: "POST" })
    );
    if (resp.status === 409) return { ok: false, reason: "already_accessed" };

    // For R2-backed shares: generate a presigned GET URL for the browser to
    // fetch the ciphertext directly. Never load the blob into Worker memory.
    if (meta.r2Key && !meta.encryptedData) {
      if (
        this.env.R2_ACCESS_KEY_ID &&
        this.env.R2_ACCESS_KEY_SECRET &&
        this.env.CLOUDFLARE_ACCOUNT_ID
      ) {
        meta.dataUrl = await createR2PresignedGetUrl({
          accountId: this.env.CLOUDFLARE_ACCOUNT_ID,
          accessKeyId: this.env.R2_ACCESS_KEY_ID,
          secretAccessKey: this.env.R2_ACCESS_KEY_SECRET,
          bucket: this.env.R2_BUCKET_NAME,
          key: meta.r2Key,
          expiresIn: 900,
        }).catch(() => null);
      }
    }

    return { ok: true, share: meta };
  }

  async deleteShare(shareId: string): Promise<void> {
    const raw = await this.env.SHARE_KV.get(this.shareKey(shareId));
    if (raw) {
      const meta = JSON.parse(raw) as ShareMeta;
      if (meta.r2Key) {
        await this.env.SHARE_R2.delete(meta.r2Key).catch(() => {});
      }
    }
    await this.env.SHARE_KV.delete(this.shareKey(shareId));
  }

  async checkRateLimit(key: string, windowMs: number, maxHits: number): Promise<RateLimitResult> {
    const resp = await this.rateLimiterStub().fetch(
      new Request("https://do/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, windowMs, maxHits }),
      })
    );
    return resp.json() as Promise<RateLimitResult>;
  }

  async createPendingUpload(params: PendingUpload): Promise<string | null> {
    await this.env.SHARE_KV.put(
      this.pendingKey(params.shareId),
      JSON.stringify(params),
      { expirationTtl: 1200 } // 20 minutes
    );

    if (
      this.env.R2_ACCESS_KEY_ID &&
      this.env.R2_ACCESS_KEY_SECRET &&
      this.env.CLOUDFLARE_ACCOUNT_ID
    ) {
      return createR2PresignedPutUrl({
        accountId: this.env.CLOUDFLARE_ACCOUNT_ID,
        accessKeyId: this.env.R2_ACCESS_KEY_ID,
        secretAccessKey: this.env.R2_ACCESS_KEY_SECRET,
        bucket: this.env.R2_BUCKET_NAME,
        key: params.r2Key,
        expiresIn: 900,
      }).catch(() => null);
    }

    return null;
  }

  async confirmPendingUpload(shareId: string): Promise<string | null> {
    const raw = await this.env.SHARE_KV.get(this.pendingKey(shareId));
    if (!raw) return null;

    const pending = JSON.parse(raw) as PendingUpload;
    await this.env.SHARE_KV.delete(this.pendingKey(shareId));

    // Verify the R2 object actually exists (confirms the upload succeeded).
    const obj = await this.env.SHARE_R2.head(pending.r2Key);
    if (!obj) return null;

    return this.createShare({
      r2Key: pending.r2Key,
      shareType: pending.shareType,
      passwordHash: pending.passwordHash,
      passwordSalt: pending.passwordSalt,
      webhookUrl: pending.webhookUrl,
      webhookMessage: pending.webhookMessage,
      fileMetadata: pending.fileMetadata,
      totalSize: pending.totalSize,
      ttl: pending.ttl,
      captchaRequired: pending.captchaRequired,
      expiresAt: pending.expiresAt,
    });
  }

  // ── HMAC nonce: stateless issuance, DO-backed revocation ─────────────────
  // Mirrors the Express server's nonce approach exactly.
  // sig = HMAC-SHA256(SESSION_SECRET, "shareId:ip:ts"), nonce = `sig.ts`

  private async hmacNonce(shareId: string, ip: string, ts: string): Promise<string> {
    const secret = this.env.SESSION_SECRET;
    if (!secret) {
      // Parity with Express: SESSION_SECRET is required when hCaptcha is enabled.
      // Never fall back to a predictable value — that would allow HMAC forgery.
      throw new Error(
        "SESSION_SECRET environment variable is required when HCAPTCHA_SECRET_KEY is set."
      );
    }
    const payload = `${shareId}:${ip}:${ts}`;
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
    const sigHex = Array.from(new Uint8Array(sig))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return `${sigHex}.${ts}`;
  }

  async issueNonce(shareId: string, ip: string): Promise<string> {
    const ts = Date.now().toString();
    return this.hmacNonce(shareId, ip, ts);
  }

  async validateNonce(nonce: string, shareId: string, ip: string): Promise<boolean> {
    // 1. Parse nonce structure: sig.ts
    const dot = nonce.lastIndexOf(".");
    if (dot === -1) return false;
    const ts = nonce.slice(dot + 1);
    const tsNum = parseInt(ts, 10);
    if (isNaN(tsNum) || Date.now() - tsNum > NONCE_TTL_MS) return false;

    // 2. Recompute expected nonce and compare in constant time.
    // If SESSION_SECRET is missing (misconfiguration), hmacNonce throws — treat
    // that as validation failure (deny access) rather than propagating a 500.
    let expected: string;
    try {
      expected = await this.hmacNonce(shareId, ip, ts);
    } catch {
      return false;
    }
    if (expected.length !== nonce.length) return false;

    // Constant-time comparison (Workers WebCrypto doesn't expose timingSafeEqual)
    let equal = true;
    for (let i = 0; i < expected.length; i++) {
      if (expected.charCodeAt(i) !== nonce.charCodeAt(i)) equal = false;
    }
    if (!equal) return false;

    // 3. Atomically revoke in NonceStore DO (single-use guarantee across all instances)
    const resp = await this.nonceStoreStub().fetch(
      new Request("https://do/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nonce, expiresAt: tsNum + NONCE_TTL_MS }),
      })
    );
    const { consumed } = (await resp.json()) as { consumed: boolean };
    return !consumed;
  }
}
