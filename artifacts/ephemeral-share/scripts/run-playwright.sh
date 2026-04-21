#!/usr/bin/env bash
# Playwright launcher for NixOS / Replit environments.
#
# Replit maintains REPLIT_LD_LIBRARY_PATH with all library paths derived from
# the system dependencies declared in replit.nix.  Prepending it to
# LD_LIBRARY_PATH gives the Playwright Chromium headless shell access to libs
# such as libgbm and libxkbcommon that are not in the standard linker cache.
#
# On non-Replit / standard-Linux systems REPLIT_LD_LIBRARY_PATH is unset, so
# the assignment is a no-op and Playwright relies on the system linker cache.
set -euo pipefail

export LD_LIBRARY_PATH="${REPLIT_LD_LIBRARY_PATH:-}${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec "$SCRIPT_DIR/../node_modules/.bin/playwright" test \
  --config "$SCRIPT_DIR/../playwright.config.ts" "$@"
