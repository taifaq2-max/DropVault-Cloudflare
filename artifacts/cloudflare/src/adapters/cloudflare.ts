/**
 * CloudflareAdapter — StorageAdapter backed by KV + R2 + Durable Objects.
 *
 * Share metadata is stored in KV (fast, globally replicated). Encrypted blobs
 * are stored in R2 (object storage, not routed through the Worker). Atomic
 * access-once semantics are enforced by the ShareAccessGate Durable Object.
 * Nonce issuance/revocation goes through the NonceStore DO. Rate limiting is
 * handled by the RateLimiter DO.
 */

import type { Env } from "../types/env.js";
import { createR2PresignedPutUrl } from "./r2sign.js";
import type {
  StorageAdapter,
  ShareMeta,
  CreateShareParams,
  GetShareResult,
  AccessShareResult,
  PendingUpload,
  RateLimitResult,
} from "./types.js";

const NONCE_TTL_MS = 5 * 60 * 1000; // 5 minutes

const KV_PENDING_PREFIX = "pending:";
const KV_SHARE_PREFIX = "share:";

/** Max inline KV payload: anything larger uses R2. */
const MAX_INLINE_BYTES = 4 * 1024 * 1024; // 4 MB

const HUMOROUS_ERRORS = [
  "We can't find what you're looking for",
  "No droids here",
  "There is no cake",
  "This share has evaporated",
  "The data has left the building",
];

export class CloudflareAdapter implements StorageAdapter {
  private readonly env: Env;

  constructor(env: Env) {
    this.env = env;
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private shareKey(shareId: string) {
    return `${KV_SHARE_PREFIX}${shareId}`;
  }

  private pendingKey(shareId: string) {
    return `${KV_PENDING_PREFIX}${shareId}`;
  }

  private accessGateStub(shareId: string): DurableObjectStub {
    const id = this.env.SHARE_ACCESS_GATE.idFromName(shareId);
    return this.env.SHARE_ACCESS_GATE.get(id);
  }

  private nonceStoreStub(): DurableObjectStub {
    const id = this.env.NONCE_STORE.idFromName("global");
    return this.env.NONCE_STORE.get(id);
  }

  private rateLimiterStub(): DurableObjectStub {
    const id = this.env.RATE_LIMITER.idFromName("global");
    return this.env.RATE_LIMITER.get(id);
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

    const expiresInSeconds = Math.ceil(
      (new Date(params.expiresAt).getTime() - Date.now()) / 1000
    );

    await this.env.SHARE_KV.put(this.shareKey(shareId), JSON.stringify(meta), {
      expirationTtl: Math.max(expiresInSeconds, 60),
    });

    return shareId;
  }

  async getShare(shareId: string): Promise<GetShareResult> {
    const raw = await this.env.SHARE_KV.get(this.shareKey(shareId));
    if (!raw) return { found: false };

    const meta = JSON.parse(raw) as ShareMeta;

    // Check if expired (KV TTL handles eviction, but double-check on read)
    if (Date.now() > new Date(meta.expiresAt).getTime()) {
      await this.env.SHARE_KV.delete(this.shareKey(shareId));
      return { found: false };
    }

    if (meta.accessed) return { found: true, accessed: true };

    // Consult the access gate DO for the authoritative accessed state.
    const stub = this.accessGateStub(shareId);
    const resp = await stub.fetch(new Request("https://do/check"));
    const { accessed, accessedAt } = (await resp.json()) as {
      accessed: boolean;
      accessedAt: string | null;
    };

    if (accessed) {
      // Sync KV to avoid repeated DO calls
      meta.accessed = true;
      meta.accessedAt = accessedAt;
      await this.env.SHARE_KV.put(this.shareKey(shareId), JSON.stringify(meta), {
        expirationTtl: 60,
      });
      return { found: true, accessed: true };
    }

    return { found: true, accessed: false, share: meta };
  }

  async accessShare(shareId: string): Promise<AccessShareResult> {
    const raw = await this.env.SHARE_KV.get(this.shareKey(shareId));
    if (!raw) return { ok: false, reason: "not_found" };

    const meta = JSON.parse(raw) as ShareMeta;

    if (Date.now() > new Date(meta.expiresAt).getTime()) {
      await this.env.SHARE_KV.delete(this.shareKey(shareId));
      if (meta.r2Key) await this.env.SHARE_R2.delete(meta.r2Key);
      return { ok: false, reason: "expired" };
    }

    // Atomically mark-and-check via the access gate DO
    const stub = this.accessGateStub(shareId);
    const resp = await stub.fetch(new Request("https://do/mark", { method: "POST" }));

    if (resp.status === 409) {
      return { ok: false, reason: "already_accessed" };
    }

    // Fetch R2 blob if share uses R2 storage
    if (meta.r2Key && !meta.encryptedData) {
      const obj = await this.env.SHARE_R2.get(meta.r2Key);
      if (obj) {
        meta.encryptedData = await obj.text();
      }
    }

    return { ok: true, share: meta };
  }

  async deleteShare(shareId: string): Promise<void> {
    const raw = await this.env.SHARE_KV.get(this.shareKey(shareId));
    if (raw) {
      const meta = JSON.parse(raw) as ShareMeta;
      if (meta.r2Key) {
        await this.env.SHARE_R2.delete(meta.r2Key);
      }
    }
    await this.env.SHARE_KV.delete(this.shareKey(shareId));
  }

  async checkRateLimit(key: string, windowMs: number, maxHits: number): Promise<RateLimitResult> {
    const stub = this.rateLimiterStub();
    const resp = await stub.fetch(
      new Request("https://do/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, windowMs, maxHits }),
      })
    );
    return resp.json() as Promise<RateLimitResult>;
  }

  async createPendingUpload(params: PendingUpload): Promise<string | null> {
    // Store pending upload metadata in KV (short TTL: 20 minutes)
    await this.env.SHARE_KV.put(
      this.pendingKey(params.shareId),
      JSON.stringify(params),
      { expirationTtl: 1200 }
    );

    // If R2 credentials are configured, generate a presigned PUT URL
    if (
      this.env.R2_ACCESS_KEY_ID &&
      this.env.R2_ACCESS_KEY_SECRET &&
      this.env.CLOUDFLARE_ACCOUNT_ID
    ) {
      try {
        const uploadUrl = await createR2PresignedPutUrl({
          accountId: this.env.CLOUDFLARE_ACCOUNT_ID,
          accessKeyId: this.env.R2_ACCESS_KEY_ID,
          secretAccessKey: this.env.R2_ACCESS_KEY_SECRET,
          bucket: this.env.R2_BUCKET_NAME,
          key: params.r2Key,
          expiresIn: 900, // 15 minutes
        });
        return uploadUrl;
      } catch {
        return null;
      }
    }

    return null;
  }

  async confirmPendingUpload(shareId: string): Promise<string | null> {
    const raw = await this.env.SHARE_KV.get(this.pendingKey(shareId));
    if (!raw) return null;

    const pending = JSON.parse(raw) as PendingUpload;
    await this.env.SHARE_KV.delete(this.pendingKey(shareId));

    // Verify the R2 object actually exists (confirm that the upload succeeded)
    const obj = await this.env.SHARE_R2.head(pending.r2Key);
    if (!obj) return null;

    const realId = await this.createShare({
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

    return realId;
  }

  async issueNonce(shareId: string, ip: string): Promise<string> {
    const stub = this.nonceStoreStub();
    const resp = await stub.fetch(
      new Request("https://do/issue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shareId, ip }),
      })
    );
    const { nonce } = (await resp.json()) as { nonce: string };
    return nonce;
  }

  async validateNonce(nonce: string, shareId: string): Promise<boolean> {
    const stub = this.nonceStoreStub();
    const resp = await stub.fetch(
      new Request("https://do/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nonce, shareId }),
      })
    );
    const { valid } = (await resp.json()) as { valid: boolean };
    return valid;
  }
}
