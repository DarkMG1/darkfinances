#!/usr/bin/env bash
set -euo pipefail
umask 077

dashboard="${FINANCE_DASHBOARD_DIR:-$HOME/finance-dashboard}"
destination="${DARKFINANCES_BACKUP_DIR:-$HOME/darkfinances-backups}"
actual_data="${ACTUAL_DATA_DIR:-$HOME/actual/data}"
repo_root="${DARKFINANCES_REPO_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
bin_dir="$(cd "$(dirname "$0")" && pwd)"
quiesce="${BACKUP_QUIESCE:-1}"
include_actual="${BACKUP_INCLUDE_ACTUAL_DATA:-0}"

stopped_timer=0
stopped_dashboard=0

cleanup() {
  if [ "$stopped_dashboard" = "1" ] && command -v systemctl >/dev/null 2>&1; then
    systemctl --user start finance-dashboard.service >/dev/null 2>&1 || true
  fi
  if [ "$stopped_timer" = "1" ] && command -v systemctl >/dev/null 2>&1; then
    systemctl --user start actual-sync.timer >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

if [ "$quiesce" = "1" ] && command -v systemctl >/dev/null 2>&1; then
  if systemctl --user is-active --quiet actual-sync.timer; then
    systemctl --user stop actual-sync.timer
    stopped_timer=1
  fi
  if systemctl --user is-active --quiet finance-dashboard.service; then
    systemctl --user stop finance-dashboard.service
    stopped_dashboard=1
    for _ in $(seq 1 20); do
      if ! systemctl --user is-active --quiet finance-dashboard.service; then
        break
      fi
      sleep 0.5
    done
  fi
fi

runtime_archive="$("$bin_dir/backup-dashboard-runtime.sh")"
"$bin_dir/verify-backup.sh" "$runtime_archive"

manifest_path="$runtime_archive.manifest.json"
additional_backup_args=()
if [ "$include_actual" = "1" ] && [ -d "$actual_data" ]; then
  actual_archive="$destination/actual-data-$(date -u +%Y%m%dT%H%M%SZ).tgz"
  tar -C "$(dirname "$actual_data")" -czf "$actual_archive" "$(basename "$actual_data")"
  chmod 600 "$actual_archive"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$actual_archive" > "$actual_archive.sha256"
  else
    shasum -a 256 "$actual_archive" > "$actual_archive.sha256"
  fi
  chmod 600 "$actual_archive.sha256"
  additional_backup_args+=("--backup-additional-archive=$actual_archive")
  echo "$actual_archive"
fi

release_manifest_path="$destination/coordinated-release-$(basename "$runtime_archive" .tgz).json"
node "$repo_root/scripts/release-manifest.js" \
  --mode=backup \
  --backup-manifest="$manifest_path" \
  --backup-archive="$runtime_archive" \
  "${additional_backup_args[@]}" \
  "$release_manifest_path" >/dev/null
chmod 600 "$release_manifest_path"

echo "$runtime_archive"
