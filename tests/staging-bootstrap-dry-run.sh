#!/usr/bin/env bash
# =============================================================================
# tests/staging-bootstrap-dry-run.sh — Automated test for staging-bootstrap.sh --dry-run
#
# Usage: bash tests/staging-bootstrap-dry-run.sh
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

# The absolute wrangler path that staging-bootstrap.sh constructs.
# We intercept this path so that any accidental direct invocation is captured.
ABS_WRANGLER_DIR="$REPO_ROOT/artifacts/cloudflare/node_modules/.bin"
ABS_WRANGLER="$ABS_WRANGLER_DIR/wrangler"
ABS_WRANGLER_BACKED_UP=false
ABS_WRANGLER_DIR_CREATED=false

# Build stub content (includes exported INVOCATION_LOG path).
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
chmod +x "$FAKE_BIN/wrangler" "$FAKE_BIN/curl"

# ── absolute-path wrangler stub ───────────────────────────────────────────────
# staging-bootstrap.sh sets WRANGLER_PATH="$CF_DIR/node_modules/.bin/wrangler".
# In dry-run mode it prints (but must never execute) that path.  We place a
# stub at the exact absolute path so any accidental direct invocation is
# recorded and causes the test to fail.

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
# Scenario 1 — Default Pages project name (press Enter)
# =============================================================================
#
# The only interactive prompt in --dry-run mode is:
#   "Staging Pages project name [vaultdrop-staging]:"
# Pressing Enter accepts the default "vaultdrop-staging".

echo
echo "=== Scenario 1: Default Pages project name ==="
echo "Running: bash scripts/staging-bootstrap.sh --dry-run"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

ACTUAL_OUTPUT=""
EXIT_CODE=0
ACTUAL_OUTPUT=$(PATH="$FAKE_BIN:$PATH" bash "$REPO_ROOT/scripts/staging-bootstrap.sh" --dry-run \
  <<< "" 2>&1) || EXIT_CODE=$?

echo "$ACTUAL_OUTPUT"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo

echo "Assertions (Scenario 1 — Default project name):"

# 1. Exit code must be 0
assert_exit_zero "[default] exit code is 0" "$EXIT_CODE"

# 2. Dry-run banner
assert_contains "[default] dry-run banner present" \
  "DRY-RUN MODE" "$ACTUAL_OUTPUT"

# 3. Default project name appears
assert_contains "[default] default Pages project name shown" \
  "vaultdrop-staging" "$ACTUAL_OUTPUT"

# 4. Default KV namespace title (derived from fixed worker name)
assert_contains "[default] staging KV namespace title shown" \
  "vaultdrop-api-staging-SHARE_KV" "$ACTUAL_OUTPUT"

# 5. Default R2 bucket name
assert_contains "[default] staging R2 bucket name shown" \
  "vaultdrop-shares-staging" "$ACTUAL_OUTPUT"

# 6. All dry-run action messages present
assert_contains "[default] dry-run pnpm install message" \
  "Would run: pnpm install" "$ACTUAL_OUTPUT"

assert_contains "[default] dry-run wrangler auth message" \
  "Would verify authentication" "$ACTUAL_OUTPUT"

assert_contains "[default] dry-run KV create message" \
  "Would create KV namespace" "$ACTUAL_OUTPUT"

assert_contains "[default] dry-run R2 create message" \
  "Would create R2 bucket" "$ACTUAL_OUTPUT"

assert_contains "[default] dry-run Pages create message" \
  "Would create Pages project" "$ACTUAL_OUTPUT"

# 7. Closing summary shows GitHub Secret value
assert_contains "[default] CF_PAGES_PROJECT_STAGING secret shown" \
  "CF_PAGES_PROJECT_STAGING" "$ACTUAL_OUTPUT"

assert_contains "[default] closing no-changes notice present" \
  "No Cloudflare API calls, no wrangler commands, and no file" "$ACTUAL_OUTPUT"

# 8. Neither wrangler nor curl were actually invoked
assert_file_empty "[default] wrangler was not invoked (PATH or absolute path)" "$INVOCATION_LOG"
assert_file_empty "[default] curl was not invoked"                              "$INVOCATION_LOG"

# =============================================================================
# Scenario 2 — Custom Pages project name
# =============================================================================

> "$INVOCATION_LOG"

CUSTOM_PROJECT="my-custom-staging"

echo
echo "=== Scenario 2: Custom Pages project name ('$CUSTOM_PROJECT') ==="
echo "Running: bash scripts/staging-bootstrap.sh --dry-run"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

ACTUAL_OUTPUT_2=""
EXIT_CODE_2=0
ACTUAL_OUTPUT_2=$(PATH="$FAKE_BIN:$PATH" bash "$REPO_ROOT/scripts/staging-bootstrap.sh" --dry-run \
  <<< "$CUSTOM_PROJECT" 2>&1) || EXIT_CODE_2=$?

echo "$ACTUAL_OUTPUT_2"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo

echo "Assertions (Scenario 2 — Custom project name):"

# 1. Exit code must be 0
assert_exit_zero "[custom] exit code is 0" "$EXIT_CODE_2"

# 2. Dry-run banner
assert_contains "[custom] dry-run banner present" \
  "DRY-RUN MODE" "$ACTUAL_OUTPUT_2"

# 3. Custom project name appears in the resource summary and in the Pages create message
assert_contains "[custom] custom Pages project name shown in summary" \
  "$CUSTOM_PROJECT" "$ACTUAL_OUTPUT_2"

# 4. CF_PAGES_PROJECT_STAGING secret value matches custom name
assert_contains "[custom] CF_PAGES_PROJECT_STAGING set to custom name" \
  "CF_PAGES_PROJECT_STAGING = $CUSTOM_PROJECT" "$ACTUAL_OUTPUT_2"

# 5. Default name must NOT appear as the selected project (custom replaced it)
assert_not_contains "[custom] default name not used as project name" \
  "CF_PAGES_PROJECT_STAGING = vaultdrop-staging" "$ACTUAL_OUTPUT_2"

# 6. KV and R2 resources are still shown (independent of Pages project name)
assert_contains "[custom] staging KV namespace title shown" \
  "vaultdrop-api-staging-SHARE_KV" "$ACTUAL_OUTPUT_2"

assert_contains "[custom] staging R2 bucket name shown" \
  "vaultdrop-shares-staging" "$ACTUAL_OUTPUT_2"

# 7. Closing no-changes notice
assert_contains "[custom] closing no-changes notice present" \
  "No Cloudflare API calls, no wrangler commands, and no file" "$ACTUAL_OUTPUT_2"

# 8. Neither wrangler nor curl were actually invoked
assert_file_empty "[custom] wrangler was not invoked (PATH or absolute path)" "$INVOCATION_LOG"
assert_file_empty "[custom] curl was not invoked"                              "$INVOCATION_LOG"

# =============================================================================
# Scenario 3 — Unknown argument: script must exit non-zero immediately
# =============================================================================

> "$INVOCATION_LOG"

echo
echo "=== Scenario 3: Unknown argument ==="
echo "Running: bash scripts/staging-bootstrap.sh --unknown-flag"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

OUTPUT_3=""
EXIT_3=0
OUTPUT_3=$(PATH="$FAKE_BIN:$PATH" bash "$REPO_ROOT/scripts/staging-bootstrap.sh" --unknown-flag \
  2>&1) || EXIT_3=$?

echo "$OUTPUT_3"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo

echo "Assertions (Scenario 3 — Unknown argument):"

assert_exit_nonzero "[unknown-arg] exit code is non-zero" "$EXIT_3"
assert_contains      "[unknown-arg] error mentions the bad argument" \
  "Unknown argument" "$OUTPUT_3"
assert_file_empty    "[unknown-arg] wrangler was not invoked" "$INVOCATION_LOG"
assert_file_empty    "[unknown-arg] curl was not invoked"     "$INVOCATION_LOG"

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
