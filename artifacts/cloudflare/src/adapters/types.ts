/**
 * StorageAdapter: framework-agnostic interface over KV/R2/DO (Cloudflare)
 * or in-memory Maps (local Node.js dev). All share state operations flow
 * through this interface so the route handlers are portable.
 */

export interface ShareMeta {
  id: string;
  /**
   * Inline ciphertext (base64) — present for shares created via the KV inline path.
   * Null for R2-backed shares; use `dataUrl` instead.
   */
  encryptedData?: string | null;
  /** R2 object key — present for shares created via the R2 upload-url path. */
  r2Key?: string | null;
  /**
   * Presigned R2 GET URL — populated by the adapter when serving an R2-backed share.
   * The receiver fetches ciphertext directly from this URL (no Worker memory usage).
   * Not persisted to storage; generated per-request.
   */
  dataUrl?: string | null;
  shareType: "text" | "files";
  passwordHash: string | null;
  passwordSalt: string | null;
  webhookUrl: string | null;
  webhookMessage: string | null;
  fileMetadata: FileMetaItem[] | null;
  totalSize: number;
  ttl: number;
  captchaRequired: boolean;
  /** ISO-8601 expiry timestamp */
  expiresAt: string;
  createdAt: string;
  accessed: boolean;
  accessedAt: string | null;
}

export interface FileMetaItem {
  name: string;
  size: number;
  type: string;
  originalIndex: number;
}

export interface CreateShareParams {
  encryptedData?: string | null;
  r2Key?: string | null;
  shareType: "text" | "files";
  passwordHash: string | null;
  passwordSalt: string | null;
  webhookUrl: string | null;
  webhookMessage: string | null;
  fileMetadata: FileMetaItem[] | null;
  totalSize: number;
  ttl: number;
  captchaRequired: boolean;
  expiresAt: string;
}

/**
 * Always includes `share` when `found: true` so that DELETE handlers can
 * read webhookUrl/webhookMessage to fire the "download complete" webhook
 * even after the share has already been marked accessed.
 */
export type GetShareResult =
  | { found: false }
  | { found: true; accessed: boolean; share: ShareMeta };

export type AccessShareResult =
  | { ok: true; share: ShareMeta }
  | { ok: false; reason: "not_found" | "already_accessed" | "expired" };

export interface PendingUpload {
  shareId: string;
  r2Key: string;
  ttl: number;
  shareType: "text" | "files";
  passwordHash: string | null;
  passwordSalt: string | null;
  webhookUrl: string | null;
  webhookMessage: string | null;
  fileMetadata: FileMetaItem[] | null;
  totalSize: number;
  captchaRequired: boolean;
  captchaToken?: string | null;
  expiresAt: string;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds?: number;
}

export interface StorageAdapter {
  /** Create a new share record. Returns the shareId. */
  createShare(params: CreateShareParams): Promise<string>;

  /** Peek at a share without consuming it. Returns its state. */
  getShare(shareId: string): Promise<GetShareResult>;

  /**
   * Atomically mark a share as accessed and return its data.
   * Must be idempotent — second call for same id returns "already_accessed".
   */
  accessShare(shareId: string): Promise<AccessShareResult>;

  /** Delete a share record (and its R2 blob, if applicable). */
  deleteShare(shareId: string): Promise<void>;

  /** Check and record a rate limit hit for the given key. */
  checkRateLimit(key: string, windowMs: number, maxHits: number): Promise<RateLimitResult>;

  /** Create a pending upload record and return the upload URL (or null if not supported). */
  createPendingUpload(params: PendingUpload): Promise<string | null>;

  /** Confirm a pending upload and create the real share. Returns shareId or null on error. */
  confirmPendingUpload(shareId: string): Promise<string | null>;

  /**
   * Issue an HMAC-based access nonce bound to the given shareId and client IP.
   * The nonce embeds the IP in the HMAC payload so it cannot be used from
   * a different IP address (prevents cross-client nonce theft).
   */
  issueNonce(shareId: string, ip: string): Promise<string>;

  /**
   * Validate and atomically revoke a nonce.
   * Must verify the HMAC signature (binding nonce to shareId + ip + ts) and
   * ensure the nonce has not already been consumed (single-use guarantee).
   */
  validateNonce(nonce: string, shareId: string, ip: string): Promise<boolean>;
}
