# VaultDrop — Cloudflare Deployment Guide

This guide walks you through deploying VaultDrop on Cloudflare's global
infrastructure: the API runs as a **Cloudflare Worker** (Hono) and the
frontend is served from **Cloudflare Pages**.  Encrypted blobs up to
**420 MB** are stored in **R2**, bypassing the Worker entirely via presigned
PUT URLs.

---

## Architecture Overview

```
Browser  ──(GET /share/*)──►  Cloudflare Pages  (static SPA)
    │
    │  POST /api/shares/upload-url    ───►  Cloudflare Worker  (Hono)
    │  PUT <presigned R2 URL>         ───►  R2  (direct, no Worker hop)
    │  POST /api/shares/confirm       ───►  Worker
    │  GET  /api/shares/:id           ───►  Worker → KV / R2
    │
    │  KV namespace  ── share metadata (JSON, TTL-managed)
    │  R2 bucket     ── encrypted blobs (large payloads)
    │  Durable Objects:
    │    ShareAccessGate   — atomic at-most-once access per share
    │    NonceStore        — HMAC nonce issuance + single-use revocation
    │    RateLimiter       — sliding-window rate limiting across all instances
```

---

## Prerequisites

- A Cloudflare account (free tier works for testing; paid is needed for
  Durable Objects and R2 at scale)
- [Node.js 20+](https://nodejs.org) and [pnpm](https://pnpm.io)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (included
  as a dev dependency — run via `pnpm exec wrangler`)

---

## Step 1 — Create Cloudflare resources

### KV Namespace (share metadata)

```bash
pnpm exec wrangler kv namespace create "SHARE_KV"
pnpm exec wrangler kv namespace create "SHARE_KV" --preview
```

Copy the `id` values into `artifacts/cloudflare/wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "SHARE_KV"
id = "<production-id-from-above>"
preview_id = "<preview-id-from-above>"
```

### R2 Bucket (encrypted blobs)

```bash
pnpm exec wrangler r2 bucket create vaultdrop-shares
```

The bucket name is already set in `wrangler.toml`:

```toml
[[r2_buckets]]
binding = "SHARE_R2"
bucket_name = "vaultdrop-shares"
```

### R2 API Token (for presigned URL signing)

Presigned PUT URLs let the browser upload directly to R2 without the
Worker being in the data path — required for the 420 MB limit.

1. Go to **Cloudflare Dashboard → R2 → Manage R2 API Tokens**
2. Click **Create API Token**
3. Set **Permissions: Object Read & Write**
4. Scope it to the `vaultdrop-shares` bucket only
5. Save the **Access Key ID** and **Secret Access Key**

```bash
pnpm exec wrangler secret put R2_ACCESS_KEY_ID
pnpm exec wrangler secret put R2_ACCESS_KEY_SECRET
```

### Find your Account ID

Your Cloudflare Account ID is shown in the right sidebar of any zone on
the dashboard, or via:

```bash
pnpm exec wrangler whoami
```

Set it in `wrangler.toml` under `[vars]`:

```toml
[vars]
CLOUDFLARE_ACCOUNT_ID = "<your-account-id>"
R2_BUCKET_NAME = "vaultdrop-shares"
```

---

## Step 2 — Configure secrets

```bash
# Required: HMAC secret for access nonce signing.
# Generate with: openssl rand -hex 32
pnpm exec wrangler secret put SESSION_SECRET

# Optional: hCaptcha — skip if you don't want CAPTCHA gating.
pnpm exec wrangler secret put HCAPTCHA_SECRET_KEY
```

---

## Step 3 — Set the CORS allowed origin

Edit `artifacts/cloudflare/wrangler.toml`:

```toml
[vars]
FRONTEND_URL = "https://your-pages-domain.pages.dev"
```

Replace with your actual Pages domain (or custom domain). This restricts
CORS to only your frontend — do not leave it blank in production.

---

## Step 4 — Deploy the Worker

```bash
cd artifacts/cloudflare
pnpm exec wrangler deploy
```

Note the Worker URL printed on success (e.g.
`https://vaultdrop-api.<your-account>.workers.dev`). You will need it in
Step 5.

### First deploy: Durable Object migration

The first deploy will automatically apply the v1 migration that registers
the three Durable Object classes. If you see a migration warning, confirm
it — this is expected.

---

## Step 5 — Deploy the frontend to Cloudflare Pages

### Build locally (optional — Pages CI builds automatically)

```bash
pnpm --filter @workspace/ephemeral-share run build
```

Output is in `artifacts/ephemeral-share/dist/public`.

### Connect to Cloudflare Pages

1. Go to **Cloudflare Dashboard → Pages → Create a project**
2. Connect your Git repository
3. Set **Build command**:
   ```
   pnpm --filter @workspace/ephemeral-share run build
   ```
4. Set **Build output directory**: `artifacts/ephemeral-share/dist/public`

### Set environment variables in the Pages dashboard

Under **Settings → Environment variables**, add:

| Variable | Value | Notes |
|---|---|---|
| `VITE_API_URL` | `https://vaultdrop-api.<account>.workers.dev` | Worker URL from Step 4 |
| `VITE_USE_R2_UPLOADS` | `true` | Enables 420 MB direct-upload flow |
| `VITE_HCAPTCHA_SITE_KEY` | `<your-site-key>` | Optional; skip if no CAPTCHA |

> **Note**: `VITE_API_URL` is injected at build time. After adding it,
> trigger a redeploy by pushing a commit or clicking **Retry deployment**.

### SPA routing

The `_redirects` and `_headers` files in `artifacts/ephemeral-share/public/`
are automatically picked up by Cloudflare Pages. They configure:

- SPA fallback (`/* → /index.html`)
- Security headers (CSP, X-Frame-Options, etc.)
- Long-lived caching for hashed assets

---

## Step 6 — Route `/api/*` requests to the Worker

The frontend uses **relative `/api/*` paths** (no `VITE_API_URL` env var
required). For this to work, `/api/*` traffic must be routed to the Worker
from the same origin as the Pages site — not from a different URL.

**Choose exactly one option below and follow it completely.** Mixing
approaches or setting `VITE_API_URL` to the Worker's `workers.dev` URL
while also using Option A/B will break CORS and cause 404s.

### Option A — Custom domain + Worker Routes (recommended for production)

1. Add your domain to Cloudflare
2. Route `yourdomain.com/api/*` to the Worker via **Workers & Pages → your
   Worker → Triggers → Routes**
3. Route `yourdomain.com/*` to your Pages project
4. Update `FRONTEND_URL` in `wrangler.toml` to `https://yourdomain.com`
5. Leave `VITE_API_URL` **unset** in Pages — the frontend uses relative `/api/*`

### Option B — Pages Function proxy (no custom domain, e.g. `*.pages.dev`)

The proxy function is already included at
`artifacts/ephemeral-share/functions/api/[[route]].ts`. It forwards all
`/api/*` requests — including bodies, headers, and streaming responses — to
your Worker, and returns a clear `502` if `WORKER_URL` is not configured.

Add `WORKER_URL` as a Pages secret (under **Settings → Environment variables
→ Add secret**). The value must be the Worker origin with **no trailing slash
and no path suffix** — the function appends the full `/api/…` path itself:
```
https://vaultdrop-api.<account>.workers.dev
```

---

## Step 7 — CORS configuration for R2 direct uploads

For browsers to PUT directly to R2, the bucket needs a CORS policy. Add
it via the R2 bucket settings in the Cloudflare dashboard:

```json
[
  {
    "AllowedOrigins": ["https://your-pages-domain.pages.dev"],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["Content-Type"],
    "MaxAgeSeconds": 3600
  }
]
```

Replace the origin with your actual Pages or custom domain.

---

## Environment Variables Summary

### Worker (`artifacts/cloudflare/wrangler.toml` + Wrangler secrets)

| Name | Type | Required | Description |
|---|---|---|---|
| `FRONTEND_URL` | var | Yes | Allowed CORS origin |
| `CLOUDFLARE_ACCOUNT_ID` | var | Yes | For R2 presigned URL signing |
| `R2_BUCKET_NAME` | var | Yes | R2 bucket name |
| `SESSION_SECRET` | secret | Yes* | HMAC nonce secret (*required when `HCAPTCHA_SECRET_KEY` is set) |
| `HCAPTCHA_SECRET_KEY` | secret | No | hCaptcha site verification secret |
| `R2_ACCESS_KEY_ID` | secret | Yes** | R2 API token key ID (**required for large-file flow) |
| `R2_ACCESS_KEY_SECRET` | secret | Yes** | R2 API token secret |

### Frontend (Cloudflare Pages environment variables)

| Name | Build-time | Required | Description |
|---|---|---|---|
| `VITE_API_URL` | Yes | For custom domain routing | Worker URL |
| `VITE_USE_R2_UPLOADS` | Yes | No | Set `true` to enable 420 MB uploads |
| `VITE_HCAPTCHA_SITE_KEY` | Yes | No | hCaptcha site key (frontend) |
| `WORKER_URL` | No (runtime secret) | Option B only | Worker URL used by the Pages Function proxy |

---

## Local development

### Standard dev server (Vite proxy — recommended for most development)

The existing Node.js + Express dev server is unchanged. Run it with:

```bash
pnpm --filter @workspace/api-server run dev
```

The frontend proxies `/api/*` to `localhost:8080` via Vite's dev server
proxy. R2 uploads are disabled in this mode (`VITE_USE_R2_UPLOADS` is not
set) and the inline 4 MB KV path is used instead.

### Testing the Pages Function proxy locally (Option B only)

If you are using the Pages Function proxy (`functions/api/[[route]].ts`) and
want to validate its routing behaviour before deploying to Cloudflare Pages,
you can run it locally with Wrangler:

**1 — Create your local secrets file**

```bash
cp artifacts/ephemeral-share/.dev.vars.example artifacts/ephemeral-share/.dev.vars
```

Edit `.dev.vars` and set `WORKER_URL` to the Worker you want to proxy to.
For full local testing, run the Worker locally first:

```bash
pnpm --filter @workspace/cloudflare run dev:worker   # starts Worker on :8787
```

Then set `WORKER_URL=http://localhost:8787` in `.dev.vars`.

**2 — Build the frontend**

Wrangler Pages dev serves files from the built output directory.
The Vite config requires `PORT` (dev server port — any free port works for a
build) and `BASE_PATH` (URL base of the app — use `/` for local Pages dev):

```bash
PORT=3000 BASE_PATH=/ pnpm --filter @workspace/ephemeral-share run build
```

**3 — Start the Pages dev server**

```bash
pnpm --filter @workspace/ephemeral-share run pages:dev
```

This runs `wrangler pages dev dist/public --port 8788` and activates the
Pages Function so that `http://localhost:8788/api/*` is proxied through
`functions/api/[[route]].ts` to the `WORKER_URL` you configured.

> **Note**: `.dev.vars` is gitignored and should never be committed. Only
> `.dev.vars.example` (which contains no real secrets) lives in the
> repository.

---

## Staging environment

A `[env.staging]` block is defined in `wrangler.toml`. Deploy to staging:

```bash
cd artifacts/cloudflare
pnpm exec wrangler deploy --env staging
```

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `nonce_forgery` / 403 on access | `SESSION_SECRET` not set | `wrangler secret put SESSION_SECRET` |
| `r2_not_configured` on upload | R2 credentials missing | Set `R2_ACCESS_KEY_ID` + `R2_ACCESS_KEY_SECRET` secrets |
| CORS errors in browser | `FRONTEND_URL` mismatch | Update `wrangler.toml → [vars] FRONTEND_URL` and redeploy |
| R2 PUT returns 403 | CORS policy not set on bucket | Add CORS policy to R2 bucket (Step 7) |
| Durable Object errors on first deploy | DO migration not applied | Confirm the migration prompt during `wrangler deploy` |
| Build fails: `minimumReleaseAge` | New package too fresh | Add to `minimumReleaseAgeExclude` or wait 24 h |
| Share link broken on hard refresh | SPA `_redirects` missing | Check `artifacts/ephemeral-share/public/_redirects` is present |
