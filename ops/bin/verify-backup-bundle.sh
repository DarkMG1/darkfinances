#!/usr/bin/env bash
set -euo pipefail
umask 077

archive="${1:-}"
if [ -z "$archive" ] || [ ! -f "$archive" ]; then
  echo "Usage: $0 <dashboard-runtime-backup-bundle.tgz>" >&2
  exit 2
fi

extracted="${DARKFINANCES_BUNDLE_EXTRACT_DIR:-}"
temp=""
cleanup() {
  if [ -n "$temp" ] && [ -d "$temp" ]; then
    rm -rf "$temp"
  fi
}
trap cleanup EXIT

if [ -z "$extracted" ]; then
  temp="$(mktemp -d "${TMPDIR:-/tmp}/darkfinances-bundle-verify.XXXXXX")"
  extracted="$temp"
fi

tar -xzf "$archive" -C "$extracted"
node "$extracted/tooling/ops/bin/verify-backup-bundle.js" "$extracted"
