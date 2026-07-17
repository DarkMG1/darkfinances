#!/usr/bin/env bash
set -euo pipefail
umask 077

dashboard="${FINANCE_DASHBOARD_DIR:-$HOME/finance-dashboard}"
destination="${DARKFINANCES_BACKUP_DIR:-$HOME/darkfinances-backups}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
archive="$destination/dashboard-runtime-backup-bundle-$timestamp.tgz"
repo_root="$(cd "$(dirname "$0")/../.." && pwd)"

mkdir -p -m 700 "$destination"
node "$repo_root/ops/lib/build-backup-bundle-cli.js" "$dashboard" "$archive"
