#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
contract="$repo_root/ops/toolchain/maestro-bootstrap.json"
cache_root="${XDG_CACHE_HOME:-$HOME/.cache}/darkfinances/maestro"
force="${ENSURE_MAESTRO_FORCE:-0}"

if [[ "$(uname -s)" != "Darwin" ]]; then
  if [[ "${CI:-}" == "true" || "${GITHUB_ACTIONS:-}" == "true" ]]; then
    echo "ensure-maestro: required macOS CI runner but got $(uname -s)" >&2
    exit 1
  fi
  echo "ensure-maestro: skipped (unsupported platform $(uname -s); macOS CI bootstraps the pinned binary)"
  exit 0
fi

args=(--contract="$contract" --cache-root="$cache_root")
if [[ "$force" == "1" ]]; then
  args+=(--force-download=1)
fi

binary_path="$(node "$repo_root/scripts/toolchain-bootstrap.js" "${args[@]}")"
version_output="$("$binary_path" --version 2>&1 || true)"
installed_version="$(printf '%s\n' "$version_output" | grep -Eo '[0-9]+\.[0-9]+\.[0-9]+' | head -n1)"
expected_version="$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).version)" "$contract")"
if [[ "$installed_version" != "$expected_version" ]]; then
  echo "ensure-maestro: expected Maestro $expected_version, got ${installed_version:-<empty>}" >&2
  if [[ -n "$version_output" ]]; then
    printf '%s\n' "$version_output" >&2
  fi
  exit 1
fi
printf '%s\n' "$binary_path"
