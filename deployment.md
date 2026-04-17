# VaultDrop — Deployment Guide

Step-by-step instructions for deploying VaultDrop on **Cloudflare** (two options) and as a **Microsoft Teams** app.

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Part 1 — Cloudflare Deployment](#part-1--cloudflare-deployment)
   - [Option A: Cloudflare Tunnel (Recommended)](#option-a-cloudflare-tunnel-recommended)
   - [Option B: Cloudflare DNS Proxy + TLS](#option-b-cloudflare-dns-proxy--tls)
3. [Part 2 — Microsoft Teams Deployment](#part-2--microsoft-teams-deployment)

---

## Prerequisites

The following are required for all deployment scenarios.

| Requirement | Notes |
|---|---|
| Linux VPS | Ubuntu 22.04 LTS recommended. 1 vCPU / 1 GB RAM minimum. |
| Docker Engine ≥ 24 | See [install guide](https://docs.docker.com/engine/install/ubuntu/) |
| Docker Compose v2 | Bundled with Docker Engine ≥ 23 (`docker compose`, not `docker-compose`) |
| Domain name | Any registrar — DNS must be managed through Cloudflare |
| Cloudflare account | Free tier is sufficient for both options |
| hCaptcha keys | Register at [dashboard.hcaptcha.com](https://dashboard.hcaptcha.com) — free tier OK |
| Git | `sudo apt install git` |

---

## Part 1 — Cloudflare Deployment

Two approaches are documented. **Option A (Cloudflare Tunnel)** is strongly recommended — it requires no open firewall ports, no TLS certificate management, and works even from a private network.

### Option A: Cloudflare Tunnel (Recommended)

Cloudflare Tunnel creates an outbound-only connection from your server to Cloudflare's edge. No inbound ports need to be opened. Cloudflare handles all TLS termination.

```
Internet (HTTPS) → Cloudflare Edge → cloudflared tunnel → nginx:80 (Docker, no TLS)
```

#### Step 1 — Provision the server

Log in to your VPS and create a non-root user if needed:

```bash
adduser vaultdrop
usermod -aG sudo vaultdrop
usermod -aG docker vaultdrop
su - vaultdrop
```

#### Step 2 — Install Docker

```bash
curl -fsSL https://get.docker.com | sh
sudo systemctl enable --now docker
```

#### Step 3 — Clone the repository

```bash
git clone https://github.com/taifaq2-max/DropVault.git
cd DropVault
```

#### Step 4 — Create the environment file

```bash
cp .env.example .env
nano .env
```

Fill in the required values:

```dotenv
SESSION_SECRET=<output of: openssl rand -hex 64>
HCAPTCHA_SECRET_KEY=<your hCaptcha secret key>
VITE_HCAPTCHA_SITE_KEY=<your hCaptcha site key>
DEBUG=false
```

> `TLS_CERT_PATH` and `TLS_KEY_PATH` are NOT needed with Cloudflare Tunnel.

#### Step 5 — Create a Cloudflare Tunnel nginx config

Cloudflare Tunnel terminates TLS at the edge, so nginx runs without certificates. Create a dedicated compose override:

```bash
nano docker-compose.tunnel.yml
```

Paste the following:

```yaml
services:
  api:
    build:
      context: .
      dockerfile: docker/Dockerfile.api
    image: vaultdrop-api
    restart: unless-stopped
    environment:
      PORT: "8080"
      NODE_ENV: production
      SESSION_SECRET: ${SESSION_SECRET}
      HCAPTCHA_SECRET_KEY: ${HCAPTCHA_SECRET_KEY}
      DEBUG: ${DEBUG:-false}
    networks:
      - internal
    healthcheck:
      test:
        - CMD
        - node
        - -e
        - "require('http').get('http://localhost:8080/api/healthz',r=>{process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))"
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 15s

  nginx:
    build:
      context: .
      dockerfile: docker/Dockerfile.frontend
      args:
        VITE_HCAPTCHA_SITE_KEY: ${VITE_HCAPTCHA_SITE_KEY:-}
    image: vaultdrop-frontend
    restart: unless-stopped
    ports:
      - "127.0.0.1:8000:80"       # bind only on loopback — not publicly reachable
    volumes:
      - ./docker/nginx-local.conf:/etc/nginx/conf.d/default.conf:ro
    depends_on:
      api:
        condition: service_healthy
    networks:
      - internal

networks:
  internal:
    driver: bridge
```

> The port binding `127.0.0.1:8000:80` ensures nginx is only reachable from localhost — the tunnel will connect to it from the same machine.

#### Step 6 — Start the Docker stack

```bash
VITE_HCAPTCHA_SITE_KEY=$(grep VITE_HCAPTCHA_SITE_KEY .env | cut -d= -f2) \
  docker compose -f docker-compose.tunnel.yml up -d --build
```

Verify both containers are healthy:

```bash
docker compose -f docker-compose.tunnel.yml ps
curl -s http://localhost:8000/api/healthz
```

Expected: `{"status":"healthy"}` or similar.

#### Step 7 — Install cloudflared

```bash
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb \
  -o cloudflared.deb
sudo dpkg -i cloudflared.deb
cloudflared --version
```

#### Step 8 — Authenticate with Cloudflare

```bash
cloudflared tunnel login
```

A URL is printed. Open it in your browser, log in to Cloudflare, and select the domain you want to use. A certificate file is saved at `~/.cloudflared/cert.pem`.

#### Step 9 — Create the tunnel

```bash
cloudflared tunnel create vaultdrop
```

Note the **Tunnel ID** printed (e.g., `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`).

#### Step 10 — Configure the tunnel

```bash
mkdir -p ~/.cloudflared
nano ~/.cloudflared/config.yml
```

Paste (replacing the values in `< >`):

```yaml
tunnel: <Tunnel ID from Step 9>
credentials-file: /home/vaultdrop/.cloudflared/<Tunnel ID>.json

ingress:
  - hostname: vaultdrop.yourdomain.com
    service: http://localhost:8000
  - service: http_status:404
```

#### Step 11 — Create the DNS record

```bash
cloudflared tunnel route dns vaultdrop vaultdrop.yourdomain.com
```

This creates a `CNAME` record in Cloudflare DNS pointing `vaultdrop.yourdomain.com` to the tunnel automatically.

#### Step 12 — Run cloudflared as a system service

```bash
sudo cloudflared service install
sudo systemctl enable --now cloudflared
sudo systemctl status cloudflared
```

VaultDrop is now live at `https://vaultdrop.yourdomain.com`.

#### Step 13 — Cloudflare dashboard hardening (recommended)

In the Cloudflare dashboard for your domain:

| Setting | Location | Value |
|---|---|---|
| SSL/TLS encryption mode | SSL/TLS → Overview | **Full** |
| Always Use HTTPS | SSL/TLS → Edge Certificates | **On** |
| Minimum TLS version | SSL/TLS → Edge Certificates | **TLS 1.2** |
| Bot Fight Mode | Security → Bots | **On** |
| Under Attack Mode | Security → Overview | Enable during incidents |

---

### Option B: Cloudflare DNS Proxy + TLS

Use this if you prefer traditional TLS termination on the server itself. Cloudflare proxies traffic through its CDN and you manage your own certificates.

```
Internet (HTTPS) → Cloudflare Edge → VPS :443 (nginx, TLS) → api:8080
```

#### Step 1 — Complete Steps 1–4 from Option A

Clone the repo and create the `.env` file as described above.

#### Step 2 — Open firewall ports

```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

#### Step 3 — Obtain a TLS certificate with certbot

```bash
sudo apt install certbot -y
sudo certbot certonly --standalone -d vaultdrop.yourdomain.com
```

Certificates are saved to `/etc/letsencrypt/live/vaultdrop.yourdomain.com/`.

Update `.env`:

```dotenv
TLS_CERT_PATH=/etc/letsencrypt/live/vaultdrop.yourdomain.com/fullchain.pem
TLS_KEY_PATH=/etc/letsencrypt/live/vaultdrop.yourdomain.com/privkey.pem
```

#### Step 4 — Start the production stack

```bash
VITE_HCAPTCHA_SITE_KEY=$(grep VITE_HCAPTCHA_SITE_KEY .env | cut -d= -f2) \
  docker compose up -d --build
```

#### Step 5 — Set up automatic certificate renewal

```bash
sudo crontab -e
```

Add the following line:

```
0 3 * * * certbot renew --quiet && docker compose -f /home/vaultdrop/DropVault/docker-compose.yml exec nginx nginx -s reload
```

#### Step 6 — Configure Cloudflare DNS

In the Cloudflare dashboard → **DNS** → **Records**:

| Type | Name | Content | Proxy |
|---|---|---|---|
| A | `vaultdrop` | `<your VPS IP>` | **Proxied (orange cloud)** |

#### Step 7 — Configure Cloudflare SSL

In the Cloudflare dashboard → **SSL/TLS** → **Overview**:

Set encryption mode to **Full (Strict)**.

> Full (Strict) requires a valid certificate on the origin server. This is what certbot provides.

---

## Part 2 — Microsoft Teams Deployment

Add VaultDrop as a tab inside Microsoft Teams. Users can access it directly from the Teams sidebar or a channel tab without leaving Teams.

> **Prerequisite:** VaultDrop must be deployed over HTTPS first. Complete Part 1 before continuing.

### Step 1 — Update nginx to allow Teams iframe embedding

By default, VaultDrop sets `X-Frame-Options: DENY` and `frame-ancestors 'none'` in the CSP, which blocks iframe embedding. Teams embeds tabs as iframes, so these headers must be updated.

Create a new nginx config for Teams:

```bash
nano docker/nginx-teams.conf
```

Paste the full contents of `docker/nginx.conf` and make **two changes** only:

**Change 1** — Replace the `X-Frame-Options` line:

```nginx
# Remove this line entirely (or comment it out):
# add_header X-Frame-Options "DENY" always;
```

**Change 2** — Replace `frame-ancestors 'none'` in the CSP header with Teams domains:

```nginx
add_header Content-Security-Policy
    "default-src 'self'; script-src 'self' 'unsafe-inline' https://js.hcaptcha.com; style-src 'self' 'unsafe-inline' https://newassets.hcaptcha.com; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' https://hcaptcha.com https://api.hcaptcha.com; worker-src 'self' blob:; frame-src https://newassets.hcaptcha.com https://assets.hcaptcha.com; frame-ancestors https://teams.microsoft.com https://*.teams.microsoft.com https://*.office.com https://*.skype.com;"
    always;
```

> This CSP is also updated to allow the hCaptcha widget's own iframes, which are needed for the captcha to render inside Teams.

Mount this config in your docker compose file by changing the nginx volume:

```yaml
volumes:
  - ./docker/nginx-teams.conf:/etc/nginx/conf.d/default.conf:ro
```

Rebuild and restart:

```bash
docker compose up -d --build nginx
```

### Step 2 — Create app icons

Teams requires two PNG icons. Create them at the correct sizes:

| File | Size | Usage |
|---|---|---|
| `teams/icon-color.png` | 192 × 192 px | Full-color icon shown in app listings |
| `teams/icon-outline.png` | 32 × 32 px | Single-color white icon shown in the sidebar |

```bash
mkdir teams
```

You can create simple icons using any image editor or online tool. The outline icon must be white on a transparent background.

### Step 3 — Create the Teams app manifest

```bash
nano teams/manifest.json
```

Paste the following (replace all `<placeholder>` values):

```json
{
  "$schema": "https://developer.microsoft.com/json-schemas/teams/v1.17/MicrosoftTeams.schema.json",
  "manifestVersion": "1.17",
  "version": "1.0.0",
  "id": "<generate a GUID: https://www.guidgenerator.com>",
  "packageName": "com.yourorg.vaultdrop",
  "developer": {
    "name": "<Your Name or Organization>",
    "websiteUrl": "https://vaultdrop.yourdomain.com",
    "privacyUrl": "https://vaultdrop.yourdomain.com",
    "termsOfUseUrl": "https://vaultdrop.yourdomain.com"
  },
  "name": {
    "short": "VaultDrop",
    "full": "VaultDrop — Secure Ephemeral Sharing"
  },
  "description": {
    "short": "Share secrets securely. One-time, zero-knowledge.",
    "full": "VaultDrop encrypts files and text in your browser before uploading. Links self-destruct after one access. Nothing is ever stored in plaintext."
  },
  "icons": {
    "color": "icon-color.png",
    "outline": "icon-outline.png"
  },
  "accentColor": "#00FFFF",
  "staticTabs": [
    {
      "entityId": "vaultdrop-sender",
      "name": "New Secure Share",
      "contentUrl": "https://vaultdrop.yourdomain.com/",
      "websiteUrl": "https://vaultdrop.yourdomain.com/",
      "scopes": ["personal"]
    }
  ],
  "configurableTabs": [
    {
      "configurationUrl": "https://vaultdrop.yourdomain.com/",
      "canUpdateConfiguration": false,
      "scopes": ["team", "groupchat"]
    }
  ],
  "permissions": ["identity", "messageTeamMembers"],
  "validDomains": [
    "vaultdrop.yourdomain.com"
  ],
  "webApplicationInfo": {
    "id": "<same GUID as above>",
    "resource": "https://vaultdrop.yourdomain.com"
  }
}
```

> Generate a unique GUID at [guidgenerator.com](https://www.guidgenerator.com) and use it in both the `id` and `webApplicationInfo.id` fields.

### Step 4 — Package the Teams app

The Teams app is a `.zip` file containing exactly three files at the root (no subdirectory):

```bash
cd teams
zip vaultdrop-teams.zip manifest.json icon-color.png icon-outline.png
```

Verify the structure:

```bash
unzip -l vaultdrop-teams.zip
```

Expected output:

```
  manifest.json
  icon-color.png
  icon-outline.png
```

### Step 5 — Sideload for your organization

There are two paths depending on your Teams admin access level.

#### Option 1: Upload directly (if admin or sideloading is enabled)

1. Open Microsoft Teams desktop or web app.
2. Go to **Apps** in the left sidebar.
3. Click **Manage your apps** → **Upload an app**.
4. Select **Upload a custom app**.
5. Select the `vaultdrop-teams.zip` file.
6. Click **Add** on the app preview screen.

#### Option 2: Deploy organization-wide via Teams Admin Center

1. Go to [Teams Admin Center](https://admin.teams.microsoft.com).
2. Navigate to **Teams apps** → **Manage apps**.
3. Click **Upload new app** → upload `vaultdrop-teams.zip`.
4. Once uploaded, go to **Teams apps** → **Setup policies**.
5. Edit the **Global (Org-wide default)** policy.
6. Under **Installed apps** or **Pinned apps**, add VaultDrop.
7. Click **Save** — the app rolls out to all users within 24 hours.

### Step 6 — Using VaultDrop in Teams

Once installed, the VaultDrop tab behaves like the standalone web app:

- **Personal tab**: Click VaultDrop in the left sidebar → create and share encrypted content.
- **Channel tab**: Pin it to a Teams channel so the whole team can create shares.
- **Receiver links** work in any browser — the recipient does not need Teams installed.

> Receiver links contain the decryption key in the URL fragment (`#key=…`). Pasting them into a Teams chat is safe because URL fragments are never sent to the server and are stripped from link previews.

---

## Environment Variable Summary

| Variable | Where | Notes |
|---|---|---|
| `SESSION_SECRET` | Server | `openssl rand -hex 64`. Required. |
| `HCAPTCHA_SECRET_KEY` | Server (runtime) | From hCaptcha dashboard. Required in production. |
| `VITE_HCAPTCHA_SITE_KEY` | Server (build-time) | From hCaptcha dashboard. Passed as Docker build arg. |
| `TLS_CERT_PATH` | Server | Option B only. Path to fullchain.pem on the host. |
| `TLS_KEY_PATH` | Server | Option B only. Path to privkey.pem on the host. |
| `DEBUG` | Server | Set `true` to enable request logging. Default: `false`. |

---

## Upgrading

```bash
cd DropVault
git pull
docker compose -f <your-compose-file> up -d --build
```

> Because shares are stored in-memory, **all active shares are lost on restart**. This is by design.
