#!/usr/bin/env bash
#
# Build an UNSIGNED .ipa of the Finances app for sideloading.
#
# AltStore / Sideloadly / ESign re-sign the app with your personal Apple ID at
# install time, so we deliberately skip code signing here. The output is a plain
# Payload/<App>.app zipped as Finances.ipa.
#
# Requirements (macOS): Xcode + command line tools, CocoaPods (`brew install cocoapods`),
# and the JS deps installed (`npm install`).
#
# Usage:
#   npm run release:ios            # Release build
#   CONFIGURATION=Debug npm run release:ios
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CONFIGURATION="${CONFIGURATION:-Release}"
BUILD_DIR="$ROOT/build"
ARCHIVE_PATH="$BUILD_DIR/Finances.xcarchive"
IPA_DIR="$ROOT/dist"
IPA_PATH="$IPA_DIR/Finances.ipa"

echo "==> [1/5] Regenerating native iOS project (expo prebuild --clean)"
npx expo prebuild -p ios --clean

echo "==> [2/5] Installing CocoaPods"
( cd ios && pod install )

WORKSPACE="$(ls -d ios/*.xcworkspace | head -n1)"
SCHEME="$(basename "$WORKSPACE" .xcworkspace)"
echo "    workspace: $WORKSPACE"
echo "    scheme:    $SCHEME"

echo "==> [3/5] Archiving (unsigned, $CONFIGURATION)"
rm -rf "$ARCHIVE_PATH"
xcodebuild \
  -workspace "$WORKSPACE" \
  -scheme "$SCHEME" \
  -configuration "$CONFIGURATION" \
  -sdk iphoneos \
  -destination 'generic/platform=iOS' \
  -archivePath "$ARCHIVE_PATH" \
  CODE_SIGNING_ALLOWED=NO \
  CODE_SIGNING_REQUIRED=NO \
  CODE_SIGN_IDENTITY="" \
  AD_HOC_CODE_SIGNING_ALLOWED=YES \
  archive

APP_PATH="$(ls -d "$ARCHIVE_PATH/Products/Applications/"*.app | head -n1)"
echo "==> [4/5] Built: $APP_PATH"

echo "==> [5/5] Packaging unsigned IPA"
rm -rf "$BUILD_DIR/Payload"
mkdir -p "$BUILD_DIR/Payload" "$IPA_DIR"
cp -R "$APP_PATH" "$BUILD_DIR/Payload/"
rm -f "$IPA_PATH"
( cd "$BUILD_DIR" && zip -qry "$IPA_PATH" Payload )
rm -rf "$BUILD_DIR/Payload"

echo ""
echo "Done. Unsigned IPA -> $IPA_PATH"
echo "Sideload it with AltStore or Sideloadly; they re-sign with your Apple ID."
