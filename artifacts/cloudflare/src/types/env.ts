export interface Env {
  // ----- KV: share metadata -----
  SHARE_KV: KVNamespace;

  // ----- R2: encrypted blobs -----
  SHARE_R2: R2Bucket;

  // ----- Durable Objects (untyped namespace — avoids DurableObjectBranded constraint) -----
  SHARE_ACCESS_GATE: DurableObjectNamespace;
  NONCE_STORE: DurableObjectNamespace;
  RATE_LIMITER: DurableObjectNamespace;

  // ----- Vars / Secrets -----
  /** Allowed origin for CORS (your Pages domain). */
  FRONTEND_URL: string;

  /** Cloudflare Account ID — needed for R2 presigned URL signing. */
  CLOUDFLARE_ACCOUNT_ID: string;

  /** R2 bucket name — must match wrangler.toml. */
  R2_BUCKET_NAME: string;

  /** R2 API token access key ID (for presigned PUT URLs). */
  R2_ACCESS_KEY_ID?: string;

  /** R2 API token secret access key (for presigned PUT URLs). */
  R2_ACCESS_KEY_SECRET?: string;

  /** hCaptcha secret key (optional). */
  HCAPTCHA_SECRET_KEY?: string;

  /** HMAC secret for nonce signing (required when hCaptcha is enabled). */
  SESSION_SECRET?: string;
}
