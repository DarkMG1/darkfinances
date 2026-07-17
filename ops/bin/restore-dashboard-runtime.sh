#!/usr/bin/env bash
set -euo pipefail
umask 077

archive="${1:-}"
dashboard="${FINANCE_DASHBOARD_DIR:-$HOME/finance-dashboard}"
ops_root="$(cd "$(dirname "$0")/.." && pwd)"
restore_cli="$ops_root/lib/staged-restore-cli.js"

if [ -z "$archive" ] || [ ! -f "$archive" ]; then
  echo "Usage: RESTORE_QUIESCENCE_ADMISSION_PATH=/path/to/token.json $0 <dashboard-runtime-backup-bundle.tgz>" >&2
  echo "Dry run (default): performs every restore check without writing destination bytes." >&2
  echo "Live swap: CONFIRM=1 plus a PR-18 quiescence admission token." >&2
  exit 2
fi

if [ ! -f "$restore_cli" ]; then
  echo "missing restore CLI: $restore_cli" >&2
  exit 2
fi

args=(--dry-run "$archive")
if [ "${CONFIRM:-0}" = "1" ]; then
  args=(--confirm "$archive")
fi

export FINANCE_DASHBOARD_DIR="$dashboard"
set +e
node "$restore_cli" "${args[@]}"
status=$?
set -e

if [ "$status" = "2" ]; then
  exit 2
fi
exit "$status"
