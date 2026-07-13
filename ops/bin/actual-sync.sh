#!/usr/bin/env bash
set -euo pipefail

set -a
. "$HOME/.config/openclaw/secrets.env"
set +a
export NODE_PATH="$HOME/.npm-global/lib/node_modules"
export ACTUAL_DATA_DIR="$HOME/actual/cache"

node "$HOME/actual/bank-sync.js"

if [ -n "${COLLECTION_EVENT:-}" ] && [ -f "$HOME/actual-tools/collection-rules.json" ]; then
  CONFIRM=1 bash "$HOME/actual-tools/run.sh" event-collect.js ||
    echo "event collection automation failed" >&2
fi
