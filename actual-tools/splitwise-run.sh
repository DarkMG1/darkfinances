#!/usr/bin/env bash
# Wrapper for splitwise-pull.js — sources Splitwise creds then runs the pull.
# Usage: bash ~/actual-tools/splitwise-run.sh [args passed to splitwise-pull.js]
#   e.g. bash ~/actual-tools/splitwise-run.sh --group "summer trip" --print
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$DIR/.splitwise.env"
if [ "${1:-}" = "--reconcile" ]; then
  shift
  node "$DIR/splitwise-reconcile.js" --group "$@"
else
  node "$DIR/splitwise-pull.js" "$@"
fi
