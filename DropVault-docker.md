# VaultDrop — Docker Deployment Guide

[![CI](https://github.com/taifaq2-max/DropVault/actions/workflows/ci.yml/badge.svg)](https://github.com/taifaq2-max/DropVault/actions/workflows/ci.yml)

Zero-knowledge ephemeral sharing, containerised. Two services: an **Express 5 API** and an **nginx** reverse proxy that serves the static frontend and terminates TLS.

---

## Architecture

```
Client (browser)
      │ HTTPS :443 (or HTTP :3000 in local mode)
      ▼
┌─────────────────────────────────────────────────────┐
│  nginx container  (vaultdrop-frontend)              │
│  • Serves /usr/share/nginx/html  (Vite static build)│
│  • Proxies /api/* → api:8080                        │
│  • TLS termination with your certificate            │
└──────────────────────┬──────────────────────────────┘
                       │ HTTP :8080  (internal Docker network only)
                       ▼
┌─────────────────────────────────────────────────────┐
│  api container  (vaultdrop-api)                     │
│  • Express 5, esbuild bundle                        │
│  • In-memory share store (ephemeral by design)      │
│  • Port 8080 is NOT exposed to the host             │
└─────────────────────────────────────────────────────┘
```

The API port **is never exposed to the host**. All external traffic flows through nginx.

---

## Prerequisites

| Requirement | Version |
|---|---|
| Docker Engine | ≥ 24 |
| Docker Compose | ≥ v2 (the `docker compose` plugin, not `docker-compose`) |
| Available ports | 80 + 443 (production) or 3000 (local) |

---

## Quick Start — Local Testing (no TLS)

Ideal for evaluating the app on a developer machine. No certificates needed.

**1. Clone the repository and enter it:**

```bash
git clone https://github.com/taifaq2-max/DropVault.git
cd DropVault
```

**2. Set a session secret (minimum step):**

```bash
echo "SESSION_SECRET=$(openssl rand -hex 64)" > .env
```

**3. Build and start:**

```bash
docker compose -f docker-compose.local.yml up -d --build
```

**4. Open the app:**

```
http://localhost:3000
```

**Stop:**

```bash
docker compose -f docker-compose.local.yml down
```

---

## Production Setup — TLS Required

### Step 1 — Configure environment variables

Copy the template and edit it:

```bash
cp .env.example .env
```

Open `.env` and set every value:

```dotenv
# A long random string — used to sign session cookies and internal tokens
SESSION_SECRET=<output of: openssl rand -hex 64>

# Absolute or relative paths on the HOST to your TLS files
TLS_CERT_PATH=/etc/letsencrypt/live/yourdomain.com/fullchain.pem
TLS_KEY_PATH=/etc/letsencrypt/live/yourdomain.com/privkey.pem

# Set to true to enable verbose API request logging
DEBUG=false
```

> **Never commit `.env` to version control.** It is listed in `.gitignore`.

---

### Step 2 — Provide TLS certificates

Choose one of the options below.

---

#### Option A — Let's Encrypt (recommended for public servers)

Install [certbot](https://certbot.eff.org/) on the host, stop any service on port 80, then:

```bash
sudo certbot certonly --standalone -d yourdomain.com
```

Certbot writes certificates to `/etc/letsencrypt/live/yourdomain.com/`. Set your `.env`:

```dotenv
TLS_CERT_PATH=/etc/letsencrypt/live/yourdomain.com/fullchain.pem
TLS_KEY_PATH=/etc/letsencrypt/live/yourdomain.com/privkey.pem
```

**Auto-renewal:** Add a cron job or systemd timer to renew and reload nginx:

```bash
# /etc/cron.d/certbot-vaultdrop
0 3 * * * root certbot renew --quiet && docker compose -f /path/to/DropVault/docker-compose.yml exec nginx nginx -s reload
```

---

#### Option B — Self-signed certificate (internal/staging only)

```bash
mkdir -p certs
openssl req -x509 -newkey rsa:4096 -sha256 -days 365 -nodes \
  -keyout certs/privkey.pem \
  -out certs/fullchain.pem \
  -subj "/CN=vaultdrop.local" \
  -addext "subjectAltName=DNS:vaultdrop.local,IP:127.0.0.1"
```

Keep the default `.env` paths (`./certs/fullchain.pem` / `./certs/privkey.pem`).

> Browsers will warn about the self-signed certificate. Add a security exception or install the cert as a trusted CA on your machine for local testing.

---

#### Option C — Bring your own certificate

Place your files anywhere on the host and point to them in `.env`:

```dotenv
TLS_CERT_PATH=/opt/certs/yourdomain.crt   # must include full chain
TLS_KEY_PATH=/opt/certs/yourdomain.key
```

The files are mounted **read-only** into the nginx container and never written to.

---

### Step 3 — Build and start

```bash
docker compose up -d --build
```

The first build downloads Node.js and installs all pnpm workspace dependencies inside the container; subsequent builds use the Docker layer cache and are much faster.

---

### Step 4 — Verify

```bash
# Check both containers are healthy
docker compose ps

# API health endpoint (through nginx)
curl -sk https://yourdomain.com/api/healthz

# Or directly on the internal port (from the host — only if you add a test expose)
# This port is intentionally NOT exposed in production.
```

---

## Environment Variables Reference

| Variable | Required | Default | Description |
|---|---|---|---|
| `SESSION_SECRET` | **Yes** | — | Signs session tokens. Use `openssl rand -hex 64`. Minimum 32 chars. |
| `HCAPTCHA_SECRET_KEY` | Production | — | hCaptcha server-side secret key. Obtain from [hcaptcha.com](https://dashboard.hcaptcha.com). Omit only in dev/testing. |
| `VITE_HCAPTCHA_SITE_KEY` | Production | — | hCaptcha public site key. Passed as a Docker **build argument** (not a runtime env var). See note below. |
| `TLS_CERT_PATH` | Production | `./certs/fullchain.pem` | Host path to TLS certificate (full chain PEM). |
| `TLS_KEY_PATH` | Production | `./certs/privkey.pem` | Host path to TLS private key PEM. |
| `DEBUG` | No | `false` | Set `true` to enable verbose request logging in the API. |
| `PORT` | Internal | `8080` | API listen port inside the container. Do not change unless you also update `nginx.conf`. |

> **hCaptcha build note:** `VITE_HCAPTCHA_SITE_KEY` is a Vite build-time variable — it gets baked into the static JS bundle, not read at runtime. Pass it when building the image:
> ```bash
> VITE_HCAPTCHA_SITE_KEY=your_site_key docker compose up -d --build
> # or add it to your shell environment / CI secrets before running compose
> ```
> The `docker-compose.yml` already reads it via `${VITE_HCAPTCHA_SITE_KEY:-}` and forwards it as a build arg. If the variable is absent, the captcha widget is hidden and the server skips verification (dev-only escape hatch).

---

## Container Management

```bash
# Start (production)
docker compose up -d --build

# Start (local, no TLS)
docker compose -f docker-compose.local.yml up -d --build

# View logs (tail all services)
docker compose logs -f

# View logs for one service
docker compose logs -f api
docker compose logs -f nginx

# Restart a single service (e.g. after cert renewal)
docker compose restart nginx

# Stop all containers (data is ephemeral anyway — shares live in RAM)
docker compose down

# Stop and remove images too
docker compose down --rmi all

# Shell into the API container (for debugging)
docker compose exec api sh

# Shell into the nginx container
docker compose exec nginx sh
```

---

## TLS Configuration Details

The `docker/nginx.conf` implements the **Mozilla Intermediate** TLS profile:

| Setting | Value |
|---|---|
| Protocols | TLS 1.2, TLS 1.3 |
| Cipher suites | ECDHE-ECDSA-AES128-GCM-SHA256, ECDHE-RSA-AES128-GCM-SHA256, ECDHE-ECDSA-AES256-GCM-SHA384, ECDHE-RSA-AES256-GCM-SHA384, ECDHE-ECDSA-CHACHA20-POLY1305, ECDHE-RSA-CHACHA20-POLY1305, DHE-RSA-AES128-GCM-SHA256 |
| Session cache | `shared:SSL:10m`, 1 day timeout |
| Session tickets | Disabled (forward secrecy) |
| OCSP stapling | Enabled |
| HSTS | `max-age=63072000; includeSubDomains; preload` |

Additional security headers sent on every response:

- `X-Frame-Options: DENY`
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: no-referrer`
- `Content-Security-Policy` (strict — no external sources)
- `Permissions-Policy: camera=(), microphone=(), geolocation=()`

To adjust any header or cipher, edit `docker/nginx.conf` and run `docker compose restart nginx`.

---

## File Layout

```
DropVault/
├── docker/
│   ├── Dockerfile.api        # Multi-stage: Node 24 build → slim runtime
│   ├── Dockerfile.frontend   # Multi-stage: Vite build → nginx:alpine runtime
│   ├── nginx.conf            # Production: TLS + security headers + proxy
│   └── nginx-local.conf      # Local dev: plain HTTP on :3000
├── docker-compose.yml        # Production (TLS, ports 80 + 443)
├── docker-compose.local.yml  # Local testing (no TLS, port 3000)
├── .env.example              # Template — copy to .env
├── .dockerignore             # Excludes node_modules, .git, certs, etc.
└── DropVault-docker.md       # This file
```

---

## Security Notes

| Topic | Detail |
|---|---|
| **API not exposed** | Port 8080 is on the internal Docker bridge only. There is no host binding — attack surface is nginx only. |
| **Ephemeral data** | Shares live in RAM. A container restart permanently destroys all active shares. This is intentional. |
| **Key never on server** | AES-GCM encryption key is in the URL fragment only. The API receives ciphertext, never plaintext or keys. |
| **Non-root user** | The API container runs as a dedicated `vaultdrop` user with no login shell. |
| **Read-only mounts** | TLS certs and nginx configs are mounted `:ro`. |
| **No database** | No persistent volume is declared. A container restart is a clean slate. |
| **Image scanning** | Run `docker scout cves vaultdrop-api` and `docker scout cves vaultdrop-frontend` to audit dependency CVEs. |

---

## Troubleshooting

**`nginx` exits immediately after starting:**  
The cert or key file cannot be read. Check that `TLS_CERT_PATH` / `TLS_KEY_PATH` exist on the host and that the paths in `.env` are correct. Run `docker compose logs nginx` for the exact error.

**API container never becomes healthy:**  
The `PORT` env var may be missing. Run `docker compose logs api`. Also confirm `SESSION_SECRET` is set.

**`pnpm install` fails during build:**  
The `pnpm-workspace.yaml` enforces a 1-day minimum package age (`minimumReleaseAge: 1440`). This is a supply-chain defence and cannot be disabled. If a very recently published dependency is required, wait 24 hours and rebuild.

**Self-signed cert browser warning:**  
Expected. Either import `certs/fullchain.pem` into your OS/browser trust store, or use a Let's Encrypt certificate for persistent testing.

**Port 443 already in use:**  
Another service (e.g. an existing nginx or Apache) is listening on 443. Stop it first, or change the host port in `docker-compose.yml` (e.g. `"8443:443"`) and update DNS accordingly.
