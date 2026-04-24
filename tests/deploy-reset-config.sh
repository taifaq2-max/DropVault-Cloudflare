#!/usr/bin/env bash
# =============================================================================
# tests/deploy-reset-config.sh — Automated tests for deploy.sh --reset-config
#
# Covers:
#   1. --reset-config deletes .deploy.cfg when it exists and prints confirmation
#   2. --reset-config prints "nothing to reset" when .deploy.cfg is absent
#   3. --reset-config --dry-run exits non-zero with a clear error message
#
# Usage: bash tests/deploy-reset-config.sh
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
  if echo "$text" | grep -qF -- "$pattern"; then
    _pass "$label"
  else
    _fail "$label (pattern not found: '$pattern')"
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

assert_file_absent() {
  local label="$1" file="$2"
  if [[ ! -f "$file" ]]; then
    _pass "$label"
  else
    _fail "$label (file still exists: $file)"
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

cleanup() {
  if [[ "$CONFIG_BACKED_UP" == true ]]; then
    cp "$TMP_DIR/.deploy.cfg.bak" "$CONFIG_FILE"
  else
    rm -f "$CONFIG_FILE"
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

# =============================================================================
# TEST 1: --reset-config deletes .deploy.cfg when it exists
# =============================================================================
echo
echo "═══════════════════════════════════════════════════════════"
echo " TEST 1: --reset-config deletes .deploy.cfg when it exists"
echo "═══════════════════════════════════════════════════════════"

# Create a config file to be deleted.
cat > "$CONFIG_FILE" <<CFG
CF_ACCOUNT_ID=test-account-id
WORKER_NAME=test-worker
R2_BUCKET=test-bucket
PAGES_PROJECT=test-pages
ROUTING_OPTION=B
CUSTOM_DOMAIN=
HCAPTCHA_SITE_KEY=
ENABLE_R2=N
CFG

OUTPUT_1=""
EXIT_1=0
OUTPUT_1=$(bash "$REPO_ROOT/deploy.sh" --reset-config 2>&1) || EXIT_1=$?

echo "$OUTPUT_1"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo
echo "Assertions (TEST 1):"

assert_exit_zero   "test1: exit code is 0"                            "$EXIT_1"
assert_contains    "test1: confirmation message printed"              "Saved configuration deleted" "$OUTPUT_1"
assert_file_absent "test1: .deploy.cfg has been deleted"              "$CONFIG_FILE"

# =============================================================================
# TEST 2: --reset-config prints "nothing to reset" when .deploy.cfg is absent
# =============================================================================
echo
echo "═══════════════════════════════════════════════════════════"
echo " TEST 2: --reset-config with no .deploy.cfg present"
echo "═══════════════════════════════════════════════════════════"

# Ensure the config file is definitely absent.
rm -f "$CONFIG_FILE"

OUTPUT_2=""
EXIT_2=0
OUTPUT_2=$(bash "$REPO_ROOT/deploy.sh" --reset-config 2>&1) || EXIT_2=$?

echo "$OUTPUT_2"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo
echo "Assertions (TEST 2):"

assert_exit_zero "test2: exit code is 0"                              "$EXIT_2"
assert_contains  "test2: nothing-to-reset message printed"            "Nothing to reset" "$OUTPUT_2"

# =============================================================================
# TEST 3: --reset-config --dry-run exits non-zero with a clear error message
# =============================================================================
echo
echo "═══════════════════════════════════════════════════════════"
echo " TEST 3: --reset-config --dry-run is rejected"
echo "═══════════════════════════════════════════════════════════"

OUTPUT_3=""
EXIT_3=0
OUTPUT_3=$(bash "$REPO_ROOT/deploy.sh" --reset-config --dry-run 2>&1) || EXIT_3=$?

echo "$OUTPUT_3"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo
echo "Assertions (TEST 3):"

assert_exit_nonzero "test3: exit code is non-zero"                    "$EXIT_3"
assert_contains     "test3: error message mentions both flags"        "--reset-config" "$OUTPUT_3"
assert_contains     "test3: error message mentions --dry-run"         "--dry-run"      "$OUTPUT_3"

# Test the same order of flags reversed: --dry-run --reset-config
OUTPUT_3B=""
EXIT_3B=0
OUTPUT_3B=$(bash "$REPO_ROOT/deploy.sh" --dry-run --reset-config 2>&1) || EXIT_3B=$?

assert_exit_nonzero "test3b: reversed flag order also exits non-zero" "$EXIT_3B"
assert_contains     "test3b: error message present (reversed order)"  "--reset-config" "$OUTPUT_3B"

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
