#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
targets=(
  "$repo_root"/ops/bin/*.sh
  "$repo_root/actual-tools/run.sh"
  "$repo_root/actual-tools/splitwise-run.sh"
)

if ! command -v shellcheck >/dev/null 2>&1; then
  echo 'shellcheck: skipped (not installed; install shellcheck locally to run this gate)'
  exit 0
fi

shellcheck -S warning -x "${targets[@]}"
