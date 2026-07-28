#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
targets=(
  "$repo_root"/ops/bin/*.sh
  "$repo_root/scripts/ensure-cocoapods.sh"
  "$repo_root/actual-tools/run.sh"
  "$repo_root/actual-tools/splitwise-run.sh"
)

shellcheck_bin=""
if command -v shellcheck >/dev/null 2>&1; then
  shellcheck_bin="$(command -v shellcheck)"
elif [[ "$(uname -s)" == "Linux" && "$(uname -m)" == "x86_64" ]]; then
  shellcheck_bin="$(bash "$repo_root/scripts/ensure-shellcheck.sh")"
fi

if [[ -z "$shellcheck_bin" ]]; then
  if [[ "${CI:-}" == 'true' || "${GITHUB_ACTIONS:-}" == 'true' ]]; then
    echo 'shellcheck: required in CI but pinned bootstrap is unavailable on this runner' >&2
    exit 1
  fi
  echo 'shellcheck: skipped (not installed; Linux CI bootstraps the pinned binary via ensure-shellcheck.sh)'
  exit 0
fi

"$shellcheck_bin" -S warning -x "${targets[@]}"
