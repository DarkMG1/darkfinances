#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
contract="$repo_root/ops/toolchain/cocoapods-contract.json"
pod_bin="${ENSURE_COCOAPODS_POD:-}"
canonical_semver_re='^[0-9]+\.[0-9]+\.[0-9]+$'
prerelease_semver_re='^[0-9]+\.[0-9]+\.[0-9]+[-.+]'

if [[ "$(uname -s)" != "Darwin" ]]; then
  if [[ "${CI:-}" == "true" || "${GITHUB_ACTIONS:-}" == "true" ]]; then
    echo "ensure-cocoapods: required macOS CI runner but got $(uname -s)" >&2
    exit 1
  fi
  echo "ensure-cocoapods: skipped (unsupported platform $(uname -s); macOS CI verifies the pinned CocoaPods CLI)"
  exit 0
fi

expected_version="$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).version)" "$contract")"
if [[ ! "$expected_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "ensure-cocoapods: contract version must be canonical x.y.z, got ${expected_version:-<empty>}" >&2
  exit 1
fi

if [[ -z "$pod_bin" ]]; then
  if ! command -v pod >/dev/null 2>&1; then
    echo "ensure-cocoapods: pod not found on PATH; expected CocoaPods $expected_version (contract: $contract)" >&2
    exit 1
  fi
  pod_bin="$(command -v pod)"
fi

set +e
version_output="$("$pod_bin" --version 2>&1)"
pod_status=$?
set -e

if [[ "$pod_status" -ne 0 ]]; then
  echo "ensure-cocoapods: pod --version exited $pod_status; expected CocoaPods $expected_version" >&2
  if [[ -n "$version_output" ]]; then
    printf '%s\n' "$version_output" >&2
  fi
  exit 1
fi

if printf '%s\n' "$version_output" | grep -Eq "$prerelease_semver_re"; then
  echo "ensure-cocoapods: pod --version output contains prerelease semver; expected canonical $expected_version" >&2
  printf '%s\n' "$version_output" >&2
  exit 1
fi

canonical_count="$(printf '%s\n' "$version_output" | grep -Ec "$canonical_semver_re" || true)"
installed_version="$(printf '%s\n' "$version_output" | grep -E "$canonical_semver_re" | head -n1 || true)"

if [[ "$canonical_count" -eq 0 ]]; then
  echo "ensure-cocoapods: no canonical x.y.z version line in pod --version output; expected $expected_version" >&2
  printf '%s\n' "$version_output" >&2
  exit 1
fi

if [[ "$canonical_count" -gt 1 ]]; then
  echo "ensure-cocoapods: ambiguous pod --version output ($canonical_count canonical semver lines); expected exactly $expected_version" >&2
  printf '%s\n' "$version_output" >&2
  exit 1
fi

if [[ "$installed_version" != "$expected_version" ]]; then
  echo "ensure-cocoapods: expected CocoaPods $expected_version, got ${installed_version:-<empty>}" >&2
  printf '%s\n' "$version_output" >&2
  exit 1
fi

printf '%s\n' "$pod_bin"
