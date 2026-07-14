#!/usr/bin/env bash
set -euo pipefail

export FREE_IOS_SIDELOAD=1
export EXPO_PUBLIC_FINANCE_DEMO_URL="${EXPO_PUBLIC_FINANCE_DEMO_URL:-https://finances.darkmg1.dev}"

APP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$APP_ROOT/.." && pwd)"
cd "$APP_ROOT"
output="$APP_ROOT/build/sideload"
case "$output" in
  "$APP_ROOT/build/sideload") ;;
  *) echo "Unsafe output path" >&2; exit 1 ;;
esac
rm -rf "$output"
expected_source_digest="$(node "$REPO_ROOT/scripts/release-manifest.js" --source-digest)"

npx expo prebuild --platform ios --clean --no-install
npx pod-install ios
xcodebuild \
  -workspace ios/Finances.xcworkspace \
  -scheme Finances \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  CODE_SIGNING_ALLOWED=NO \
  CODE_SIGNING_REQUIRED=NO \
  CODE_SIGN_IDENTITY='' \
  build

app_path="$(
  xcodebuild \
    -workspace ios/Finances.xcworkspace \
    -scheme Finances \
    -configuration Release \
    -destination 'generic/platform=iOS' \
    -showBuildSettings -json |
  python3 -c 'import json,sys,os; data=json.load(sys.stdin); app=next(x for x in data if x.get("target")=="Finances"); s=app["buildSettings"]; print(os.path.join(s["TARGET_BUILD_DIR"],s["WRAPPER_NAME"]))'
)"
version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app_path/Info.plist")"
build_number="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$app_path/Info.plist")"
mkdir -p "$output/Payload"
cp -R "$app_path" "$output/Payload/Finances.app"
test ! -e "$output/Payload/Finances.app/embedded.mobileprovision"
test ! -e "$output/Payload/Finances.app/PlugIns/ExpoWidgetsTarget.appex"
(
  cd "$output"
  ditto -c -k --sequesterRsrc --keepParent Payload "DarkFinances-${version}-${build_number}-unsigned.ipa"
  shasum -a 256 "DarkFinances-${version}-${build_number}-unsigned.ipa"
)
node "$REPO_ROOT/scripts/release-manifest.js" \
  --mode=ipa \
  --variant=free-sideload \
  --expected-source-digest="$expected_source_digest" \
  --artifact="$output/DarkFinances-${version}-${build_number}-unsigned.ipa" \
  "$output/DarkFinances-${version}-${build_number}-release-manifest.json"
