#!/usr/bin/env bash
set -euo pipefail
umask 077

archive="${1:-}"
dashboard="${FINANCE_DASHBOARD_DIR:-$HOME/finance-dashboard}"
if [ -z "$archive" ] || [ ! -f "$archive" ]; then
  echo "Usage: CONFIRM=1 $0 <dashboard-runtime.tgz>" >&2
  exit 2
fi
if [ "${CONFIRM:-0}" != "1" ]; then
  echo "Dry run only. Archive contents:" >&2
  tar -tzf "$archive" >&2
  echo "Re-run with CONFIRM=1 after stopping finance-dashboard.service." >&2
  exit 2
fi
if command -v systemctl >/dev/null 2>&1 && systemctl --user is-active --quiet finance-dashboard.service; then
  echo "Refusing restore while finance-dashboard.service is active." >&2
  exit 1
fi

while IFS= read -r entry; do
  case "$entry" in
    /*|../*|*/../*|*/..) echo "Unsafe archive path: $entry" >&2; exit 1 ;;
  esac
done < <(tar -tzf "$archive")

if compgen -G "$dashboard/*.json" >/dev/null || [ -d "$dashboard/receipts" ]; then
  "$(dirname "$0")/backup-dashboard-runtime.sh" >/dev/null
fi
tar -xzf "$archive" -C "$dashboard"
chmod 600 "$dashboard"/*.json 2>/dev/null || true
if [ -d "$dashboard/receipts" ]; then
  chmod 700 "$dashboard/receipts"
  chmod 600 "$dashboard/receipts"/* 2>/dev/null || true
fi
echo "Restored $archive. Start finance-dashboard.service and verify /api/v1/ping."
