#!/usr/bin/env bash
set -euo pipefail
umask 077

archive="${1:-}"
if [ -z "$archive" ] || [ ! -f "$archive" ]; then
  echo "Usage: $0 <dashboard-runtime.tgz>" >&2
  exit 2
fi

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
dashboard="${FINANCE_DASHBOARD_DIR:-}"
args=(node "$repo_root/ops/lib/verify-backup-archive.js" "$archive")
if [ -n "$dashboard" ]; then
  args+=("$dashboard")
fi
"${args[@]}"
