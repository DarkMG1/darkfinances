#!/usr/bin/env bash
set -euo pipefail

DEVICE="${DEVICE:-booted}"
APP_ID="${APP_ID:-dev.darkmg1.finances}"
OUT_DIR="${OUT_DIR:-build/privacy-animation}"
FLOW="${FLOW:-.maestro/privacy-unlock.yaml}"

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR/frames"

echo "==> Enrolling simulator biometrics"
xcrun simctl spawn "$DEVICE" notifyutil -s com.apple.BiometricKit.enrollmentChanged 1 || true
xcrun simctl spawn "$DEVICE" notifyutil -p com.apple.BiometricKit.enrollmentChanged || true

echo "==> Starting screenshot sampler"
(
  for i in $(seq -w 1 900); do
    xcrun simctl io "$DEVICE" screenshot "$OUT_DIR/frames/frame-$i.png" >/dev/null 2>&1 || true
    sleep 0.08
  done
) &
SAMPLER_PID=$!

echo "==> Starting biometric matcher"
(
  for _ in $(seq 1 360); do
    xcrun simctl spawn "$DEVICE" notifyutil -p com.apple.BiometricKit_Sim.fingerTouch.match >/dev/null 2>&1 || true
    sleep 0.2
  done
) &
MATCHER_PID=$!

set +e
maestro test "$FLOW"
MAESTRO_EXIT=$?
set -e

wait "$SAMPLER_PID" || true
kill "$MATCHER_PID" >/dev/null 2>&1 || true

echo "==> Analyzing screenshot deltas"
python3 - "$OUT_DIR/frames" <<'PY'
from pathlib import Path
from PIL import Image, ImageChops, ImageStat
import sys

frames = sorted(Path(sys.argv[1]).glob("frame-*.png"))
if len(frames) < 2:
    print("Not enough frames captured.")
    sys.exit(2)

deltas = []
prev = Image.open(frames[0]).convert("RGB").resize((90, 180))
for frame in frames[1:]:
    cur = Image.open(frame).convert("RGB").resize((90, 180))
    stat = ImageStat.Stat(ImageChops.difference(prev, cur))
    deltas.append((frame.name, sum(stat.mean) / 3))
    prev = cur

meaningful = [(name, delta) for name, delta in deltas if delta > 0.75]
runs = []
run = []
for item in deltas:
    if item[1] > 0.75:
        run.append(item)
    elif run:
        runs.append(run)
        run = []
if run:
    runs.append(run)

longest = max((len(run) for run in runs), default=0)
peak = max((delta for _, delta in deltas), default=0)

print(f"frames={len(frames)} meaningful_deltas={len(meaningful)} longest_delta_run={longest} peak_delta={peak:.2f}")
if longest >= 4:
    print("Animation evidence: multiple consecutive changing frames captured.")
else:
    print("Animation evidence: weak/absent; transition likely jumped.")

print("Top deltas:")
for name, delta in sorted(deltas, key=lambda item: item[1], reverse=True)[:12]:
    print(f"  {name}: {delta:.2f}")
PY
ANALYZE_EXIT=$?

if [[ "$MAESTRO_EXIT" -ne 0 ]]; then
  echo "Maestro failed with exit code $MAESTRO_EXIT"
  exit "$MAESTRO_EXIT"
fi

exit "$ANALYZE_EXIT"
