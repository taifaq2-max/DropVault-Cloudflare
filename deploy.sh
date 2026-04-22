#!/usr/bin/env bash
# =============================================================================
# deploy.sh — Interactive VaultDrop Cloudflare Deployment Script
#
# Usage:  bash deploy.sh
# Run from the repository root.  No prior Cloudflare knowledge required.
# =============================================================================
set -euo pipefail
IFS=$'\n\t'

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CF_DIR="$REPO_ROOT/artifacts/cloudflare"
FE_DIR="$REPO_ROOT/artifacts/ephemeral-share"
WRANGLER_TOML="$CF_DIR/wrangler.toml"

# ── colours (disabled when not a terminal) ───────────────────────────────────
if [[ -t 1 ]]; then
  RED='\033[0;31m' GREEN='\033[0;32m' YELLOW='\033[1;33m'
  BLUE='\033[0;34m' BOLD='\033[1m' NC='\033[0m'
else
  RED='' GREEN='' YELLOW='' BLUE='' BOLD='' NC=''
fi

info()    { echo -e "${BLUE}  ○${NC}  $*"; }
success() { echo -e "${GREEN}  ✔${NC}  $*"; }
warn()    { echo -e "${YELLOW}  ⚠${NC}  $*"; }
error()   { echo -e "${RED}  ✖${NC}  $*" >&2; }
header()  { echo -e "\n${BOLD}${BLUE}━━  $*${NC}"; }
die()     { error "$*"; exit 1; }

# run_step: run a command and exit with the real exit code on failure
run_step() {
  local label="$1"; shift
  info "$label"
  local rc=0
  "$@" || rc=$?
  if [[ "$rc" -ne 0 ]]; then
    die "$label failed (exit $rc)."
  fi
}

# Portable sed -i (macOS requires an empty-string arg; Linux does not)
sedi() {
  if [[ "$(uname)" == "Darwin" ]]; then
    sed -i '' "$@"
  else
    sed -i "$@"
  fi
}

# ── 1. Prerequisite checks (no wrangler yet — installed by pnpm) ─────────────
header "Checking prerequisites"

MISSING=0

for cmd in git pnpm openssl python3; do
  if command -v "$cmd" &>/dev/null; then
    success "$cmd  $(command "$cmd" --version 2>/dev/null | head -1)"
  else
    error "$cmd not found"
    MISSING=1
  fi
done

if command -v node &>/dev/null; then
  NODE_VER=$(node --version | sed 's/v//' | cut -d. -f1)
  if [[ "$NODE_VER" -lt 20 ]]; then
    error "Node.js 20+ required (found v${NODE_VER}). Update at https://nodejs.org"
    MISSING=1
  else
    success "node  $(node --version)"
  fi
else
  error "node not found — install from https://nodejs.org"
  MISSING=1
fi

[[ "$MISSING" -eq 1 ]] && die "Fix the issues above, then rerun."

# ── 2. Install dependencies (makes local wrangler binary available) ───────────
header "Installing dependencies"
cd "$REPO_ROOT"
run_step "pnpm install" pnpm install
success "Dependencies ready"

# ── 3. Resolve wrangler + authenticate ───────────────────────────────────────
# Prefer the workspace-local binary installed by pnpm above
WRANGLER=""
if [[ -x "$CF_DIR/node_modules/.bin/wrangler" ]]; then
  WRANGLER="$CF_DIR/node_modules/.bin/wrangler"
elif command -v wrangler &>/dev/null; then
  WRANGLER="wrangler"
else
  die "wrangler not found even after pnpm install. Check artifacts/cloudflare/package.json."
fi
success "wrangler  $($WRANGLER --version 2>/dev/null | head -1)"

info "Checking Cloudflare authentication…"
if ! $WRANGLER whoami &>/dev/null 2>&1; then
  warn "Not logged in. Running 'wrangler login'…"
  $WRANGLER login || die "Authentication failed."
fi
success "Cloudflare authentication OK"

# ── 4. Interactive prompts ───────────────────────────────────────────────────
header "Configuration"
echo
echo "  Press Enter to accept defaults shown in [brackets]."
echo "  Secret fields are masked (you won't see the characters as you type)."
echo

# Account ID
read -r -p "  Cloudflare Account ID: " CF_ACCOUNT_ID
CF_ACCOUNT_ID="${CF_ACCOUNT_ID// /}"
[[ -z "$CF_ACCOUNT_ID" ]] && die "Account ID is required. Find it at: https://dash.cloudflare.com → right sidebar."

# API token (REST API — Pages env vars + R2 CORS)
echo
echo "  An API token is needed for setting Pages env vars and R2 CORS rules."
echo "  Create one at https://dash.cloudflare.com/profile/api-tokens with:"
echo "    Cloudflare Pages : Edit"
echo "    Workers R2 Storage : Edit"
read -rs -p "  Cloudflare API Token (hidden): " CF_API_TOKEN; echo
CF_API_TOKEN="${CF_API_TOKEN// /}"
[[ -z "$CF_API_TOKEN" ]] && die "API token is required."

# Worker name
echo
read -r -p "  Worker name [vaultdrop-api]: " WORKER_NAME
WORKER_NAME="${WORKER_NAME:-vaultdrop-api}"
WORKER_NAME="${WORKER_NAME// /}"

# R2 bucket name
read -r -p "  R2 bucket name [vaultdrop-shares]: " R2_BUCKET
R2_BUCKET="${R2_BUCKET:-vaultdrop-shares}"
R2_BUCKET="${R2_BUCKET// /}"

# Pages project name
read -r -p "  Cloudflare Pages project name [vaultdrop]: " PAGES_PROJECT
PAGES_PROJECT="${PAGES_PROJECT:-vaultdrop}"
PAGES_PROJECT="${PAGES_PROJECT// /}"

# Routing option
echo
echo "  Routing options:"
echo "    A) Custom domain + Worker Routes  (recommended; requires a domain on Cloudflare)"
echo "       /api/* is served by the Worker at the same origin — no cross-origin calls."
echo "    B) Pages Function proxy  (no custom domain; works with *.pages.dev)"
echo "       The included Pages Function forwards /api/* to the Worker."
echo
read -r -p "  Routing option [B]: " ROUTING_OPTION
ROUTING_OPTION="${ROUTING_OPTION:-B}"
ROUTING_OPTION="${ROUTING_OPTION^^}"
[[ "$ROUTING_OPTION" != "A" && "$ROUTING_OPTION" != "B" ]] && die "Enter A or B."

CUSTOM_DOMAIN=""
FRONTEND_URL=""
if [[ "$ROUTING_OPTION" == "A" ]]; then
  read -r -p "  Custom domain (e.g. vaultdrop.example.com): " CUSTOM_DOMAIN
  CUSTOM_DOMAIN="${CUSTOM_DOMAIN// /}"
  [[ -z "$CUSTOM_DOMAIN" ]] && die "Custom domain is required for Option A."
  FRONTEND_URL="https://$CUSTOM_DOMAIN"
fi

# SESSION_SECRET
echo
read -rs -p "  SESSION_SECRET (Enter to auto-generate): " SESSION_SECRET_IN; echo
if [[ -z "$SESSION_SECRET_IN" ]]; then
  SESSION_SECRET=$(openssl rand -hex 64)
  info "Auto-generated SESSION_SECRET."
else
  SESSION_SECRET="$SESSION_SECRET_IN"
fi
unset SESSION_SECRET_IN

# hCaptcha
echo
read -rs -p "  hCaptcha secret key (hidden, Enter to skip CAPTCHA): " HCAPTCHA_SECRET_KEY; echo
HCAPTCHA_SITE_KEY=""
if [[ -n "$HCAPTCHA_SECRET_KEY" ]]; then
  read -r -p "  hCaptcha site key (public widget key, not secret): " HCAPTCHA_SITE_KEY
fi

# R2 large-file support
echo
echo "  Large-file (>4 MB, up to 420 MB) uploads require R2 API credentials."
echo "  Create an R2 API token at: Cloudflare Dashboard → R2 → Manage R2 API Tokens"
echo "  Required permission: Object Read & Write, scoped to bucket '$R2_BUCKET'."
read -r -p "  Enable large-file R2 uploads? [y/N]: " ENABLE_R2
ENABLE_R2="${ENABLE_R2:-N}"
ENABLE_R2="${ENABLE_R2^^}"

R2_KEY_ID="" R2_KEY_SECRET=""
if [[ "$ENABLE_R2" == "Y" ]]; then
  read -r  -p "  R2 Access Key ID: " R2_KEY_ID
  read -rs -p "  R2 Secret Access Key (hidden): " R2_KEY_SECRET; echo
  [[ -z "$R2_KEY_ID" || -z "$R2_KEY_SECRET" ]] && die "Both R2 credentials are required when large-file uploads are enabled."
fi

echo
info "All inputs collected.  Starting deployment…"

# ── 4. Patch worker name in wrangler.toml BEFORE any wrangler commands ───────
#       (wrangler derives KV namespace titles from the name in wrangler.toml)
header "Patching wrangler.toml"
sedi "s|^name = \"vaultdrop-api\"|name = \"$WORKER_NAME\"|" "$WRANGLER_TOML"
sedi "s|CLOUDFLARE_ACCOUNT_ID = \"\"|CLOUDFLARE_ACCOUNT_ID = \"$CF_ACCOUNT_ID\"|g" "$WRANGLER_TOML"
sedi "s|bucket_name = \"vaultdrop-shares\"|bucket_name = \"$R2_BUCKET\"|g" "$WRANGLER_TOML"
sedi "s|R2_BUCKET_NAME = \"vaultdrop-shares\"|R2_BUCKET_NAME = \"$R2_BUCKET\"|g" "$WRANGLER_TOML"
if [[ "$ROUTING_OPTION" == "A" ]]; then
  sedi "s|^FRONTEND_URL = \"\"|FRONTEND_URL = \"$FRONTEND_URL\"|" "$WRANGLER_TOML"
fi
success "wrangler.toml patched (worker name, account ID, bucket)"

# ── 5. KV namespace provisioning ────────────────────────────────────────────
header "Provisioning KV namespaces"

# Returns the 32-char hex ID for a KV namespace, creating it if needed.
provision_kv() {
  local binding="$1"         # e.g. SHARE_KV
  local preview="${2:-false}" # "true" | "false"

  # wrangler derives the namespace title as "<worker_name>-<binding>[_preview]"
  local title="${WORKER_NAME}-${binding}"
  [[ "$preview" == "true" ]] && title="${title}_preview"

  local create_args=("$binding")
  [[ "$preview" == "true" ]] && create_args+=("--preview")

  local out id
  # Attempt creation (may fail if namespace already exists — that's OK)
  out=$(cd "$CF_DIR" && $WRANGLER kv namespace create "${create_args[@]}" 2>&1) || true

  # Parse the "id = '...'" line from wrangler's TOML-snippet output
  id=$(echo "$out" | grep -E "^\s*id\s*=" | head -1 | grep -oE '[a-f0-9]{32}' | head -1 || true)

  if [[ -z "$id" ]]; then
    # Fall back: list all namespaces and match by title
    info "  '$title' may already exist — scanning namespace list for its ID…"
    local list_out
    list_out=$(cd "$CF_DIR" && $WRANGLER kv namespace list 2>&1) || true
    # Works for both table (│ title │ id │) and JSON ([{"title":"...","id":"..."}]) output
    id=$(echo "$list_out" | grep -F "$title" | grep -oE '[a-f0-9]{32}' | head -1 || true)
  fi

  if [[ -z "$id" ]]; then
    error "Could not determine ID for KV namespace '$title'."
    error "wrangler output was:"
    echo "$out" >&2
    die "Please create the namespace manually and update wrangler.toml, then rerun."
  fi

  echo "$id"
}

KV_ID=$(provision_kv "SHARE_KV" "false")
success "Production KV ID: $KV_ID"

KV_PREVIEW_ID=$(provision_kv "SHARE_KV" "true")
success "Preview KV ID:    $KV_PREVIEW_ID"

sedi "s|REPLACE_WITH_YOUR_KV_NAMESPACE_ID|$KV_ID|g" "$WRANGLER_TOML"
sedi "s|REPLACE_WITH_YOUR_KV_NAMESPACE_PREVIEW_ID|$KV_PREVIEW_ID|g" "$WRANGLER_TOML"
success "wrangler.toml KV IDs patched"

# ── 6. R2 bucket provisioning ─────────────────────────────────────────────────
header "Provisioning R2 bucket"

info "Creating R2 bucket '$R2_BUCKET' (no-op if it already exists)…"
# R2 bucket creation is idempotent — a non-zero exit just means it already exists
cd "$CF_DIR" && $WRANGLER r2 bucket create "$R2_BUCKET" 2>&1 || \
  warn "  Bucket creation returned non-zero — it likely already exists, continuing."
success "R2 bucket '$R2_BUCKET' ready"

# ── 7. Worker secrets ─────────────────────────────────────────────────────────
header "Setting Worker secrets"
cd "$CF_DIR"

pipe_secret() {
  local name="$1" value="$2"
  if ! echo "$value" | $WRANGLER secret put "$name" 2>&1; then
    die "Failed to set secret '$name'."
  fi
  success "  $name set"
}

pipe_secret "SESSION_SECRET"      "$SESSION_SECRET"
[[ -n "$HCAPTCHA_SECRET_KEY" ]] && pipe_secret "HCAPTCHA_SECRET_KEY"  "$HCAPTCHA_SECRET_KEY"
[[ -n "$R2_KEY_ID" ]]           && pipe_secret "R2_ACCESS_KEY_ID"     "$R2_KEY_ID"
[[ -n "$R2_KEY_SECRET" ]]       && pipe_secret "R2_ACCESS_KEY_SECRET" "$R2_KEY_SECRET"

# ── 8. Deploy Worker ──────────────────────────────────────────────────────────
header "Deploying Worker"
cd "$CF_DIR"

DEPLOY_OUT=""
if ! DEPLOY_OUT=$($WRANGLER deploy 2>&1); then
  echo "$DEPLOY_OUT" >&2
  die "Worker deployment failed."
fi
echo "$DEPLOY_OUT" | tail -6

WORKER_URL=$(echo "$DEPLOY_OUT" | grep -oE 'https://[a-zA-Z0-9._-]+\.workers\.dev' | head -1 || true)
if [[ -z "$WORKER_URL" ]]; then
  WORKER_URL="https://${WORKER_NAME}.${CF_ACCOUNT_ID}.workers.dev"
  warn "Could not auto-detect Worker URL — using: $WORKER_URL"
fi
success "Worker live at: $WORKER_URL"

# ── 9. Frontend build ─────────────────────────────────────────────────────────
header "Building frontend"
cd "$REPO_ROOT"

[[ -n "$HCAPTCHA_SITE_KEY" ]] && export VITE_HCAPTCHA_SITE_KEY="$HCAPTCHA_SITE_KEY"
[[ "$ENABLE_R2" == "Y" ]]     && export VITE_USE_R2_UPLOADS="true"

if ! pnpm --filter @workspace/ephemeral-share run build 2>&1; then
  die "Frontend build failed."
fi
success "Frontend built → artifacts/ephemeral-share/dist/public"

# ── 10. Deploy to Cloudflare Pages ────────────────────────────────────────────
header "Deploying to Cloudflare Pages"
cd "$REPO_ROOT"

PAGES_OUT=""
if ! PAGES_OUT=$($WRANGLER pages deploy "$FE_DIR/dist/public" \
    --project-name "$PAGES_PROJECT" 2>&1); then
  echo "$PAGES_OUT" >&2
  die "Pages deployment failed."
fi
echo "$PAGES_OUT" | tail -6

PAGES_URL=$(echo "$PAGES_OUT" | grep -oE 'https://[a-zA-Z0-9._-]+\.pages\.dev' | head -1 || true)
if [[ -z "$PAGES_URL" ]]; then
  PAGES_URL="https://${PAGES_PROJECT}.pages.dev"
  warn "Could not auto-detect Pages URL — using: $PAGES_URL"
fi
success "Frontend live at: $PAGES_URL"

# ── 11. Option B: back-fill FRONTEND_URL + redeploy Worker ───────────────────
if [[ "$ROUTING_OPTION" == "B" ]]; then
  header "Updating Worker CORS origin (Option B)"
  FRONTEND_URL="$PAGES_URL"
  sedi "s|^FRONTEND_URL = \"\"|FRONTEND_URL = \"$FRONTEND_URL\"|" "$WRANGLER_TOML"
  info "Redeploying Worker with FRONTEND_URL=$FRONTEND_URL…"
  cd "$CF_DIR"
  if ! $WRANGLER deploy 2>&1 | tail -3; then
    die "Worker redeploy (CORS update) failed."
  fi
  success "Worker redeployed with updated CORS origin"
fi

# ── 12. Set Pages environment variables via REST API ─────────────────────────
header "Setting Pages environment variables"

# Build env_vars JSON — python3 handles correct escaping of any input values
PAGES_ENV_JSON=$(python3 - "$WORKER_URL" "$HCAPTCHA_SITE_KEY" "$ROUTING_OPTION" "$ENABLE_R2" <<'PYEOF'
import json, sys
worker_url, hcaptcha_site_key, routing, enable_r2 = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]

env_vars = {}

# VITE_API_URL — set to Worker URL so the frontend knows where the API is.
# For Option A/B routing (relative /api/* paths) this acts as an explicit
# fallback; unset it in Pages settings if you want to rely purely on routing.
env_vars["VITE_API_URL"] = {"value": worker_url}

if enable_r2 == "Y":
    env_vars["VITE_USE_R2_UPLOADS"] = {"value": "true"}

if hcaptcha_site_key:
    env_vars["VITE_HCAPTCHA_SITE_KEY"] = {"value": hcaptcha_site_key}

# WORKER_URL is only needed for Option B (Pages Function proxy)
if routing == "B":
    env_vars["WORKER_URL"] = {"value": worker_url, "type": "secret_text"}

body = {
    "deployment_configs": {
        "production": {"env_vars": env_vars},
        "preview":    {"env_vars": env_vars},
    }
}
print(json.dumps(body))
PYEOF
)

CF_PAGES_RESP=$(curl -s -X PATCH \
  "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/pages/projects/${PAGES_PROJECT}" \
  -H "Authorization: Bearer ${CF_API_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "$PAGES_ENV_JSON")

if python3 -c "import json,sys; d=json.load(sys.stdin); exit(0 if d.get('success') else 1)" \
    <<< "$CF_PAGES_RESP" 2>/dev/null; then
  success "Pages environment variables updated"
else
  warn "Pages env var update may have failed. Response:"
  python3 -m json.tool <<< "$CF_PAGES_RESP" 2>/dev/null || echo "$CF_PAGES_RESP"
  warn "Set them manually: Dashboard → Pages → $PAGES_PROJECT → Settings → Environment variables"
fi

# ── 13. R2 CORS policy ────────────────────────────────────────────────────────
if [[ -n "$R2_KEY_ID" && -n "$FRONTEND_URL" ]]; then
  header "Setting R2 CORS policy"

  R2_CORS_JSON=$(python3 - "$FRONTEND_URL" <<'PYEOF'
import json, sys
origin = sys.argv[1]
print(json.dumps([{
    "AllowedOrigins": [origin],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["Content-Type"],
    "MaxAgeSeconds": 3600,
}]))
PYEOF
  )

  CF_CORS_RESP=$(curl -s -X PUT \
    "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/r2/buckets/${R2_BUCKET}/cors" \
    -H "Authorization: Bearer ${CF_API_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "$R2_CORS_JSON")

  if python3 -c "import json,sys; d=json.load(sys.stdin); exit(0 if d.get('success') else 1)" \
      <<< "$CF_CORS_RESP" 2>/dev/null; then
    success "R2 CORS policy set (PUT allowed from $FRONTEND_URL)"
  else
    warn "R2 CORS policy update may have failed:"
    python3 -m json.tool <<< "$CF_CORS_RESP" 2>/dev/null || echo "$CF_CORS_RESP"
    warn "Set it manually in Dashboard → R2 → $R2_BUCKET → Settings → CORS"
  fi
fi

# ── 14. Final Pages redeploy with updated env vars ────────────────────────────
header "Final Pages redeploy"
info "Redeploying frontend so the new environment variables take effect…"
cd "$REPO_ROOT"
if ! $WRANGLER pages deploy "$FE_DIR/dist/public" \
    --project-name "$PAGES_PROJECT" 2>&1 | tail -4; then
  die "Final Pages redeploy failed."
fi
success "Frontend redeployed with updated environment"

# ── 15. Summary ───────────────────────────────────────────────────────────────
echo
echo -e "${BOLD}${GREEN}╔══════════════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}${GREEN}║       VaultDrop deployed successfully!                   ║${NC}"
echo -e "${BOLD}${GREEN}╚══════════════════════════════════════════════════════════╝${NC}"
echo
echo -e "  ${BOLD}Worker URL:${NC}    $WORKER_URL"
echo -e "  ${BOLD}Frontend URL:${NC}  $PAGES_URL"
echo -e "  ${BOLD}Routing:${NC}       Option $ROUTING_OPTION"
echo
echo -e "  ${BOLD}Features:${NC}"
printf '    %s  hCaptcha protection\n' \
  "$([ -n "$HCAPTCHA_SECRET_KEY" ] && printf "${GREEN}✔${NC}" || printf "${YELLOW}–${NC}")"
printf '    %s  Large-file R2 uploads (up to 420 MB)\n' \
  "$([ "$ENABLE_R2" == "Y" ] && printf "${GREEN}✔${NC}" || printf "${YELLOW}–${NC}")"
echo

if [[ "$ROUTING_OPTION" == "A" ]]; then
  echo -e "  ${BOLD}Next steps for custom domain (Option A):${NC}"
  echo -e "    1. In Cloudflare DNS, point your domain to Pages:"
  echo -e "       CNAME  $CUSTOM_DOMAIN  →  ${PAGES_PROJECT}.pages.dev"
  echo -e "    2. Add a Worker Route in Workers & Pages → $WORKER_NAME → Triggers → Routes:"
  echo -e "       Route: $CUSTOM_DOMAIN/api/*"
  echo -e "    3. Optionally clear VITE_API_URL from Pages env vars if you want the"
  echo -e "       frontend to use relative /api/* paths (recommended for same-domain routing)."
else
  echo -e "  Your app is live at: ${BOLD}$PAGES_URL${NC}"
fi
echo
