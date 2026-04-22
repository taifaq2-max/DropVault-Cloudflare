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

# ── known inputs (simulating interactive answers) ─────────────────────────────
# Prompts in order during --dry-run:
#   1. Cloudflare Account ID
#   2. Cloudflare API Token (read -s, hidden)
#   3. Worker name            [default: vaultdrop-api]
#   4. R2 bucket name         [default: vaultdrop-shares]
#   5. Cloudflare Pages project name [default: vaultdrop]
#   6. Routing option         [default: B]
#   7. SESSION_SECRET         (Enter → auto-generate)
#   8. hCaptcha secret key    (Enter → skip CAPTCHA)
#   9. Enable large-file R2 uploads? [default: N]

ACCOUNT_ID="acct-12345678"
WORKER_NAME="my-vaultdrop-worker"
R2_BUCKET="my-vaultdrop-bucket"
PAGES_PROJECT="my-vaultdrop-pages"

INPUT="$(printf '%s\n' \
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

# ── run deploy.sh --dry-run ───────────────────────────────────────────────────

echo
echo "Running: bash deploy.sh --dry-run"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Prepend fake bin so our stubs shadow any wrangler/curl found on PATH.
# The absolute-path stub handles invocations via the hardcoded binary path.
ACTUAL_OUTPUT=""
EXIT_CODE=0
ACTUAL_OUTPUT=$(PATH="$FAKE_BIN:$PATH" bash "$REPO_ROOT/deploy.sh" --dry-run \
  <<< "$INPUT" 2>&1) || EXIT_CODE=$?

echo "$ACTUAL_OUTPUT"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo

# ── assertions ───────────────────────────────────────────────────────────────

echo "Assertions:"

# 1. Exit code must be 0
assert_exit_zero "exit code is 0" "$EXIT_CODE"

# 2. Dry-run banner
assert_contains "dry-run banner present" \
  "DRY-RUN MODE" "$ACTUAL_OUTPUT"

# 3. Deployment plan heading
assert_contains "deployment plan heading" \
  "DEPLOYMENT PLAN" "$ACTUAL_OUTPUT"

# 4. Worker name in plan
assert_contains "worker name appears in plan" \
  "$WORKER_NAME" "$ACTUAL_OUTPUT"

# 5. R2 bucket name in plan
assert_contains "R2 bucket name appears in plan" \
  "$R2_BUCKET" "$ACTUAL_OUTPUT"

# 6. Pages project name in plan
assert_contains "Pages project name appears in plan" \
  "$PAGES_PROJECT" "$ACTUAL_OUTPUT"

# 7. Account ID in plan
assert_contains "Cloudflare account ID appears in plan" \
  "$ACCOUNT_ID" "$ACTUAL_OUTPUT"

# 8. KV namespace titles (derived as <worker>-SHARE_KV and <worker>-SHARE_KV_preview)
assert_contains "production KV namespace title in plan" \
  "${WORKER_NAME}-SHARE_KV" "$ACTUAL_OUTPUT"

assert_contains "preview KV namespace title in plan" \
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
  assert_contains "plan includes '${step_label}'" "$step_label" "$ACTUAL_OUTPUT"
done

# 10. Closing "no changes" notice
assert_contains "closing no-changes notice present" \
  "No Cloudflare API calls, no wrangler commands, and no file" "$ACTUAL_OUTPUT"

# 11. Neither wrangler nor curl were actually invoked (checks both PATH stub
#     and absolute-path stub via the shared INVOCATION_LOG).
assert_file_empty "wrangler was not invoked (PATH or absolute path)" "$INVOCATION_LOG"
assert_file_empty "curl was not invoked"                             "$INVOCATION_LOG"

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
