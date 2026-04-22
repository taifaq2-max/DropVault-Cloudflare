# VaultDrop

**Zero-knowledge, one-time file and text sharing. Encrypted in your browser. Gone after one read.**

VaultDrop lets you share sensitive files or text through a self-destructing link. All encryption happens client-side using the Web Crypto API — the server only ever sees ciphertext. The decryption key lives exclusively in the URL fragment and is never transmitted to the server.

---

## How it works

```
Sender browser                    VaultDrop server              Receiver browser
─────────────────                 ────────────────              ─────────────────
Generate 256-bit key
Encrypt payload (AES-GCM)
POST ciphertext ──────────────►  Store in RAM (TTL)
                                  Return share ID
Build share link:
  /share/<ID>#key=<base64>
Share link (out of band) ─────────────────────────────────────► Open link
                                                                 Extract key from fragment
                                                                 GET /api/shares/<ID> ─────► Return ciphertext
                                                                                              + delete from RAM
                                                                 Decrypt in browser
                                                                 Display / download
                                  (share is gone — any
                                   further access → 404)
```

The `#fragment` is never sent to the server. The server never sees the key.

---

## Key features

| Feature | Detail |
|---|---|
| **Client-side AES-GCM encryption** | Web Crypto API; 256-bit key; 12-byte IV |
| **Optional password protection** | PBKDF2-derived sub-key; salt stored on server; key never stored |
| **One-time access** | Share deleted from RAM immediately after the receiver fetches it |
| **Configurable TTL** | 1 min · 15 min · 1 h · 36 h · 1 d · 4 d |
| **Large-file support** | Up to 420 MB via R2 direct-upload (Cloudflare deployment) |
| **hCaptcha gate** | Every share creation requires a solved CAPTCHA (skipped when key not set) |
| **Rate limiting** | 3 shares / minute per IP (sliding window) |
| **Webhook notifications** | Optional fire-and-forget POST when receiver accesses share |
| **Zero server-side logging** | No access logs, no audit trails, no IP tracking |
| **Dark / Light mode** | Persisted via `next-themes` |
| **WCAG 2.1 AA** | Keyboard navigable, ARIA-labelled, sufficient contrast |
| **PWA-capable** | Installable on mobile |
| **Friendly dog mascot** | On every 404 / error page |

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  Frontend  (artifacts/ephemeral-share)                           │
│  React 19 + Vite · Wouter · framer-motion · next-themes · jszip  │
│                                                                  │
│  /              SenderPage  (text & file tabs, TTL, webhook)     │
│  /share/:id     ReceiverPage  (peek → warn → decrypt → download) │
│  *              NotFoundPage  (dog mascot + humorous messages)   │
└───────────────────────────┬──────────────────────────────────────┘
                            │  /api/*  (Vite proxy in dev)
                            │          (Worker Routes / Pages Function in prod)
┌───────────────────────────▼──────────────────────────────────────┐
│  API  — two interchangeable backends:                            │
│                                                                  │
│  Local dev: Express 5  (artifacts/api-server)                    │
│    In-memory store · pino logging · Zod validation               │
│    Endpoints: POST /api/shares                                   │
│               GET  /api/shares/:id                               │
│               GET  /api/shares/:id/peek                          │
│               DELETE /api/shares/:id                             │
│               POST /api/webhook/test                             │
│               GET  /api/healthz  (public)                        │
│               GET  /api/health   (API-key required)              │
│                                                                  │
│  Production: Cloudflare Worker  (artifacts/cloudflare — Hono)    │
│    KV   — share metadata (TTL-managed)                           │
│    R2   — encrypted blobs (direct PUT, bypasses Worker)          │
│    Durable Objects:                                              │
│      ShareAccessGate — atomic at-most-once access                │
│      NonceStore      — HMAC nonce issuance + revocation          │
│      RateLimiter     — sliding-window across all instances       │
│    Extra endpoints: POST /api/shares/upload-url                  │
│                     POST /api/shares/confirm                     │
└──────────────────────────────────────────────────────────────────┘
```

---

## Tech stack

| Layer | Technology |
|---|---|
| Frontend framework | React 19 + Vite 7 |
| Routing | Wouter |
| Styling | Tailwind CSS 4 |
| Animations | framer-motion |
| Crypto | Web Crypto API (AES-GCM, PBKDF2) |
| ZIP downloads | jszip |
| Local API | Express 5, Node.js 24 |
| Production API | Cloudflare Workers (Hono) |
| Persistent storage | Cloudflare KV (metadata) + R2 (blobs) |
| At-most-once access | Cloudflare Durable Objects |
| Validation | Zod |
| API types | Orval (OpenAPI codegen) |
| Build | esbuild |
| Tests | Vitest + Testing Library |
| Package manager | pnpm workspaces |

---

## Quick start (local dev — no cloud required)

### Prerequisites

- Node.js 20+ (24 recommended)
- pnpm 10+

### Install dependencies

```bash
git clone https://github.com/taifaq2-max/DropVault.git
cd DropVault
pnpm install
```

### Create the required environment file

```bash
# .env is gitignored — create it locally
echo "SESSION_SECRET=$(openssl rand -hex 64)" > .env
echo "PORT=8080" >> .env
```

### Start the API server

```bash
pnpm --filter @workspace/api-server run dev
```

The API listens on **port 8080** by default.

### Start the frontend dev server

```bash
pnpm --filter @workspace/ephemeral-share run dev
```

The app opens at the URL printed by Vite. Requests to `/api/*` are proxied to `localhost:8080` automatically.

---

## Docker quick start (no Node.js required)

```bash
git clone https://github.com/taifaq2-max/DropVault.git
cd DropVault
echo "SESSION_SECRET=$(openssl rand -hex 64)" > .env
docker compose -f docker-compose.local.yml up -d --build
```

Open `http://localhost:3000`.

See [DropVault-docker.md](DropVault-docker.md) for full production Docker setup with TLS.

---

## Environment variables

### API server (`artifacts/api-server`)

| Variable | Required | Default | Description |
|---|---|---|---|
| `SESSION_SECRET` | Yes | — | Signs internal tokens. Use `openssl rand -hex 64`. |
| `PORT` | Yes | — | API listen port (use `8080` locally). |
| `HCAPTCHA_SECRET_KEY` | No | — | hCaptcha server-side key. Omit to skip CAPTCHA in dev. |
| `DEBUG` | No | `false` | Enables verbose request logging to the terminal. |

### Frontend build-time (`VITE_*`)

| Variable | Required | Description |
|---|---|---|
| `VITE_HCAPTCHA_SITE_KEY` | No | hCaptcha public site key. |
| `VITE_USE_R2_UPLOADS` | No | Set `true` to enable the 420 MB R2 direct-upload flow. |
| `VITE_API_URL` | No | Override API base URL (Cloudflare deployment). |

---

## Running tests

```bash
# Frontend unit tests
pnpm --filter @workspace/ephemeral-share run test

# API integration tests
pnpm --filter @workspace/api-server run test

# Type-check everything
pnpm run typecheck
```

---

## Deployment

### Cloudflare Workers + Pages (recommended for production)

Supports up to **420 MB** per share via R2 direct uploads. Globally distributed. Durable Objects guarantee at-most-once share access even under concurrent requests.

See **[CLOUDFLARE_DEPLOY.md](CLOUDFLARE_DEPLOY.md)** for step-by-step instructions covering:
- KV namespace + R2 bucket creation
- Worker deployment with Wrangler
- Cloudflare Pages frontend deployment
- CORS configuration for R2 direct uploads
- Custom domain vs. Pages Function proxy routing

### Docker on a Linux VPS

Two Docker images: an Express 5 API and an nginx reverse proxy. Supports TLS via Let's Encrypt, self-signed certs, or bring-your-own. Also includes a Cloudflare Tunnel option (no open firewall ports needed).

See **[DropVault-docker.md](DropVault-docker.md)** for full setup.

See **[deployment.md](deployment.md)** for Cloudflare Tunnel, DNS proxy, and Microsoft Teams tab integration.

---

## Security model

| Property | Implementation |
|---|---|
| **Server never sees plaintext** | AES-GCM encryption is 100% client-side; ciphertext only is uploaded |
| **Key never transmitted** | Decryption key lives in the URL `#fragment`, stripped by browsers before any network request |
| **Password protection** | PBKDF2 derives an additional key from the password; the raw key is itself encrypted before going in the fragment; only the salt is stored on the server |
| **At-most-once access** | Cloudflare Durable Object provides a distributed lock; in-memory mode marks the share deleted on first retrieval |
| **TTL enforcement** | KV TTL (Cloudflare) or in-process timer (local); data is purged from RAM on expiry |
| **Rate limiting** | 3 shares / minute / IP; sliding window via Durable Object or in-process counter |
| **Supply-chain defence** | `pnpm-workspace.yaml` enforces `minimumReleaseAge: 1440` — packages must be ≥ 24 hours old before they can be installed |
| **No audit logging** | No share-access logs, no audit trails, no IP tracking. Startup and internal errors are logged to the terminal only; `DEBUG=true` enables verbose request logging for development |
| **Security headers** | HSTS, CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy |

---

## Contributing

1. Fork the repository and create a feature branch.
2. Install dependencies: `pnpm install`
3. Make your changes, then run the full test suite:
   ```bash
   pnpm --filter @workspace/ephemeral-share run test
   pnpm --filter @workspace/api-server run test
   pnpm run typecheck
   ```
4. Open a pull request against `main`. Please describe what you changed and why.

Bug reports and feature requests are welcome via [GitHub Issues](https://github.com/taifaq2-max/DropVault/issues).

---

## Licence

This project is released under the [MIT License](LICENSE).

---

> **VaultDrop does not persist any data.** All shares live in RAM. A server restart permanently destroys every active share. This is intentional — it is the security model.
