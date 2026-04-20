/**
 * MemoryAdapter — pure in-memory StorageAdapter for local development.
 *
 * Mirrors the existing api-server behaviour exactly so the local Express
 * server and the Hono Worker behave identically when tested locally.
 * Not suitable for production (state is lost on restart).
 */

import crypto from "node:crypto";
import type {
  StorageAdapter,
  ShareMeta,
  CreateShareParams,
  GetShareResult,
  AccessShareResult,
  PendingUpload,
  RateLimitResult,
} from "./types.js";

function generateShareId(): string {
  return crypto.randomBytes(48).toString("base64url");
}

const NONCE_TTL_MS = 5 * 60 * 1000;
const HUMOROUS_ERRORS = [
  "We can't find what you're looking for",
  "No droids here",
  "There is no cake",
  "This share has evaporated",
  "The data has left the building",
];

function randomHumorous(): string {
  return HUMOROUS_ERRORS[Math.floor(Math.random() * HUMOROUS_ERRORS.length)] ?? "Not found";
}

export class MemoryAdapter implements StorageAdapter {
  private readonly shares = new Map<string, ShareMeta>();
  private readonly pendingUploads = new Map<string, PendingUpload>();
  private readonly usedNonces = new Map<string, number>(); // nonce → expiry
  private readonly rateLimits = new Map<string, number[]>(); // key → timestamps
  private readonly nonceSecret: string;

  constructor(nonceSecret = "dev-nonce-secret") {
    this.nonceSecret = nonceSecret;
    // Sweep expired nonces + rate limit buckets every TTL window.
    setInterval(() => {
      const now = Date.now();
      for (const [n, exp] of this.usedNonces) {
        if (now > exp) this.usedNonces.delete(n);
      }
    }, NONCE_TTL_MS).unref?.();
  }

  async createShare(params: CreateShareParams): Promise<string> {
    const id = generateShareId();
    const now = new Date().toISOString();
    const share: ShareMeta = {
      id,
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
    this.shares.set(id, share);
    return id;
  }

  async getShare(shareId: string): Promise<GetShareResult> {
    const share = this.shares.get(shareId);
    if (!share) return { found: false };
    if (share.accessed) return { found: true, accessed: true };
    return { found: true, accessed: false, share };
  }

  async accessShare(shareId: string): Promise<AccessShareResult> {
    const share = this.shares.get(shareId);
    if (!share) return { ok: false, reason: "not_found" };

    const now = Date.now();
    if (now > new Date(share.expiresAt).getTime()) {
      this.shares.delete(shareId);
      return { ok: false, reason: "expired" };
    }

    if (share.accessed) return { ok: false, reason: "already_accessed" };

    share.accessed = true;
    share.accessedAt = new Date().toISOString();
    return { ok: true, share };
  }

  async deleteShare(shareId: string): Promise<void> {
    this.shares.delete(shareId);
  }

  async checkRateLimit(key: string, windowMs: number, maxHits: number): Promise<RateLimitResult> {
    const now = Date.now();
    const windowStart = now - windowMs;
    const hits = (this.rateLimits.get(key) ?? []).filter((t) => t > windowStart);

    if (hits.length >= maxHits) {
      const earliest = Math.min(...hits);
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.ceil((earliest + windowMs - now) / 1000),
      };
    }

    hits.push(now);
    this.rateLimits.set(key, hits);
    return { allowed: true, remaining: maxHits - hits.length };
  }

  async createPendingUpload(params: PendingUpload): Promise<string | null> {
    this.pendingUploads.set(params.shareId, params);
    // MemoryAdapter doesn't support real presigned URLs — return null so caller
    // falls back to the inline encryptedData path.
    return null;
  }

  async confirmPendingUpload(shareId: string): Promise<string | null> {
    const pending = this.pendingUploads.get(shareId);
    if (!pending) return null;
    this.pendingUploads.delete(shareId);

    const id = await this.createShare({
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
    return id;
  }

  async issueNonce(shareId: string, ip: string): Promise<string> {
    const ts = Date.now().toString();
    const payload = `${shareId}:${ip}:${ts}`;
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(this.nonceSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
    const sigB64 = Buffer.from(sig).toString("base64url");
    return `${sigB64}.${ts}`;
  }

  async validateNonce(nonce: string, shareId: string, ip: string): Promise<boolean> {
    const dot = nonce.lastIndexOf(".");
    if (dot === -1) return false;
    const sig = nonce.slice(0, dot);
    const ts = nonce.slice(dot + 1);
    const tsNum = parseInt(ts, 10);
    if (isNaN(tsNum) || Date.now() - tsNum > NONCE_TTL_MS) return false;
    if (this.usedNonces.has(nonce)) return false;

    const payload = `${shareId}:${ip}:${ts}`;
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(this.nonceSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );
    const sigBytes = Buffer.from(sig, "base64url");
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      sigBytes,
      new TextEncoder().encode(payload)
    );
    if (!valid) return false;

    // Revoke
    this.usedNonces.set(nonce, tsNum + NONCE_TTL_MS);
    return true;
  }

  // Not used externally but kept for completeness
  _randomHumorous() {
    return randomHumorous();
  }
}
