/**
 * Framework-agnostic share route handlers.
 *
 * Each function accepts typed parameters and a StorageAdapter, then returns a
 * typed result object — no HTTP framework coupling. The Hono Worker calls these
 * and maps results to HTTP responses. This layer could equally be called from
 * the Express dev server if desired.
 */

import type { StorageAdapter, FileMetaItem } from "../adapters/types.js";

// ── Constants ────────────────────────────────────────────────────────────────
const VALID_TTLS = new Set([300, 600, 1800, 3600, 14400, 86400, 604800]);

/** Max inline KV path — 4 MB encoded (encryptedData base64 string length). */
const MAX_INLINE_ENCODED = 4 * 1024 * 1024 * 1.5; // 4 MB * 1.5 base64 overhead

/** Maximum total share size including overhead — enforced for both paths. */
export const MAX_SHARE_BYTES = 420 * 1024 * 1024;

export const MAX_FILES = 10;

const HUMOROUS_ERRORS = [
  "We can't find what you're looking for",
  "No droids here",
  "There is no cake",
  "This share has evaporated",
  "The data has left the building",
  "404: Share not found in this dimension",
  "Whatever you're looking for, it isn't here",
];

export function randomHumorous(): string {
  return HUMOROUS_ERRORS[Math.floor(Math.random() * HUMOROUS_ERRORS.length)] ?? "Not found";
}

// ── Input types ───────────────────────────────────────────────────────────────

export interface CreateShareInput {
  encryptedData: string;
  ttl: number;
  shareType: "text" | "files";
  totalSize: number;
  passwordHash: string | null;
  passwordSalt: string | null;
  webhookUrl: string | null;
  webhookMessage: string | null;
  fileMetadata: FileMetaItem[] | null;
  captchaRequired: boolean;
}

export interface UploadUrlInput {
  ttl: number;
  shareType: "text" | "files";
  totalSize: number;
  passwordHash: string | null;
  passwordSalt: string | null;
  webhookUrl: string | null;
  webhookMessage: string | null;
  fileMetadata: FileMetaItem[] | null;
  captchaRequired: boolean;
}

// ── Result types ──────────────────────────────────────────────────────────────

export type HandlerResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: string; message: string; extra?: Record<string, unknown> };

// ── Handlers ──────────────────────────────────────────────────────────────────

/**
 * Create a share via the inline KV path (≤ 4 MB encoded payload).
 */
export async function handleCreateShare(
  input: CreateShareInput,
  adapter: StorageAdapter
): Promise<HandlerResult<{ shareId: string; expiresAt: string }>> {
  if (!VALID_TTLS.has(input.ttl)) {
    return { ok: false, status: 400, error: "validation_error", message: "Invalid TTL value." };
  }
  if (input.shareType !== "text" && input.shareType !== "files") {
    return { ok: false, status: 400, error: "validation_error", message: "Invalid shareType." };
  }
  if (typeof input.totalSize !== "number" || input.totalSize < 0 || input.totalSize > MAX_SHARE_BYTES) {
    return { ok: false, status: 413, error: "payload_too_large", message: `Total payload exceeds the size limit.` };
  }
  if (!/^[A-Za-z0-9+/=_-]+$/.test(input.encryptedData)) {
    return { ok: false, status: 400, error: "invalid_data", message: "encryptedData must be valid base64." };
  }
  if (input.encryptedData.length > MAX_INLINE_ENCODED) {
    return {
      ok: false,
      status: 413,
      error: "payload_too_large",
      message: "Payload too large for inline path. Use the upload-url flow for files over 4 MB.",
    };
  }
  if (input.fileMetadata && input.fileMetadata.length > MAX_FILES) {
    return { ok: false, status: 400, error: "too_many_files", message: `Maximum ${MAX_FILES} files per share.` };
  }

  const expiresAt = new Date(Date.now() + input.ttl * 1000).toISOString();
  const shareId = await adapter.createShare({
    encryptedData: input.encryptedData,
    shareType: input.shareType,
    passwordHash: input.passwordHash,
    passwordSalt: input.passwordSalt,
    webhookUrl: input.webhookUrl,
    webhookMessage: input.webhookMessage,
    fileMetadata: input.fileMetadata,
    totalSize: input.totalSize,
    ttl: input.ttl,
    captchaRequired: input.captchaRequired,
    expiresAt,
  });

  return { ok: true, status: 201, data: { shareId, expiresAt } };
}

/**
 * Request a presigned R2 PUT URL for direct-upload path.
 */
export async function handleUploadUrl(
  input: UploadUrlInput,
  adapter: StorageAdapter
): Promise<HandlerResult<{ shareId: string; uploadUrl: string; expiresAt: string }>> {
  if (!VALID_TTLS.has(input.ttl)) {
    return { ok: false, status: 400, error: "validation_error", message: "Invalid TTL value." };
  }
  if (input.shareType !== "text" && input.shareType !== "files") {
    return { ok: false, status: 400, error: "validation_error", message: "Invalid shareType." };
  }
  if (typeof input.totalSize !== "number" || input.totalSize < 0 || input.totalSize > MAX_SHARE_BYTES) {
    return { ok: false, status: 413, error: "payload_too_large", message: `Total payload exceeds the size limit.` };
  }
  if (input.fileMetadata && input.fileMetadata.length > MAX_FILES) {
    return { ok: false, status: 400, error: "too_many_files", message: `Maximum ${MAX_FILES} files per share.` };
  }

  const pendingShareId = crypto.randomUUID();
  const r2Key = `shares/${pendingShareId}`;
  const expiresAt = new Date(Date.now() + input.ttl * 1000).toISOString();

  const uploadUrl = await adapter.createPendingUpload({
    shareId: pendingShareId,
    r2Key,
    ttl: input.ttl,
    shareType: input.shareType,
    passwordHash: input.passwordHash,
    passwordSalt: input.passwordSalt,
    webhookUrl: input.webhookUrl,
    webhookMessage: input.webhookMessage,
    fileMetadata: input.fileMetadata,
    totalSize: input.totalSize,
    captchaRequired: input.captchaRequired,
    expiresAt,
  });

  if (!uploadUrl) {
    return {
      ok: false,
      status: 501,
      error: "r2_not_configured",
      message: "R2 direct-upload is not configured on this deployment.",
    };
  }

  return { ok: true, status: 200, data: { shareId: pendingShareId, uploadUrl, expiresAt } };
}

/**
 * Confirm a pending R2 upload and activate the share.
 */
export async function handleConfirmUpload(
  pendingShareId: string,
  adapter: StorageAdapter
): Promise<HandlerResult<{ shareId: string; expiresAt: string }>> {
  const realShareId = await adapter.confirmPendingUpload(pendingShareId);
  if (!realShareId) {
    return {
      ok: false,
      status: 404,
      error: "not_found",
      message: "Pending upload not found or R2 object missing. The upload may have failed.",
    };
  }

  const result = await adapter.getShare(realShareId);
  const expiresAt =
    result.found && !result.accessed ? result.share.expiresAt : new Date().toISOString();

  return { ok: true, status: 201, data: { shareId: realShareId, expiresAt } };
}

/**
 * Peek at a share without consuming it. Issues an access nonce when captcha is enabled.
 */
export async function handlePeekShare(
  shareId: string,
  ip: string,
  captchaEnabled: boolean,
  adapter: StorageAdapter
): Promise<
  HandlerResult<{
    totalSize: number;
    passwordRequired: boolean;
    shareType: string;
    fileCount: number;
    expiresAt: string;
    accessNonce?: string;
  }>
> {
  const result = await adapter.getShare(shareId);

  if (!result.found) {
    return {
      ok: false,
      status: 404,
      error: "not_found",
      message: "Share not found or expired",
      extra: { humorousMessage: randomHumorous() },
    };
  }
  if (result.accessed) {
    return {
      ok: false,
      status: 410,
      error: "already_accessed",
      message: "Share already accessed",
      extra: { humorousMessage: "There is no cake" },
    };
  }

  const { share } = result;

  if (Date.now() > new Date(share.expiresAt).getTime()) {
    await adapter.deleteShare(shareId);
    return {
      ok: false,
      status: 410,
      error: "expired",
      message: "Share has expired",
      extra: { humorousMessage: "No droids here" },
    };
  }

  const accessNonce = captchaEnabled ? await adapter.issueNonce(shareId, ip) : undefined;

  return {
    ok: true,
    status: 200,
    data: {
      totalSize: share.totalSize,
      passwordRequired: share.passwordHash !== null,
      shareType: share.shareType,
      fileCount: share.fileMetadata?.length ?? 0,
      expiresAt: share.expiresAt,
      ...(accessNonce !== undefined ? { accessNonce } : {}),
    },
  };
}

/**
 * Access and consume a share (one-time).
 * Returns encrypted data (inline) or a presigned R2 GET URL (large blobs).
 * Does NOT fire the webhook — that happens on DELETE (download-complete signal).
 */
export async function handleAccessShare(
  shareId: string,
  ip: string,
  nonce: string | undefined,
  captchaEnabled: boolean,
  adapter: StorageAdapter
): Promise<
  HandlerResult<{
    encryptedData: string | null | undefined;
    dataUrl?: string | null;
    fileMetadata: import("../adapters/types.js").FileMetaItem[] | null;
    passwordRequired: boolean;
    passwordSalt: string | null;
    shareType: string;
    totalSize: number;
    webhookUrl: string | null;
    webhookMessage: string | null;
  }>
> {
  // Validate nonce when captcha is enabled.
  if (captchaEnabled) {
    if (!nonce) {
      return {
        ok: false,
        status: 403,
        error: "invalid_nonce",
        message: "Access denied. Please return to the share link and try again.",
      };
    }
    const valid = await adapter.validateNonce(nonce, shareId, ip);
    if (!valid) {
      return {
        ok: false,
        status: 403,
        error: "invalid_nonce",
        message: "Access denied. Please return to the share link and try again.",
      };
    }
  }

  const result = await adapter.accessShare(shareId);

  if (!result.ok) {
    if (result.reason === "not_found") {
      return {
        ok: false,
        status: 404,
        error: "not_found",
        message: "Share not found or expired",
        extra: { humorousMessage: randomHumorous() },
      };
    }
    if (result.reason === "already_accessed") {
      return {
        ok: false,
        status: 410,
        error: "already_accessed",
        message: "Share has already been accessed",
        extra: { humorousMessage: "There is no cake" },
      };
    }
    return {
      ok: false,
      status: 410,
      error: "expired",
      message: "Share has expired",
      extra: { humorousMessage: "No droids here" },
    };
  }

  const { share } = result;

  return {
    ok: true,
    status: 200,
    data: {
      encryptedData: share.encryptedData,
      dataUrl: share.dataUrl,
      fileMetadata: share.fileMetadata,
      passwordRequired: share.passwordHash !== null,
      passwordSalt: share.passwordSalt,
      shareType: share.shareType,
      totalSize: share.totalSize,
      webhookUrl: share.webhookUrl,
      webhookMessage: share.webhookMessage,
    },
  };
}

/**
 * Delete a share and fire its webhook (signals download-complete).
 * Matches Express server behavior: webhook fires on DELETE, not on GET access.
 */
export async function handleDeleteShare(
  shareId: string,
  adapter: StorageAdapter,
  fireWebhook: (url: string, message: string | null) => Promise<void>
): Promise<HandlerResult<{ success: boolean; message: string }>> {
  const result = await adapter.getShare(shareId);
  if (!result.found) {
    return { ok: false, status: 404, error: "not_found", message: "Share not found." };
  }

  // Fire webhook before deleting so we still have the metadata.
  if (!result.accessed && result.share.webhookUrl) {
    await fireWebhook(result.share.webhookUrl, result.share.webhookMessage).catch(() => {});
  }

  await adapter.deleteShare(shareId);
  return { ok: true, status: 200, data: { success: true, message: "Share deleted successfully." } };
}
