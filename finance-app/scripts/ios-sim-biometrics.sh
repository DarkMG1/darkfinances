#!/usr/bin/env bash
set -euo pipefail

DEVICE="${DEVICE:-booted}"
PID_FILE="${PID_FILE:-build/maestro-biometric-matcher.pid}"

usage() {
  echo "usage: $0 enroll|start-match-loop <parent-pid>|stop" >&2
  exit 2
}

enroll() {
  xcrun simctl spawn "$DEVICE" notifyutil -s com.apple.BiometricKit.enrollmentChanged 1 || true
  xcrun simctl spawn "$DEVICE" notifyutil -p com.apple.BiometricKit.enrollmentChanged || true
}

start_match_loop() {
  local parent_pid="${1:?parent pid required}"
  mkdir -p build
  (
    while kill -0 "$parent_pid" 2>/dev/null; do
      xcrun simctl spawn "$DEVICE" notifyutil -p com.apple.BiometricKit_Sim.fingerTouch.match >/dev/null 2>&1 || true
      sleep 0.2
    done
  ) &
  echo $! > "$PID_FILE"
}

stop_match_loop() {
  if [[ -f "$PID_FILE" ]]; then
    kill "$(cat "$PID_FILE")" 2>/dev/null || true
    rm -f "$PID_FILE"
  fi
}

case "${1:-}" in
  enroll) enroll ;;
  start-match-loop) start_match_loop "${2:-}" ;;
  stop) stop_match_loop ;;
  *) usage ;;
esac
