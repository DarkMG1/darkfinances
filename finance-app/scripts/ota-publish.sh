#!/usr/bin/env bash
#
# Publish an over-the-air JS update via EAS Update.
#
# OTA lets you ship JS/asset changes to an already-sideloaded build without
# rebuilding/re-installing the IPA — as long as the native runtimeVersion
# (app.json -> runtimeVersion.policy = "appVersion") is unchanged.
#
# One-time setup (needs a free Expo account):
#   node scripts/run-pinned-eas.js login
#   node scripts/run-pinned-eas.js update:configure      # writes updates.url + extra.eas.projectId into app.json
#   # then rebuild + sideload one IPA so the native side knows the update URL.
#
# Usage:
#   npm run ota:publish                       # branch "production"
#   bash scripts/ota-publish.sh preview "fix preview UI"
#   bash scripts/ota-publish.sh free-sideload "fix sideload UI"
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$ROOT/.." && pwd)"
cd "$ROOT"

BRANCH="${1:-production}"
MESSAGE="${2:-OTA update $(date +%Y-%m-%d-%H:%M)}"
REQUESTED_ENVIRONMENT="${3:-}"
case "$BRANCH" in
  production)
    unset FREE_IOS_SIDELOAD
    VARIANT="full"
    CHANNEL="production"
    ENVIRONMENT="production"
    ;;
  preview)
    unset FREE_IOS_SIDELOAD
    VARIANT="full"
    CHANNEL="preview"
    ENVIRONMENT="preview"
    ;;
  free-sideload)
    export FREE_IOS_SIDELOAD=1
    VARIANT="free-sideload"
    CHANNEL="free-sideload"
    ENVIRONMENT="production"
    ;;
  *)
    echo "Unsupported OTA branch '$BRANCH'; use production, preview, or free-sideload" >&2
    exit 2
    ;;
esac
if [ -n "$REQUESTED_ENVIRONMENT" ] && [ "$REQUESTED_ENVIRONMENT" != "$ENVIRONMENT" ]; then
  echo "EAS environment must be '$ENVIRONMENT' for '$BRANCH'" >&2
  exit 2
fi
if [ -n "${OTA_CHANNEL:-}" ] && [ "$OTA_CHANNEL" != "$CHANNEL" ]; then
  echo "OTA_CHANNEL must match the configured '$CHANNEL' channel" >&2
  exit 2
fi

node "$REPO_ROOT/scripts/release-manifest.js" \
  --check-profile="$BRANCH" \
  --variant="$VARIANT" >/dev/null
manifest_path="${OTA_MANIFEST_PATH:-$ROOT/dist/ota-release-manifest.json}"
node "$REPO_ROOT/scripts/release-manifest.js" --check-destination="$manifest_path" >/dev/null
rm -f "$manifest_path"
expected_source_digest="$(node "$REPO_ROOT/scripts/release-manifest.js" --source-digest)"
update_result="$(mktemp "${TMPDIR:-/tmp}/darkfinances-eas-update.XXXXXX")"
provenance_complete=0
cleanup() {
  if [ "$provenance_complete" = "1" ]; then
    rm -f "$update_result"
  else
    echo "OTA provenance failed; preserved EAS evidence at $update_result" >&2
  fi
}
trap cleanup EXIT

echo "==> Verifying pinned eas-cli publisher toolchain"
node -e "const { verifyPublisherToolchain } = require('$REPO_ROOT/finance-dashboard/lib/publisher-toolchain'); console.log(JSON.stringify(verifyPublisherToolchain('$REPO_ROOT', { verifyInstalled: true })));"

echo "==> Publishing OTA update to stable branch '$BRANCH' (channel '$CHANNEL', env '$ENVIRONMENT')"
node "$ROOT/scripts/run-pinned-eas.js" update \
  --branch "$BRANCH" \
  --message "$MESSAGE" \
  --environment "$ENVIRONMENT" \
  --json \
  --non-interactive |
  tee "$update_result"

node "$REPO_ROOT/scripts/release-manifest.js" \
  --mode=ota \
  --variant="$VARIANT" \
  --profile="$BRANCH" \
  --expected-source-digest="$expected_source_digest" \
  --ota-result="$update_result" \
  --ota-branch="$BRANCH" \
  "$manifest_path"
node "$REPO_ROOT/scripts/release-manifest.js" --verify="$manifest_path"
provenance_complete=1
