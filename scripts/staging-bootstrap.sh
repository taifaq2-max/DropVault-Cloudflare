#!/usr/bin/env bash
# =============================================================================
# scripts/staging-bootstrap.sh — One-time staging environment bootstrap
#
# Usage:  bash scripts/staging-bootstrap.sh [--dry-run]
# Run from the repository root.
#
# Creates the Cloudflare resources that the "deploy-staging" CI job requires:
#   • KV namespace  — "vaultdrop-api-staging-SHARE_KV"
#   • R2 bucket     — "vaultdrop-shares-staging"
#   • Pages project — name supplied interactively (e.g. "vaultdrop-staging")
#
# Patches artifacts/cloudflare/wrangler.toml with the real KV namespace ID and
# prints the GitHub Secret values you must set before pushing to the staging branch.
#
# --dry-run  Print every action that would be taken without making any changes.
# =============================================================================
set -euo pipefail
IFS=$'\n\t'

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CF_DIR="$REPO_ROOT/artifacts/cloudflare"
WRANGLER_TOML="$CF_DIR/wrangler.toml"

DRY_RUN=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    *) echo "Unknown argument: $arg" >&2; exit 1 ;;
  esac
done

# ── colours ───────────────────────────────────────────────────────────────────
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
dryinfo() { echo -e "${YELLOW}  [dry-run]${NC}  $*"; }

# Portable in-place sed (macOS vs. Linux)
sedi() {
  if [[ "$(uname)" == "Darwin" ]]; then
    sed -i '' "$@"
  else
    sed -i "$@"
  fi
}

# ── dry-run banner ────────────────────────────────────────────────────────────
if [[ "$DRY_RUN" == true ]]; then
  echo
  echo -e "${BOLD}${YELLOW}╔══════════════════════════════════════════════════════════╗${NC}"
  echo -e "${BOLD}${YELLOW}║   DRY-RUN MODE — no changes will be made                 ║${NC}"
  echo -e "${BOLD}${YELLOW}╚══════════════════════════════════════════════════════════╝${NC}"
  echo
fi

# ── 1. Prerequisites ──────────────────────────────────────────────────────────
header "Checking prerequisites"

MISSING=0
for cmd in git pnpm; do
  if command -v "$cmd" &>/dev/null; then
    success "$cmd found"
  else
    error "$cmd not found"
    MISSING=1
  fi
done

if command -v node &>/dev/null; then
  NODE_VER=$(node --version | sed 's/v//' | cut -d. -f1)
  if [[ "$NODE_VER" -lt 20 ]]; then
    error "Node.js 20+ required (found v${NODE_VER})."
    MISSING=1
  else
    success "node $(node --version)"
  fi
else
  error "node not found"
  MISSING=1
fi

[[ "$MISSING" -eq 1 ]] && die "Fix the issues above, then rerun."

# ── 2. Install dependencies (makes local wrangler binary available) ────────────
header "Installing dependencies"
if [[ "$DRY_RUN" == true ]]; then
  dryinfo "Would run: pnpm install --frozen-lockfile"
else
  cd "$REPO_ROOT"
  pnpm install --frozen-lockfile
  success "Dependencies ready"
fi

# ── 3. Resolve wrangler ───────────────────────────────────────────────────────
WRANGLER_PATH="$CF_DIR/node_modules/.bin/wrangler"

if [[ "$DRY_RUN" == true ]]; then
  WRANGLER="$WRANGLER_PATH"
  header "Cloudflare authentication"
  dryinfo "Would verify authentication: $WRANGLER_PATH whoami"
else
  if [[ -x "$WRANGLER_PATH" ]]; then
    WRANGLER="$WRANGLER_PATH"
  elif command -v wrangler &>/dev/null; then
    WRANGLER="wrangler"
  else
    die "wrangler not found after pnpm install. Check artifacts/cloudflare/package.json."
  fi
  success "wrangler $($WRANGLER --version 2>/dev/null | head -1)"

  header "Cloudflare authentication"
  if ! $WRANGLER whoami &>/dev/null 2>&1; then
    warn "Not logged in — running 'wrangler login'…"
    $WRANGLER login || die "Authentication failed."
  fi
  success "Cloudflare authentication OK"
fi

# ── 4. Interactive prompts ─────────────────────────────────────────────────────
header "Staging configuration"
echo
echo "  Press Enter to accept defaults shown in [brackets]."
echo

_def_pages="vaultdrop-staging"
read -r -p "  Staging Pages project name [${_def_pages}]: " PAGES_PROJECT_STAGING
PAGES_PROJECT_STAGING="${PAGES_PROJECT_STAGING:-$_def_pages}"
PAGES_PROJECT_STAGING="${PAGES_PROJECT_STAGING// /}"
[[ -z "$PAGES_PROJECT_STAGING" ]] && die "Pages project name is required."

# Staging worker name is fixed by wrangler.toml [env.staging] → name = "vaultdrop-api-staging"
STAGING_WORKER_NAME="vaultdrop-api-staging"
STAGING_KV_TITLE="${STAGING_WORKER_NAME}-SHARE_KV"
STAGING_R2_BUCKET="vaultdrop-shares-staging"

echo
info "Will provision the following staging resources:"
echo "    Cloudflare Pages project : $PAGES_PROJECT_STAGING"
echo "    Worker (staging env)     : $STAGING_WORKER_NAME"
echo "    KV namespace title       : $STAGING_KV_TITLE"
echo "    R2 bucket                : $STAGING_R2_BUCKET"
echo

if [[ "$DRY_RUN" != true ]]; then
  read -r -p "  Proceed? [Y/n]: " CONFIRM
  CONFIRM="${CONFIRM:-Y}"
  CONFIRM="${CONFIRM^^}"
  [[ "$CONFIRM" != "Y" ]] && { echo "Aborted."; exit 0; }
fi

# ── 5. KV namespace (staging) ─────────────────────────────────────────────────
header "Provisioning staging KV namespace"

if [[ "$DRY_RUN" == true ]]; then
  dryinfo "Would create KV namespace: $STAGING_KV_TITLE"
  dryinfo "  Command: cd $CF_DIR && $WRANGLER kv namespace create SHARE_KV --env staging"
  dryinfo "Would patch wrangler.toml: replace REPLACE_WITH_STAGING_KV_ID with real ID"
else
  info "Creating KV namespace '$STAGING_KV_TITLE' (skipped if already exists)…"
  KV_CREATE_OUT=""
  KV_CREATE_RC=0
  KV_CREATE_OUT=$(cd "$CF_DIR" && $WRANGLER kv namespace create SHARE_KV --env staging 2>&1) || KV_CREATE_RC=$?

  # Parse ID from wrangler's TOML-snippet output: id = '<32-char-hex>'
  STAGING_KV_ID=$(echo "$KV_CREATE_OUT" | grep -E "^\s*id\s*=" | head -1 \
    | grep -oE '[a-f0-9]{32}' | head -1 || true)

  if [[ -z "$STAGING_KV_ID" ]]; then
    # Namespace may already exist — scan the list
    warn "  Namespace may already exist — scanning namespace list…"
    KV_LIST_OUT=$(cd "$CF_DIR" && $WRANGLER kv namespace list 2>&1) || true
    STAGING_KV_ID=$(echo "$KV_LIST_OUT" | grep -F "$STAGING_KV_TITLE" \
      | grep -oE '[a-f0-9]{32}' | head -1 || true)
  fi

  if [[ -z "$STAGING_KV_ID" ]]; then
    error "Could not determine staging KV namespace ID."
    error "wrangler output was:"
    echo "$KV_CREATE_OUT" >&2
    die "Create the namespace manually and paste its ID into wrangler.toml [env.staging.kv_namespaces]."
  fi

  success "Staging KV namespace ID: $STAGING_KV_ID"

  # Patch wrangler.toml
  if grep -q "REPLACE_WITH_STAGING_KV_ID" "$WRANGLER_TOML"; then
    sedi "s|REPLACE_WITH_STAGING_KV_ID|${STAGING_KV_ID}|g" "$WRANGLER_TOML"
    success "wrangler.toml patched with staging KV ID"
  elif grep -q "$STAGING_KV_ID" "$WRANGLER_TOML"; then
    info "wrangler.toml already contains the correct staging KV ID — no change needed."
  else
    warn "wrangler.toml does not contain the placeholder — patch it manually:"
    warn "  In [env.staging.kv_namespaces], set: id = \"$STAGING_KV_ID\""
  fi
fi

# ── 6. R2 bucket (staging) ────────────────────────────────────────────────────
header "Provisioning staging R2 bucket"

if [[ "$DRY_RUN" == true ]]; then
  dryinfo "Would create R2 bucket: $STAGING_R2_BUCKET"
  dryinfo "  Command: cd $CF_DIR && $WRANGLER r2 bucket create \"$STAGING_R2_BUCKET\""
else
  info "Creating R2 bucket '$STAGING_R2_BUCKET' (skipped if already exists)…"
  R2_OUT="" R2_RC=0
  R2_OUT=$(cd "$CF_DIR" && $WRANGLER r2 bucket create "$STAGING_R2_BUCKET" 2>&1) || R2_RC=$?
  if [[ "$R2_RC" -ne 0 ]]; then
    if echo "$R2_OUT" | grep -qi "already exists\|already created\|10006"; then
      warn "  Bucket '$STAGING_R2_BUCKET' already exists — reusing it."
    else
      error "R2 bucket creation failed (exit $R2_RC):"
      echo "$R2_OUT" >&2
      die "Check your account ID, token permissions, and bucket name, then rerun."
    fi
  else
    success "R2 bucket '$STAGING_R2_BUCKET' created"
  fi
fi

# ── 7. Cloudflare Pages project (staging) ────────────────────────────────────
header "Provisioning staging Cloudflare Pages project"

if [[ "$DRY_RUN" == true ]]; then
  dryinfo "Would create Pages project: $PAGES_PROJECT_STAGING"
  dryinfo "  Command: cd $CF_DIR && $WRANGLER pages project create \"$PAGES_PROJECT_STAGING\" --production-branch main"
else
  info "Creating Cloudflare Pages project '$PAGES_PROJECT_STAGING' (skipped if already exists)…"
  PAGES_CREATE_OUT="" PAGES_CREATE_RC=0
  PAGES_CREATE_OUT=$(cd "$CF_DIR" && $WRANGLER pages project create \
    "$PAGES_PROJECT_STAGING" --production-branch main 2>&1) || PAGES_CREATE_RC=$?
  if [[ "$PAGES_CREATE_RC" -ne 0 ]]; then
    if echo "$PAGES_CREATE_OUT" | grep -qi "already exists\|already created\|name.*taken"; then
      warn "  Pages project '$PAGES_PROJECT_STAGING' already exists — reusing it."
    else
      error "Pages project creation failed (exit $PAGES_CREATE_RC):"
      echo "$PAGES_CREATE_OUT" >&2
      die "Check your account ID and token permissions, then rerun."
    fi
  else
    success "Cloudflare Pages project '$PAGES_PROJECT_STAGING' created"
  fi
fi

# ── 8. Summary ────────────────────────────────────────────────────────────────
header "Bootstrap complete"

if [[ "$DRY_RUN" == true ]]; then
  echo
  echo -e "${BOLD}${YELLOW}  No Cloudflare API calls, no wrangler commands, and no file${NC}"
  echo -e "${BOLD}${YELLOW}  mutations were made.  Remove --dry-run to run for real.${NC}"
  echo
  echo -e "${BOLD}  GitHub Secrets you will need to set after a real run:${NC}"
  echo "    CF_PAGES_PROJECT_STAGING = $PAGES_PROJECT_STAGING"
  echo "    (plus CF_ACCOUNT_ID and CLOUDFLARE_API_TOKEN if not already set)"
  exit 0
fi

echo
echo -e "${BOLD}  Set the following GitHub Secrets in your repository${NC}"
echo -e "  ${BLUE}(Settings → Secrets and variables → Actions → New repository secret)${NC}"
echo
echo -e "    ${BOLD}CF_PAGES_PROJECT_STAGING${NC} = ${GREEN}${PAGES_PROJECT_STAGING}${NC}"
echo
echo "  The following secrets must already exist for CI to work end-to-end:"
echo "    CLOUDFLARE_API_TOKEN     — Cloudflare API token with Workers, Pages, KV, and R2 permissions"
echo "    CF_ACCOUNT_ID            — your Cloudflare account ID"
echo "    VITE_HCAPTCHA_SITE_KEY   — (optional) hCaptcha site key for the staging frontend"
echo "    VITE_USE_R2_UPLOADS      — (optional) set to 'true' to enable large-file R2 uploads"
echo
echo -e "${GREEN}  Once the secret is set, push to the 'staging' branch to trigger the first deploy.${NC}"
echo
