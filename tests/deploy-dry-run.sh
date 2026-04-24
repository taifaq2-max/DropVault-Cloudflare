#!/usr/bin/env bash
# =============================================================================
# tests/deploy-dry-run.sh — Automated test for deploy.sh --dry-run
#
# Usage: bash tests/deploy-dry-run.sh
# Exit 0 on all assertions passing, non-zero on any failure.
# =============================================================================
set -euo pipefail

PASS=0
FAIL=0
FAILURES=""

_pass() { echo "  PASS: $*"; ((PASS++)) || true; }
_fail() { echo "  FAIL: $*"; ((FAIL++)) || true; FAILURES+="  - $*\n"; }

# ── helpers ──────────────────────────────────────────────────────────────────

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

assert_exit_nonzero() {
  local label="$1" code="$2"
  if [[ "$code" -ne 0 ]]; then
    _pass "$label"
  else
    _fail "$label (exit code was 0, expected non-zero)"
  fi
}

assert_file_empty() {
  local label="$1" file="$2"
  if [[ ! -s "$file" ]]; then
    _pass "$label"
  else
    _fail "$label (file not empty: $(cat "$file"))"
  fi
}

# ── test setup ───────────────────────────────────────────────────────────────

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
INVOCATION_LOG="$TMP_DIR/invocations.log"
touch "$INVOCATION_LOG"

# The absolute wrangler path that deploy.sh constructs and prints in dry-run output.
# We intercept this path too so that any accidental direct invocation is captured.
ABS_WRANGLER_DIR="$REPO_ROOT/artifacts/cloudflare/node_modules/.bin"
ABS_WRANGLER="$ABS_WRANGLER_DIR/wrangler"
ABS_WRANGLER_BACKED_UP=false
ABS_WRANGLER_DIR_CREATED=false

# Build the stub content once (includes the exported INVOCATION_LOG path).
# Written before cleanup is registered so the trap below can use these vars.
WRANGLER_STUB_BODY='#!/usr/bin/env bash
echo "wrangler $*" >> "$INVOCATION_LOG"
exit 1'

CURL_STUB_BODY='#!/usr/bin/env bash
echo "curl $*" >> "$INVOCATION_LOG"
exit 1'

cleanup() {
  # Restore absolute wrangler if we displaced it
  if [[ "$ABS_WRANGLER_BACKED_UP" == true ]]; then
    mv "${ABS_WRANGLER}.bak" "$ABS_WRANGLER"
  elif [[ -f "$ABS_WRANGLER" && ! "$ABS_WRANGLER_BACKED_UP" == true ]]; then
    # We created the file from scratch; remove it
    rm -f "$ABS_WRANGLER"
  fi
  # Remove the directory we created if it was not there originally
  if [[ "$ABS_WRANGLER_DIR_CREATED" == true ]]; then
    rm -rf "$REPO_ROOT/artifacts/cloudflare/node_modules"
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

# ── fake bin directory (shadows PATH) ────────────────────────────────────────

FAKE_BIN="$TMP_DIR/bin"
mkdir -p "$FAKE_BIN"

printf '%s\n' "$WRANGLER_STUB_BODY" > "$FAKE_BIN/wrangler"
printf '%s\n' "$CURL_STUB_BODY"    > "$FAKE_BIN/curl"

# Provide python3 stub for environments where it may not be installed.
# The prerequisite check only needs the command to exist and print a version.
if ! command -v python3 &>/dev/null; then
  cat > "$FAKE_BIN/python3" <<'STUB'
#!/usr/bin/env bash
echo "Python 3.0.0 (stub)"
STUB
  chmod +x "$FAKE_BIN/python3"
fi

chmod +x "$FAKE_BIN/wrangler" "$FAKE_BIN/curl"

# ── absolute-path wrangler stub ───────────────────────────────────────────────
# deploy.sh sets WRANGLER_PATH="$CF_DIR/node_modules/.bin/wrangler" and in
# dry-run mode prints (but should never execute) that path.  We place a stub
# at the exact absolute path so any accidental direct invocation is recorded
# and causes the test to fail.

if [[ ! -d "$ABS_WRANGLER_DIR" ]]; then
  mkdir -p "$ABS_WRANGLER_DIR"
  ABS_WRANGLER_DIR_CREATED=true
fi

if [[ -f "$ABS_WRANGLER" ]]; then
  cp "$ABS_WRANGLER" "${ABS_WRANGLER}.bak"
  ABS_WRANGLER_BACKED_UP=true
fi

printf '%s\n' "$WRANGLER_STUB_BODY" > "$ABS_WRANGLER"
chmod +x "$ABS_WRANGLER"

# Export so stubs can reference it at runtime as an env var
export INVOCATION_LOG

# =============================================================================
# Scenario 1 — Routing option B (Pages proxy, no custom domain)
# =============================================================================

# ── known inputs (simulating interactive answers) ─────────────────────────────
# Prompts in order during --dry-run (option B):
#   1. Cloudflare Account ID
#   2. Cloudflare API Token (read -s, hidden)
#   3. Worker name            [default: vaultdrop-api]
#   4. R2 bucket name         [default: vaultdrop-shares]
#   5. Cloudflare Pages project name [default: vaultdrop]
#   6. Routing option         → B
#   7. SESSION_SECRET         (Enter → auto-generate)
#   8. hCaptcha secret key    (Enter → skip CAPTCHA)
#   9. Enable large-file R2 uploads? → N

ACCOUNT_ID="acct-12345678"
WORKER_NAME="my-vaultdrop-worker"
R2_BUCKET="my-vaultdrop-bucket"
PAGES_PROJECT="my-vaultdrop-pages"

INPUT_B="$(printf '%s\n' \
  "$ACCOUNT_ID" \
  "fake-api-token" \
  "$WORKER_NAME" \
  "$R2_BUCKET" \
  "$PAGES_PROJECT" \
  "B" \
  "" \
  "" \
  "N" \
)"

# ── run deploy.sh --dry-run (scenario 1) ─────────────────────────────────────

echo
echo "=== Scenario 1: Option B (Pages proxy, no custom domain) ==="
echo "Running: bash deploy.sh --dry-run"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Prepend fake bin so our stubs shadow any wrangler/curl found on PATH.
# The absolute-path stub handles invocations via the hardcoded binary path.
ACTUAL_OUTPUT=""
EXIT_CODE=0
ACTUAL_OUTPUT=$(PATH="$FAKE_BIN:$PATH" bash "$REPO_ROOT/deploy.sh" --dry-run \
  <<< "$INPUT_B" 2>&1) || EXIT_CODE=$?

echo "$ACTUAL_OUTPUT"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo

# ── assertions (scenario 1) ───────────────────────────────────────────────────

echo "Assertions (Scenario 1 — Option B):"

# 1. Exit code must be 0
assert_exit_zero "[B] exit code is 0" "$EXIT_CODE"

# 2. Dry-run banner
assert_contains "[B] dry-run banner present" \
  "DRY-RUN MODE" "$ACTUAL_OUTPUT"

# 3. Deployment plan heading
assert_contains "[B] deployment plan heading" \
  "DEPLOYMENT PLAN" "$ACTUAL_OUTPUT"

# 4. Worker name in plan
assert_contains "[B] worker name appears in plan" \
  "$WORKER_NAME" "$ACTUAL_OUTPUT"

# 5. R2 bucket name in plan
assert_contains "[B] R2 bucket name appears in plan" \
  "$R2_BUCKET" "$ACTUAL_OUTPUT"

# 6. Pages project name in plan
assert_contains "[B] Pages project name appears in plan" \
  "$PAGES_PROJECT" "$ACTUAL_OUTPUT"

# 7. Account ID in plan
assert_contains "[B] Cloudflare account ID appears in plan" \
  "$ACCOUNT_ID" "$ACTUAL_OUTPUT"

# 8. KV namespace titles (derived as <worker>-SHARE_KV and <worker>-SHARE_KV_preview)
assert_contains "[B] production KV namespace title in plan" \
  "${WORKER_NAME}-SHARE_KV" "$ACTUAL_OUTPUT"

assert_contains "[B] preview KV namespace title in plan" \
  "${WORKER_NAME}-SHARE_KV_preview" "$ACTUAL_OUTPUT"

# 9. All major deployment steps mentioned
for step_label in \
  "Step 1 — Install dependencies" \
  "Step 2 — Cloudflare authentication" \
  "Step 3 — wrangler.toml changes" \
  "Step 4 — KV namespace provisioning" \
  "Step 5 — R2 bucket provisioning" \
  "Step 6 — Worker secrets" \
  "Step 7 — Deploy Worker" \
  "Step 8 — Build frontend" \
  "Step 9 — Deploy to Cloudflare Pages" \
  "Step 11 — Set Pages environment variables" \
  "Step 13 — Final Pages redeploy"
do
  assert_contains "[B] plan includes '${step_label}'" "$step_label" "$ACTUAL_OUTPUT"
done

# 10. Closing "no changes" notice
assert_contains "[B] closing no-changes notice present" \
  "No Cloudflare API calls, no wrangler commands, and no file" "$ACTUAL_OUTPUT"

# 11. Neither wrangler nor curl were actually invoked
assert_file_empty "[B] wrangler was not invoked (PATH or absolute path)" "$INVOCATION_LOG"
assert_file_empty "[B] curl was not invoked"                             "$INVOCATION_LOG"

# 12. Step 12 (R2 CORS) must NOT appear when R2 is disabled
assert_not_contains "[B] Step 12 absent without R2" \
  "Step 12" "$ACTUAL_OUTPUT"

# =============================================================================
# Scenario 2 — Routing option A (custom domain + Worker Routes, R2 enabled)
# =============================================================================

# ── known inputs (simulating interactive answers) ─────────────────────────────
# Prompts in order during --dry-run (option A, R2 enabled):
#   1. Cloudflare Account ID
#   2. Cloudflare API Token (read -s, hidden)
#   3. Worker name            [default: vaultdrop-api]
#   4. R2 bucket name         [default: vaultdrop-shares]
#   5. Cloudflare Pages project name [default: vaultdrop]
#   6. Routing option         → A
#   7. Custom domain          → vaultdrop.example.com
#   8. SESSION_SECRET         (Enter → auto-generate)
#   9. hCaptcha secret key    (Enter → skip CAPTCHA)
#  10. Enable large-file R2 uploads? → Y
#  11. R2 Access Key ID
#  12. R2 Secret Access Key   (read -s, hidden)

CUSTOM_DOMAIN_A="vaultdrop.example.com"
WORKER_NAME_A="my-worker-option-a"
R2_BUCKET_A="my-bucket-option-a"
PAGES_PROJECT_A="my-pages-option-a"
R2_KEY_ID_A="fake-r2-key-id"
R2_KEY_SECRET_A="fake-r2-secret"

INPUT_A="$(printf '%s\n' \
  "$ACCOUNT_ID" \
  "fake-api-token" \
  "$WORKER_NAME_A" \
  "$R2_BUCKET_A" \
  "$PAGES_PROJECT_A" \
  "A" \
  "$CUSTOM_DOMAIN_A" \
  "" \
  "" \
  "Y" \
  "$R2_KEY_ID_A" \
  "$R2_KEY_SECRET_A" \
)"

# Reset the invocation log between scenarios so leakage is caught per-scenario.
> "$INVOCATION_LOG"

# ── run deploy.sh --dry-run (scenario 2) ─────────────────────────────────────

echo
echo "=== Scenario 2: Option A (custom domain + Worker Routes, R2 enabled) ==="
echo "Running: bash deploy.sh --dry-run"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

ACTUAL_OUTPUT_A=""
EXIT_CODE_A=0
ACTUAL_OUTPUT_A=$(PATH="$FAKE_BIN:$PATH" bash "$REPO_ROOT/deploy.sh" --dry-run \
  <<< "$INPUT_A" 2>&1) || EXIT_CODE_A=$?

echo "$ACTUAL_OUTPUT_A"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo

# ── assertions (scenario 2) ───────────────────────────────────────────────────

echo "Assertions (Scenario 2 — Option A):"

# 1. Exit code must be 0
assert_exit_zero "[A] exit code is 0" "$EXIT_CODE_A"

# 2. Dry-run banner
assert_contains "[A] dry-run banner present" \
  "DRY-RUN MODE" "$ACTUAL_OUTPUT_A"

# 3. Deployment plan heading
assert_contains "[A] deployment plan heading" \
  "DEPLOYMENT PLAN" "$ACTUAL_OUTPUT_A"

# 4. Custom domain must appear in the configuration summary
assert_contains "[A] custom domain appears in plan" \
  "$CUSTOM_DOMAIN_A" "$ACTUAL_OUTPUT_A"

# 5. FRONTEND_URL set to custom domain in Step 3 (wrangler.toml changes)
assert_contains "[A] FRONTEND_URL set to custom domain in Step 3" \
  "FRONTEND_URL" "$ACTUAL_OUTPUT_A"

# 6. Worker name in plan
assert_contains "[A] worker name appears in plan" \
  "$WORKER_NAME_A" "$ACTUAL_OUTPUT_A"

# 7. R2 bucket name in plan
assert_contains "[A] R2 bucket name appears in plan" \
  "$R2_BUCKET_A" "$ACTUAL_OUTPUT_A"

# 8. Pages project name in plan
assert_contains "[A] Pages project name appears in plan" \
  "$PAGES_PROJECT_A" "$ACTUAL_OUTPUT_A"

# 9. Account ID in plan
assert_contains "[A] Cloudflare account ID appears in plan" \
  "$ACCOUNT_ID" "$ACTUAL_OUTPUT_A"

# 10. KV namespace titles
assert_contains "[A] production KV namespace title in plan" \
  "${WORKER_NAME_A}-SHARE_KV" "$ACTUAL_OUTPUT_A"

assert_contains "[A] preview KV namespace title in plan" \
  "${WORKER_NAME_A}-SHARE_KV_preview" "$ACTUAL_OUTPUT_A"

# 11. All major deployment steps mentioned (Step 10 is Option B only, excluded here)
for step_label in \
  "Step 1 — Install dependencies" \
  "Step 2 — Cloudflare authentication" \
  "Step 3 — wrangler.toml changes" \
  "Step 4 — KV namespace provisioning" \
  "Step 5 — R2 bucket provisioning" \
  "Step 6 — Worker secrets" \
  "Step 7 — Deploy Worker" \
  "Step 8 — Build frontend" \
  "Step 9 — Deploy to Cloudflare Pages" \
  "Step 11 — Set Pages environment variables" \
  "Step 13 — Final Pages redeploy"
do
  assert_contains "[A] plan includes '${step_label}'" "$step_label" "$ACTUAL_OUTPUT_A"
done

# 12. Step 12 (R2 CORS policy) must appear — triggered by FRONTEND_URL + R2_KEY_ID
assert_contains "[A] Step 12 (R2 CORS policy) present" \
  "Step 12 — R2 CORS policy" "$ACTUAL_OUTPUT_A"

# 13. Step 12 lists the custom domain as the allowed origin
assert_contains "[A] Step 12 lists custom domain as AllowedOrigin" \
  "https://$CUSTOM_DOMAIN_A" "$ACTUAL_OUTPUT_A"

# 14. Step 10 (Option B CORS update) must NOT appear for Option A
assert_not_contains "[A] Step 10 (Option B only) absent" \
  "Step 10" "$ACTUAL_OUTPUT_A"

# 15. Closing "no changes" notice
assert_contains "[A] closing no-changes notice present" \
  "No Cloudflare API calls, no wrangler commands, and no file" "$ACTUAL_OUTPUT_A"

# 16. Neither wrangler nor curl were actually invoked
assert_file_empty "[A] wrangler was not invoked (PATH or absolute path)" "$INVOCATION_LOG"
assert_file_empty "[A] curl was not invoked"                             "$INVOCATION_LOG"

# =============================================================================
# Scenario 3 — Bad inputs: script must exit non-zero before anything runs
# =============================================================================

# Reset the invocation log between scenarios so leakage is caught per-scenario.
> "$INVOCATION_LOG"

# ── 3a: Invalid routing option ────────────────────────────────────────────────
# Prompts until die():
#   1. Cloudflare Account ID
#   2. Cloudflare API Token
#   3. Worker name            (Enter → default)
#   4. R2 bucket name         (Enter → default)
#   5. Pages project name     (Enter → default)
#   6. Routing option         → X  (invalid → die)
#
# Note: inputs are written to a temp file rather than stored in a variable so
# that trailing empty lines are preserved (command substitution strips them).

echo
echo "=== Scenario 3a: Invalid routing option ==="
echo "Running: bash deploy.sh --dry-run"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

printf '%s\n' \
  "acct-12345678" \
  "fake-api-token" \
  "" \
  "" \
  "" \
  "X" \
  > "$TMP_DIR/input_3a"

OUTPUT_3A=""
EXIT_3A=0
OUTPUT_3A=$(PATH="$FAKE_BIN:$PATH" bash "$REPO_ROOT/deploy.sh" --dry-run \
  < "$TMP_DIR/input_3a" 2>&1) || EXIT_3A=$?

echo "$OUTPUT_3A"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo

echo "Assertions (Scenario 3a — Invalid routing option):"

assert_exit_nonzero "[3a] exit code is non-zero" "$EXIT_3A"
assert_contains      "[3a] error message mentions valid choices" \
  "Enter A or B." "$OUTPUT_3A"
assert_file_empty    "[3a] wrangler was not invoked" "$INVOCATION_LOG"
assert_file_empty    "[3a] curl was not invoked"     "$INVOCATION_LOG"

# ── 3b: Empty custom domain with Option A ────────────────────────────────────
# Prompts until die():
#   1. Cloudflare Account ID
#   2. Cloudflare API Token
#   3. Worker name            (Enter → default)
#   4. R2 bucket name         (Enter → default)
#   5. Pages project name     (Enter → default)
#   6. Routing option         → A
#   7. Custom domain          → "" (empty → die)

> "$INVOCATION_LOG"

echo
echo "=== Scenario 3b: Empty custom domain (Option A) ==="
echo "Running: bash deploy.sh --dry-run"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

printf '%s\n' \
  "acct-12345678" \
  "fake-api-token" \
  "" \
  "" \
  "" \
  "A" \
  "" \
  > "$TMP_DIR/input_3b"

OUTPUT_3B=""
EXIT_3B=0
OUTPUT_3B=$(PATH="$FAKE_BIN:$PATH" bash "$REPO_ROOT/deploy.sh" --dry-run \
  < "$TMP_DIR/input_3b" 2>&1) || EXIT_3B=$?

echo "$OUTPUT_3B"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo

echo "Assertions (Scenario 3b — Empty custom domain):"

assert_exit_nonzero "[3b] exit code is non-zero" "$EXIT_3B"
assert_contains      "[3b] error message mentions custom domain requirement" \
  "Custom domain is required for Option A." "$OUTPUT_3B"
assert_file_empty    "[3b] wrangler was not invoked" "$INVOCATION_LOG"
assert_file_empty    "[3b] curl was not invoked"     "$INVOCATION_LOG"

# ── 3c: ENABLE_R2=Y but empty R2 credentials ─────────────────────────────────
# Prompts until die():
#   1. Cloudflare Account ID
#   2. Cloudflare API Token
#   3. Worker name            (Enter → default)
#   4. R2 bucket name         (Enter → default)
#   5. Pages project name     (Enter → default)
#   6. Routing option         → B  (no custom domain needed)
#   7. SESSION_SECRET         (Enter → auto-generate)
#   8. hCaptcha secret key    (Enter → skip)
#   9. Enable large-file R2 uploads? → Y
#  10. R2 Access Key ID       → "" (empty)
#  11. R2 Secret Access Key   → "" (empty → die: both required)

> "$INVOCATION_LOG"

echo
echo "=== Scenario 3c: Missing R2 credentials (ENABLE_R2=Y, empty keys) ==="
echo "Running: bash deploy.sh --dry-run"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

printf '%s\n' \
  "acct-12345678" \
  "fake-api-token" \
  "" \
  "" \
  "" \
  "B" \
  "" \
  "" \
  "Y" \
  "" \
  "" \
  > "$TMP_DIR/input_3c"

OUTPUT_3C=""
EXIT_3C=0
OUTPUT_3C=$(PATH="$FAKE_BIN:$PATH" bash "$REPO_ROOT/deploy.sh" --dry-run \
  < "$TMP_DIR/input_3c" 2>&1) || EXIT_3C=$?

echo "$OUTPUT_3C"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo

echo "Assertions (Scenario 3c — Missing R2 credentials):"

assert_exit_nonzero "[3c] exit code is non-zero" "$EXIT_3C"
assert_contains      "[3c] error message mentions R2 credentials requirement" \
  "Both R2 credentials are required when large-file uploads are enabled." "$OUTPUT_3C"
assert_file_empty    "[3c] wrangler was not invoked" "$INVOCATION_LOG"
assert_file_empty    "[3c] curl was not invoked"     "$INVOCATION_LOG"

# ── summary ──────────────────────────────────────────────────────────────────

echo
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Results: $PASS passed, $FAIL failed"

if [[ "$FAIL" -gt 0 ]]; then
  echo
  echo "Failed assertions:"
  printf '%b' "$FAILURES"
  exit 1
fi

echo "All assertions passed."
exit 0
