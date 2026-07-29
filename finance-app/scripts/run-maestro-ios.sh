#!/usr/bin/env bash
set -euo pipefail

DEVICE="${DEVICE:-booted}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
export DEVICE

mkdir -p "$APP_ROOT/build/maestro/screenshots"
MAESTRO_ARTIFACT_DIR="${MAESTRO_ARTIFACT_DIR:-$APP_ROOT/build/maestro/results}"
mkdir -p "$MAESTRO_ARTIFACT_DIR"
maestro_command=(
  test
  "--test-output-dir=$MAESTRO_ARTIFACT_DIR"
  "--debug-output=$MAESTRO_ARTIFACT_DIR"
  --flatten-debug-output
  "$@"
)

needs_biometric_matcher() {
  for arg in "$@"; do
    if [[ "$arg" == *privacy-unlock* ]]; then
      return 0
    fi
    if [[ "$arg" == .maestro || "$arg" == */.maestro ]]; then
      return 0
    fi
  done
  return 1
}

cleanup_matcher() {
  bash "$SCRIPT_DIR/ios-sim-biometrics.sh" stop || true
}

export MAESTRO_APP_ID
MAESTRO_APP_ID="$(node "$SCRIPT_DIR/resolve-maestro-app-id.js")"

bash "$SCRIPT_DIR/ios-sim-biometrics.sh" enroll

if needs_biometric_matcher "$@"; then
  trap cleanup_matcher EXIT INT TERM
  maestro "${maestro_command[@]}" &
  maestro_pid=$!
  bash "$SCRIPT_DIR/ios-sim-biometrics.sh" start-match-loop "$maestro_pid"
  wait "$maestro_pid"
  exit $?
fi

maestro "${maestro_command[@]}"
