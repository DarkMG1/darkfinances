#!/usr/bin/env bash
set -euo pipefail
umask 077

dashboard="${FINANCE_DASHBOARD_DIR:-$HOME/finance-dashboard}"
destination="${DARKFINANCES_BACKUP_DIR:-$HOME/darkfinances-backups}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
archive="$destination/dashboard-runtime-$timestamp.tgz"
repo_root="$(cd "$(dirname "$0")/../.." && pwd)"

mkdir -p -m 700 "$destination"
files=()
for name in \
  account-overrides.json bills-paid.json budget-settings.json debt-planner.json \
  events.json goals.json investment-holdings.json manual-assets.json owes-config.json \
  owes-truth.json passkey-credentials.json personal-config.json phantom-log.json \
  phantom-seen.json receipts.json reimb-links.json reimb-suggest.json \
  reconciliation.json recurring-overrides.json review-state.json rules.json \
  operation-journal.json transaction-deletion-sagas.json bulk-operation-sagas.json repayment-confirmation-sagas.json transaction-sagas.json \
  venmo-truth.json receipts
do
  if [ -e "$dashboard/$name" ]; then files+=("$name"); fi
done

if [ "${#files[@]}" -eq 0 ]; then
  echo "No dashboard runtime files found in $dashboard" >&2
  exit 1
fi

manifest_json="$(node "$repo_root/ops/lib/write-backup-manifest.js" "$dashboard" "$archive" "${files[@]}")"
printf '%s\n' "$manifest_json" > "$dashboard/.backup-manifest.json"
chmod 600 "$dashboard/.backup-manifest.json"
cleanup() { rm -f "$dashboard/.backup-manifest.json"; }
trap cleanup EXIT

tar -C "$dashboard" -czf "$archive" "${files[@]}" .backup-manifest.json
chmod 600 "$archive"
printf '%s\n' "$manifest_json" > "$archive.manifest.json"
chmod 600 "$archive.manifest.json"

if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$archive" > "$archive.sha256"
else
  shasum -a 256 "$archive" > "$archive.sha256"
fi
chmod 600 "$archive.sha256"
echo "$archive"
