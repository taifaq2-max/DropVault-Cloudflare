import crypto from "crypto";
import os from "os";

export interface FileMetadata {
  name: string;
  size: number;
  type: string;
  originalIndex: number;
}

export interface Share {
  id: string;
  encryptedData: string;
  passwordHash: string | null;
  passwordSalt: string | null;
  accessed: boolean;
  createdAt: number;
  expiresAt: number;
  sessionId: string;
  webhookUrl: string | null;
  webhookMessage: string | null;
  fileMetadata: FileMetadata[] | null;
  shareType: "text" | "files" | "mixed";
  totalSize: number;
}

const shares = new Map<string, Share>();
let containersCreated = 0;
let containersDelivered = 0;

export function generateShareId(): string {
  const chars =
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const randomBytes = crypto.randomBytes(64);
  let id = "";
  for (let i = 0; i < 64; i++) {
    id += chars[randomBytes[i] % chars.length];
  }
  return id;
}

export function createShare(params: {
  encryptedData: string;
  ttl: number;
  passwordHash?: string | null;
  passwordSalt?: string | null;
  webhookUrl?: string | null;
  webhookMessage?: string | null;
  fileMetadata?: FileMetadata[] | null;
  shareType: "text" | "files" | "mixed";
  totalSize: number;
}): Share {
  const id = generateShareId();
  const now = Date.now();
  const share: Share = {
    id,
    encryptedData: params.encryptedData,
    passwordHash: params.passwordHash ?? null,
    passwordSalt: params.passwordSalt ?? null,
    accessed: false,
    createdAt: now,
    expiresAt: now + params.ttl * 1000,
    sessionId: crypto.randomUUID(),
    webhookUrl: params.webhookUrl ?? null,
    webhookMessage: params.webhookMessage ?? null,
    fileMetadata: params.fileMetadata ?? null,
    shareType: params.shareType,
    totalSize: params.totalSize,
  };
  shares.set(id, share);
  containersCreated++;
  return share;
}

export function getShare(id: string): Share | undefined {
  return shares.get(id);
}

export function markAccessed(id: string): void {
  const share = shares.get(id);
  if (share) {
    share.accessed = true;
    containersDelivered++;
  }
}

export function deleteShare(id: string): boolean {
  return shares.delete(id);
}

export function getStats(): {
  containersCreated: number;
  containersDelivered: number;
  activeShares: number;
  memoryUsedMb: number;
  memoryFreeMb: number;
} {
  const memUsage = process.memoryUsage();
  const memoryUsedMb = Math.round((memUsage.heapUsed / 1024 / 1024) * 10) / 10;
  const totalMem = memUsage.heapTotal;
  const memoryFreeMb =
    Math.round(((totalMem - memUsage.heapUsed) / 1024 / 1024) * 10) / 10;

  return {
    containersCreated,
    containersDelivered,
    activeShares: shares.size,
    memoryUsedMb,
    memoryFreeMb,
  };
}

export function getAvailableMemoryMb(): number {
  return os.freemem() / 1024 / 1024;
}

export function cleanupExpired(): void {
  const now = Date.now();
  for (const [id, share] of shares.entries()) {
    if (now > share.expiresAt) {
      if (share.webhookUrl && !share.accessed) {
        fireWebhook(share.webhookUrl, share.webhookMessage ?? undefined).catch(
          () => {}
        );
      }
      shares.delete(id);
    }
  }
}

export async function fireWebhook(
  url: string,
  message?: string
): Promise<void> {
  const payload = {
    message: message ?? "your submission has been downloaded",
    timestamp: new Date().toISOString(),
  };
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timeout);
  } catch {
    // fire-and-forget, ignore all errors
  }
}

// Start cleanup interval
setInterval(cleanupExpired, 10_000);
