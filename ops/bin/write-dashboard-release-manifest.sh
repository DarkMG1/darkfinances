#!/usr/bin/env bash
set -euo pipefail
umask 077

repo_root="${DARKFINANCES_REPO_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
dashboard="${FINANCE_DASHBOARD_DIR:-$HOME/finance-dashboard}"
destination="${RELEASE_MANIFEST_PATH:-$dashboard/release-manifest.json}"

if [ ! -f "$repo_root/scripts/release-manifest.js" ] || [ ! -f "$repo_root/finance-dashboard/server.js" ]; then
  echo "DARKFINANCES_REPO_ROOT must identify the repository containing the exact deployed dashboard source" >&2
  exit 2
fi

node "$repo_root/scripts/release-manifest.js" \
  --mode=dashboard \
  --deployed-root="$dashboard" \
  "$destination"
