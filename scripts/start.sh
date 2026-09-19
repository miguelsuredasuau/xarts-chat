#!/usr/bin/env bash
# Starts xarts-chat on Node 22 (node:sqlite + the Xarts SDK engine range).
set -euo pipefail
cd "$(dirname "$0")/.."
runtime="${XARTS_NODE22_HOME:-$HOME/.local/share/xarts/node-v22.22.1-darwin-arm64}"
if [ "$(node --version 2>/dev/null | cut -d. -f1)" != "v22" ]; then export PATH="$runtime/bin:$PATH"; fi
[ -f data/finance.sqlite ] || node --no-warnings scripts/build-db.mjs
exec node --no-warnings server/main.mjs
