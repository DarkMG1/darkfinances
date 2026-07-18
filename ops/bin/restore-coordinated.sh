#!/usr/bin/env bash
set -euo pipefail
umask 077

repo_root="${DARKFINANCES_REPO_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
exec node "$repo_root/ops/lib/coordinated-restore-cli.js" "$@"
