#!/usr/bin/env bash
#
# Publish an over-the-air JS update via EAS Update.
#
# OTA lets you ship JS/asset changes to an already-sideloaded build without
# rebuilding/re-installing the IPA — as long as the native runtimeVersion
# (app.json -> runtimeVersion.policy = "appVersion") is unchanged.
#
# One-time setup (needs a free Expo account):
#   npx eas-cli@latest login
#   npx eas-cli@latest update:configure      # writes updates.url + extra.eas.projectId into app.json
#   # then rebuild + sideload one IPA so the native side knows the update URL.
#
# Usage:
#   npm run ota:publish                       # branch "production"
#   bash scripts/ota-publish.sh preview "fix budget rounding"
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

BRANCH="${1:-production}"
MESSAGE="${2:-OTA update $(date +%Y-%m-%d-%H:%M)}"
ENVIRONMENT="${3:-$BRANCH}"  # EAS env (development|preview|production); mirrors the branch

echo "==> Publishing OTA update to branch '$BRANCH' (env '$ENVIRONMENT')"
npx eas-cli@latest update --branch "$BRANCH" --message "$MESSAGE" --environment "$ENVIRONMENT"
