/**
 * r2sign — AWS Signature Version 4 presigned PUT URL generator for Cloudflare R2.
 *
 * R2 exposes an S3-compatible API at:
 *   https://<accountId>.r2.cloudflarestorage.com/<bucket>/<key>
 *
 * We sign with UNSIGNED-PAYLOAD so the browser can PUT any bytes without
 * including the payload hash in the signed headers — this is the standard
 * approach for browser direct-uploads.
 *
 * Uses the WebCrypto API (available natively in Cloudflare Workers).
 */

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

function formatDate(d: Date): string {
  return `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}`;
}

function formatDatetime(d: Date): string {
  return (
    formatDate(d) +
    "T" +
    pad2(d.getUTCHours()) +
    pad2(d.getUTCMinutes()) +
    pad2(d.getUTCSeconds()) +
    "Z"
  );
}

async function sha256hex(data: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function hmacSha256(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key instanceof ArrayBuffer ? key : key.buffer as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data));
}

async function hmacHex(key: ArrayBuffer, data: string): Promise<string> {
  const buf = await hmacSha256(key, data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function deriveSigningKey(
  secret: string,
  dateStr: string,
  region: string,
  service: string
): Promise<ArrayBuffer> {
  const kDate = await hmacSha256(new TextEncoder().encode("AWS4" + secret), dateStr);
  const kRegion = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, service);
  return hmacSha256(kService, "aws4_request");
}

export interface PresignedUrlOptions {
  /** Cloudflare account ID (found in dash.cloudflare.com). */
  accountId: string;
  /** R2 API token Access Key ID. */
  accessKeyId: string;
  /** R2 API token Secret Access Key. */
  secretAccessKey: string;
  /** R2 bucket name. */
  bucket: string;
  /** Object key (path within the bucket). */
  key: string;
  /** URL lifetime in seconds. Default: 900 (15 minutes). */
  expiresIn?: number;
}

/** @deprecated Use PresignedUrlOptions */
export type PresignedPutOptions = PresignedUrlOptions;

async function createR2PresignedUrl(method: "PUT" | "GET", opts: PresignedUrlOptions): Promise<string> {
  const { accountId, accessKeyId, secretAccessKey, bucket, key, expiresIn = 900 } = opts;

  const region = "auto";
  const service = "s3";
  const host = `${accountId}.r2.cloudflarestorage.com`;

  const now = new Date();
  const dateStr = formatDate(now);
  const datetimeStr = formatDatetime(now);
  const scope = `${dateStr}/${region}/${service}/aws4_request`;
  const credential = `${accessKeyId}/${scope}`;

  // Build canonical query string (must be sorted alphabetically)
  const queryPairs: [string, string][] = [
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Credential", credential],
    ["X-Amz-Date", datetimeStr],
    ["X-Amz-Expires", String(expiresIn)],
    ["X-Amz-SignedHeaders", "host"],
  ];
  queryPairs.sort(([a], [b]) => a.localeCompare(b));

  const canonicalQueryString = queryPairs
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");

  const canonicalRequest = [
    method,
    `/${bucket}/${encodeURIComponent(key).replace(/%2F/g, "/")}`,
    canonicalQueryString,
    `host:${host}\n`,
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const requestHash = await sha256hex(canonicalRequest);
  const stringToSign = ["AWS4-HMAC-SHA256", datetimeStr, scope, requestHash].join("\n");

  const signingKey = await deriveSigningKey(secretAccessKey, dateStr, region, service);
  const signature = await hmacHex(signingKey, stringToSign);

  const finalQuery =
    canonicalQueryString + `&X-Amz-Signature=${encodeURIComponent(signature)}`;

  return `https://${host}/${bucket}/${encodeURIComponent(key).replace(/%2F/g, "/")}?${finalQuery}`;
}

/**
 * Generate a presigned PUT URL for direct browser → R2 upload.
 * The browser can PUT the encrypted ciphertext without routing it through the Worker.
 */
export async function createR2PresignedPutUrl(opts: PresignedUrlOptions): Promise<string> {
  return createR2PresignedUrl("PUT", opts);
}

/**
 * Generate a presigned GET URL for direct browser ← R2 download.
 * The browser can fetch the encrypted ciphertext without routing it through the Worker,
 * keeping large blobs out of Worker memory entirely.
 */
export async function createR2PresignedGetUrl(opts: PresignedUrlOptions): Promise<string> {
  return createR2PresignedUrl("GET", opts);
}
