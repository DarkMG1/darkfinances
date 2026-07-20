#!/usr/bin/env bash
set -euo pipefail
umask 077

archive="${1:-}"
if [ -z "$archive" ] || [ ! -f "$archive" ]; then
  echo "Usage: $0 <dashboard-runtime-backup-bundle.tgz>" >&2
  exit 2
fi

ops_root="$(cd "$(dirname "$0")/.." && pwd)"
verifier="$ops_root/lib/verify-backup-bundle-archive.js"
if [ ! -f "$verifier" ]; then
  echo "missing archive verifier: $verifier" >&2
  exit 2
fi

node "$verifier" "$archive"
