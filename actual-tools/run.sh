#!/usr/bin/env bash
# Reusable runner for the Actual reporting tools. Usage: bash ~/actual-tools/run.sh [reimb-report.js]
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$DIR/.actual.env"
# Optional: Splitwise creds so reporting tools can pull live authoritative balances. Non-fatal.
[ -f "$DIR/.splitwise.env" ] && source "$DIR/.splitwise.env"
rm -rf "$FIX_DATA_DIR"; mkdir -p "$FIX_DATA_DIR"
SCRIPT="${1:-reimb-report.js}"
node "$DIR/$SCRIPT" 2>&1 | grep -vE "Breadcrumb|Syncing|Got messages|Loading|message:|^}"
