#!/usr/bin/env bash
# =============================================================================
# tests/deploy-saved-defaults.sh — Tests for deploy.sh saved-defaults feature
#
# Covers:
#   1. No config file → built-in defaults shown in dry-run prompts
#   2. Config file present → saved values used as defaults in dry-run prompts
#   3. Secret fields (CF_API_TOKEN, SESSION_SECRET, etc.) never written to
#      the config file
#
# Usage: bash tests/deploy-saved-defaults.sh
# Exit 0 on all assertions passing, non-zero on any failure.
# =============================================================================
set -euo pipefail

PASS=0
FAIL=0
FAILURES=""

_pass() { echo "  PASS: $*"; ((PASS++)) || true; }
_fail() { echo "  FAIL: $*"; ((FAIL++)) || true; FAILURES+="  - $*\n"; }

assert_contains() {
  local label="$1" pattern="$2" text="$3"
  if echo "$text" | grep -qF "$pattern"; then
    _pass "$label"
  else
    _fail "$label (pattern not found: '$pattern')"
  fi
}

assert_not_contains() {
  local label="$1" pattern="$2" text="$3"
  if echo "$text" | grep -qF "$pattern"; then
    _fail "$label (unexpected pattern found: '$pattern')"
  else
    _pass "$label"
  fi
}

assert_exit_zero() {
  local label="$1" code="$2"
  if [[ "$code" -eq 0 ]]; then
    _pass "$label"
  else
    _fail "$label (exit code was $code, expected 0)"
  fi
}

assert_file_not_contains() {
  local label="$1" pattern="$2" file="$3"
  if grep -qF "$pattern" "$file" 2>/dev/null; then
    _fail "$label (forbidden pattern found in file: '$pattern')"
  else
    _pass "$label"
  fi
}

assert_file_contains() {
  local label="$1" pattern="$2" file="$3"
  if grep -qF "$pattern" "$file" 2>/dev/null; then
    _pass "$label"
  else
    _fail "$label (pattern not found in file: '$pattern')"
  fi
}

# ── test setup ───────────────────────────────────────────────────────────────

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
CONFIG_FILE="$REPO_ROOT/.deploy.cfg"
CONFIG_BACKED_UP=false

# Back up any existing .deploy.cfg so we can restore it after tests.
if [[ -f "$CONFIG_FILE" ]]; then
  cp "$CONFIG_FILE" "$TMP_DIR/.deploy.cfg.bak"
  CONFIG_BACKED_UP=true
fi

FAKE_BIN="$TMP_DIR/bin"
mkdir -p "$FAKE_BIN"

INVOCATION_LOG="$TMP_DIR/invocations.log"
touch "$INVOCATION_LOG"
export INVOCATION_LOG

# Stub wrangler and curl so no real external calls are made.
cat > "$FAKE_BIN/wrangler" <<'STUB'
#!/usr/bin/env bash
echo "wrangler $*" >> "$INVOCATION_LOG"
exit 1
STUB

cat > "$FAKE_BIN/curl" <<'STUB'
#!/usr/bin/env bash
echo "curl $*" >> "$INVOCATION_LOG"
exit 1
STUB

# Provide a python3 stub for environments where it may not be installed.
if ! command -v python3 &>/dev/null; then
  cat > "$FAKE_BIN/python3" <<'STUB'
#!/usr/bin/env bash
echo "Python 3.0.0 (stub)"
STUB
  chmod +x "$FAKE_BIN/python3"
fi

chmod +x "$FAKE_BIN/wrangler" "$FAKE_BIN/curl"

# Stub the absolute wrangler path that deploy.sh constructs internally.
ABS_WRANGLER_DIR="$REPO_ROOT/artifacts/cloudflare/node_modules/.bin"
ABS_WRANGLER="$ABS_WRANGLER_DIR/wrangler"
ABS_WRANGLER_BACKED_UP=false
ABS_WRANGLER_DIR_CREATED=false

if [[ ! -d "$ABS_WRANGLER_DIR" ]]; then
  mkdir -p "$ABS_WRANGLER_DIR"
  ABS_WRANGLER_DIR_CREATED=true
fi

if [[ -f "$ABS_WRANGLER" ]]; then
  cp "$ABS_WRANGLER" "${ABS_WRANGLER}.bak"
  ABS_WRANGLER_BACKED_UP=true
fi

cat > "$ABS_WRANGLER" <<'STUB'
#!/usr/bin/env bash
echo "wrangler $*" >> "$INVOCATION_LOG"
exit 1
STUB
chmod +x "$ABS_WRANGLER"

cleanup() {
  # Restore .deploy.cfg
  if [[ "$CONFIG_BACKED_UP" == true ]]; then
    cp "$TMP_DIR/.deploy.cfg.bak" "$CONFIG_FILE"
  else
    rm -f "$CONFIG_FILE"
  fi

  # Restore absolute wrangler stub
  if [[ "$ABS_WRANGLER_BACKED_UP" == true ]]; then
    mv "${ABS_WRANGLER}.bak" "$ABS_WRANGLER"
  else
    rm -f "$ABS_WRANGLER"
  fi
  if [[ "$ABS_WRANGLER_DIR_CREATED" == true ]]; then
    rm -rf "$REPO_ROOT/artifacts/cloudflare/node_modules"
  fi

  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

# Helper: run deploy.sh --dry-run with the given stdin content.
# Captures combined stdout+stderr.  Returns output in $RUN_OUTPUT, exit in $RUN_EXIT.
#
# IMPORTANT: bash command substitution strips trailing newlines, so any empty
# strings at the end of a printf sequence get dropped.  Always ensure the last
# value in the input sequence is non-empty (e.g. "N" for the R2 prompt) so
# that all read(1) calls inside deploy.sh receive input before EOF.
run_dry() {
  local stdin_content="$1"
  RUN_OUTPUT=""
  RUN_EXIT=0
  RUN_OUTPUT=$(PATH="$FAKE_BIN:$PATH" bash "$REPO_ROOT/deploy.sh" --dry-run \
    <<< "$stdin_content" 2>&1) || RUN_EXIT=$?
}

# ─────────────────────────────────────────────────────────────────────────────
# TEST 1: No config file → built-in defaults appear in prompts
# ─────────────────────────────────────────────────────────────────────────────
echo
echo "═══════════════════════════════════════════════════════════"
echo " TEST 1: No config file — built-in defaults shown"
echo "═══════════════════════════════════════════════════════════"

rm -f "$CONFIG_FILE"

# Supply inputs for every prompt so no read(1) call hits EOF.
# NOTE: bash's "read -p" suppresses the prompt text when stdin is not a
# terminal, so we cannot assert on "[vaultdrop-api]" bracket text.  Instead
# we verify that the deployment plan section echoes the built-in defaults.
#
# We enter empty strings for WORKER_NAME, R2_BUCKET, and PAGES_PROJECT so
# the script falls back to its hard-coded defaults (_def_* variables).
# The last value must be non-empty so command substitution doesn't strip
# all trailing newlines and starve later read(1) calls.
#
# Prompt order (routing B, no hCaptcha, no R2):
#   1. CF_ACCOUNT_ID          → explicit
#   2. CF_API_TOKEN (read -s) → explicit (required, never saved)
#   3. WORKER_NAME            → empty → falls back to "vaultdrop-api"
#   4. R2_BUCKET              → empty → falls back to "vaultdrop-shares"
#   5. PAGES_PROJECT          → empty → falls back to "vaultdrop"
#   6. ROUTING_OPTION         → "B"   → explicit (single-char, safe to keep)
#   7. SESSION_SECRET (read -s) → empty → auto-generated
#   8. HCAPTCHA_SECRET_KEY (read -s) → empty → CAPTCHA skipped
#   9. ENABLE_R2              → "N"   → non-empty last value
INPUT_1="$(printf '%s\n' \
  "test-account-id" \
  "fake-api-token" \
  "" \
  "" \
  "" \
  "B" \
  "" \
  "" \
  "N" \
)"

run_dry "$INPUT_1"
assert_exit_zero "test1: exit code is 0" "$RUN_EXIT"

# The deployment plan must reflect the built-in defaults that were accepted.
assert_contains "test1: plan shows built-in worker name"   "vaultdrop-api"    "$RUN_OUTPUT"
assert_contains "test1: plan shows built-in bucket name"   "vaultdrop-shares" "$RUN_OUTPUT"
assert_contains "test1: plan shows built-in pages project" "Pages project         : vaultdrop" "$RUN_OUTPUT"
assert_contains "test1: plan shows routing option B"       "Routing option        : B" "$RUN_OUTPUT"
assert_contains "test1: plan shows R2 uploads disabled"    "Large-file R2 uploads : N" "$RUN_OUTPUT"

# Sanity: no .deploy.cfg was created (dry-run never writes the file).
assert_not_contains "test1: .deploy.cfg not written in dry-run" \
  "CF_ACCOUNT_ID" "$(cat "$CONFIG_FILE" 2>/dev/null || true)"

# ─────────────────────────────────────────────────────────────────────────────
# TEST 2: Config file present → saved values shown as defaults
# ─────────────────────────────────────────────────────────────────────────────
echo
echo "═══════════════════════════════════════════════════════════"
echo " TEST 2: Config file present — saved values shown as defaults"
echo "═══════════════════════════════════════════════════════════"

SAVED_ACCOUNT_ID="saved-account-abc"
SAVED_WORKER="saved-worker-xyz"
SAVED_BUCKET="saved-bucket-xyz"
SAVED_PAGES="saved-pages-xyz"
SAVED_ROUTING="B"
SAVED_HCAPTCHA_SITE_KEY="saved-site-key-xyz"
SAVED_ENABLE_R2="N"

cat > "$CONFIG_FILE" <<CFG
# deploy.sh saved config — non-secret values only (auto-generated)
CF_ACCOUNT_ID=$SAVED_ACCOUNT_ID
WORKER_NAME=$SAVED_WORKER
R2_BUCKET=$SAVED_BUCKET
PAGES_PROJECT=$SAVED_PAGES
ROUTING_OPTION=$SAVED_ROUTING
CUSTOM_DOMAIN=
HCAPTCHA_SITE_KEY=$SAVED_HCAPTCHA_SITE_KEY
ENABLE_R2=$SAVED_ENABLE_R2
CFG

# Provide empty strings for every non-secret prompt so the script uses saved
# defaults.  The API token is always required (never saved).  The last value
# must be non-empty ("N") to avoid command-substitution stripping trailing
# newlines and causing read(1) to hit EOF prematurely.
INPUT_2="$(printf '%s\n' \
  "" \
  "fake-api-token" \
  "" \
  "" \
  "" \
  "" \
  "" \
  "" \
  "N" \
)"

run_dry "$INPUT_2"
assert_exit_zero "test2: exit code is 0" "$RUN_EXIT"

# bash's "read -p" suppresses prompt text when stdin is not a terminal, so we
# verify defaults via the deployment plan section of the output, which always
# prints the resolved configuration values.
assert_contains "test2: plan shows saved account ID"    "$SAVED_ACCOUNT_ID" "$RUN_OUTPUT"
assert_contains "test2: plan shows saved worker name"   "$SAVED_WORKER"     "$RUN_OUTPUT"
assert_contains "test2: plan shows saved bucket name"   "$SAVED_BUCKET"     "$RUN_OUTPUT"
assert_contains "test2: plan shows saved pages project" "$SAVED_PAGES"      "$RUN_OUTPUT"
assert_contains "test2: plan shows saved routing option" \
  "Routing option        : $SAVED_ROUTING" "$RUN_OUTPUT"

# The saved values should override any built-in defaults.
assert_not_contains "test2: built-in worker not used when config present" \
  "vaultdrop-api"    "$RUN_OUTPUT"
assert_not_contains "test2: built-in bucket not used when config present" \
  "vaultdrop-shares" "$RUN_OUTPUT"

# ─────────────────────────────────────────────────────────────────────────────
# TEST 3: Secret fields are never written to the config file
# ─────────────────────────────────────────────────────────────────────────────
echo
echo "═══════════════════════════════════════════════════════════"
echo " TEST 3: Secret fields never written to config file"
echo "═══════════════════════════════════════════════════════════"

# -- 3a: Static analysis: extract the config-save block from deploy.sh and
#        verify that no secret key names appear in it.
#        Fail fast if the extraction is empty (markers changed in source).
SAVE_BLOCK=$(awk '/# ── Save non-secret config/,/info "Non-secret config saved/' \
  "$REPO_ROOT/deploy.sh")

if [[ -z "$SAVE_BLOCK" ]]; then
  _fail "test3: save-block extraction returned nothing — start/end markers may have changed in deploy.sh"
else
  _pass "test3: save block successfully extracted from deploy.sh"
fi

assert_not_contains "test3-static: CF_API_TOKEN not in save block"         "CF_API_TOKEN"         "$SAVE_BLOCK"
assert_not_contains "test3-static: SESSION_SECRET not in save block"       "SESSION_SECRET"       "$SAVE_BLOCK"
assert_not_contains "test3-static: HCAPTCHA_SECRET_KEY not in save block"  "HCAPTCHA_SECRET_KEY"  "$SAVE_BLOCK"
assert_not_contains "test3-static: R2_ACCESS_KEY_ID not in save block"     "R2_ACCESS_KEY_ID"     "$SAVE_BLOCK"
assert_not_contains "test3-static: R2_ACCESS_KEY_SECRET not in save block" "R2_ACCESS_KEY_SECRET" "$SAVE_BLOCK"

# -- 3b: Runtime verification: source the *actual extracted* save block from
#        deploy.sh in a subshell with all variables set (including secrets).
#        This verifies the real script produces a config file free of secrets,
#        rather than a synthetic reimplementation that could diverge from source.
SYNTHETIC_CFG="$TMP_DIR/synthetic.deploy.cfg"
SAVE_SCRIPT="$TMP_DIR/save_block.sh"
echo "$SAVE_BLOCK" > "$SAVE_SCRIPT"

(
  # Stub info() so the sourced script's trailing info() call doesn't fail.
  info() { :; }

  CF_ACCOUNT_ID='runtime-account-id'
  WORKER_NAME='runtime-worker'
  R2_BUCKET='runtime-bucket'
  PAGES_PROJECT='runtime-pages'
  ROUTING_OPTION='B'
  CUSTOM_DOMAIN=''
  HCAPTCHA_SITE_KEY='runtime-site-key'
  ENABLE_R2='N'

  # Secret values — must NOT appear in the saved config.
  CF_API_TOKEN='super-secret-token'
  SESSION_SECRET='super-secret-session'
  HCAPTCHA_SECRET_KEY='super-secret-hcaptcha'
  R2_KEY_ID='super-secret-r2-id'
  R2_KEY_SECRET='super-secret-r2-secret'

  CONFIG_FILE="$SYNTHETIC_CFG"
  # shellcheck source=/dev/null
  . "$SAVE_SCRIPT"
)

# Non-secret values must be present.
assert_file_contains "test3-runtime: CF_ACCOUNT_ID written to config"  "CF_ACCOUNT_ID=runtime-account-id" "$SYNTHETIC_CFG"
assert_file_contains "test3-runtime: WORKER_NAME written to config"    "WORKER_NAME=runtime-worker"        "$SYNTHETIC_CFG"
assert_file_contains "test3-runtime: R2_BUCKET written to config"      "R2_BUCKET=runtime-bucket"          "$SYNTHETIC_CFG"
assert_file_contains "test3-runtime: PAGES_PROJECT written to config"  "PAGES_PROJECT=runtime-pages"       "$SYNTHETIC_CFG"
assert_file_contains "test3-runtime: HCAPTCHA_SITE_KEY written to config" "HCAPTCHA_SITE_KEY=runtime-site-key" "$SYNTHETIC_CFG"

# Secret values must NOT appear.
assert_file_not_contains "test3-runtime: CF_API_TOKEN absent from config"         "CF_API_TOKEN"         "$SYNTHETIC_CFG"
assert_file_not_contains "test3-runtime: SESSION_SECRET absent from config"       "SESSION_SECRET"       "$SYNTHETIC_CFG"
assert_file_not_contains "test3-runtime: HCAPTCHA_SECRET_KEY absent from config"  "HCAPTCHA_SECRET_KEY"  "$SYNTHETIC_CFG"
assert_file_not_contains "test3-runtime: R2_ACCESS_KEY_ID absent from config"     "super-secret-r2-id"   "$SYNTHETIC_CFG"
assert_file_not_contains "test3-runtime: R2_ACCESS_KEY_SECRET absent from config" "super-secret-r2-secret" "$SYNTHETIC_CFG"

# ── summary ──────────────────────────────────────────────────────────────────

echo
echo "═══════════════════════════════════════════════════════════"
echo "Results: $PASS passed, $FAIL failed"

if [[ "$FAIL" -gt 0 ]]; then
  echo
  echo "Failed assertions:"
  printf '%b' "$FAILURES"
  exit 1
fi

echo "All assertions passed."
exit 0
