/**
 * Framework-agnostic webhook handler.
 */

import type { StorageAdapter } from "../adapters/types.js";
import type { HandlerResult } from "./shares.js";

// Block RFC-1918, loopback, link-local, and cloud-metadata hostnames (SSRF guard).
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

export function isBlockedHost(hostname: string): boolean {
  return BLOCKED_HOST_PATTERNS.some((p) => p.test(hostname));
}

export async function handleTestWebhook(
  webhookUrl: unknown,
  _adapter: StorageAdapter
): Promise<HandlerResult<{ success: boolean; statusCode: number | null; message: string }>> {
  if (!webhookUrl || typeof webhookUrl !== "string") {
    return { ok: false, status: 400, error: "validation_error", message: "Invalid request body." };
  }

  let url: URL;
  try {
    url = new URL(webhookUrl);
  } catch {
    return { ok: false, status: 400, error: "invalid_url", message: "Invalid webhook URL format." };
  }

  if (url.protocol !== "https:") {
    return { ok: false, status: 400, error: "invalid_url", message: "Webhook URL must use HTTPS." };
  }

  if (isBlockedHost(url.hostname)) {
    return {
      ok: false,
      status: 400,
      error: "invalid_url",
      message: "Webhook URL must point to a public host.",
    };
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "VaultDrop webhook test",
        timestamp: new Date().toISOString(),
      }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    return {
      ok: true,
      status: 200,
      data: {
        success: true,
        statusCode: response.status,
        message: `Webhook responded with status ${response.status}`,
      },
    };
  } catch (err) {
    return {
      ok: true,
      status: 200,
      data: {
        success: false,
        statusCode: null,
        message: err instanceof Error ? err.message : "Webhook test failed",
      },
    };
  }
}

/** Fire-and-forget webhook dispatcher. */
export async function fireWebhook(url: string, message: string | null): Promise<void> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: message ?? "your submission has been downloaded",
        timestamp: new Date().toISOString(),
      }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
  } catch {
    // fire-and-forget; swallow all errors
  }
}
