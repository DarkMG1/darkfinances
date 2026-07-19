#!/usr/bin/env bash
# Reusable runner for the Actual reporting tools. Usage: bash ~/actual-tools/run.sh <script.js>
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$DIR/.actual.env"
# Optional: Splitwise creds so reporting tools can pull live authoritative balances. Non-fatal.
[ -f "$DIR/.splitwise.env" ] && source "$DIR/.splitwise.env"
if [ "$#" -lt 1 ]; then
  echo "Usage: bash $0 <script.js>" >&2
  exit 2
fi
SCRIPT="$1"
if [ ! -f "$DIR/$SCRIPT" ]; then
  echo "Tool not found: $DIR/$SCRIPT" >&2
  exit 2
fi
: "${FIX_DATA_DIR:?FIX_DATA_DIR must point to a disposable Actual cache}"
SAFE_DATA_DIR="$(python3 - "$FIX_DATA_DIR" <<'PY'
import os, pathlib, sys
p = pathlib.Path(sys.argv[1]).expanduser().resolve()
allowed = [pathlib.Path('/tmp').resolve(), (pathlib.Path.home() / '.cache/actual-tools').resolve()]
if str(p) in {'/', str(pathlib.Path.home().resolve())} or not any(root in p.parents for root in allowed):
    raise SystemExit(f'refusing unsafe FIX_DATA_DIR: {p}')
try:
    st = p.stat()
except FileNotFoundError:
    raise SystemExit(f'refusing missing FIX_DATA_DIR (create it with mode 0700 first): {p}')
if not p.is_dir() or st.st_uid != os.getuid():
    raise SystemExit(f'refusing unowned or non-directory FIX_DATA_DIR: {p}')
print(p)
PY
)"
rm -rf "$SAFE_DATA_DIR"
mkdir -p "$SAFE_DATA_DIR"
chmod 700 "$SAFE_DATA_DIR"
node "$DIR/$SCRIPT" 2>&1 | awk '!/Breadcrumb|Syncing|Got messages|Loading|message:|^}/'
