#!/usr/bin/env bash
# Reusable runner for the Actual reporting tools. Usage: bash ~/actual-tools/run.sh <script.js>
set -euo pipefail
umask 077
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

resolve_direct_script() {
  python3 - "$DIR" "$1" <<'PY'
import os, pathlib, stat, sys

root = pathlib.Path(sys.argv[1]).resolve()
name = sys.argv[2]

if not name or name.startswith('-') or name in {'.', '..'}:
    raise SystemExit(f'refusing script name: {name!r}')
if os.path.isabs(name) or '/' in name or '\\' in name:
    raise SystemExit(f'refusing non-direct script path: {name!r}')

candidate = root / name
try:
    st = candidate.lstat()
except FileNotFoundError:
    raise SystemExit(f'Tool not found: {candidate}')

if candidate.is_symlink():
    raise SystemExit(f'refusing symlink script: {name!r}')
if not stat.S_ISREG(st.st_mode):
    raise SystemExit(f'refusing non-regular script: {name!r}')

resolved = candidate.resolve()
if resolved.parent != root:
    raise SystemExit(f'refusing script outside tool directory: {name!r}')

print(resolved)
PY
}

read_fix_data_dir_from_env_file() {
  python3 - "$DIR/.actual.env" <<'PY'
import pathlib, re, sys

env_path = pathlib.Path(sys.argv[1])
if not env_path.is_file():
    raise SystemExit(f'missing Actual environment file: {env_path}')
text = env_path.read_text()
match = re.search(r'^\s*(?:export\s+)?FIX_DATA_DIR=(.+?)\s*(?:#.*)?$', text, re.M)
if not match:
    raise SystemExit('FIX_DATA_DIR must point to a disposable Actual cache')
value = match.group(1).strip()
if len(value) >= 2 and value[0] == value[-1] and value[0] in '"\'':
    value = value[1:-1]
print(value)
PY
}

resolve_safe_data_dir() {
  python3 - "$1" <<'PY'
import os, pathlib, stat, sys

p = pathlib.Path(os.path.abspath(pathlib.Path(sys.argv[1]).expanduser()))
home = pathlib.Path(os.path.abspath(pathlib.Path.home()))
allowed = [pathlib.Path('/tmp'), home / '.cache/actual-tools']

for root in allowed:
    if p != root and root not in p.parents:
        continue
    try:
        root_st = root.lstat()
    except FileNotFoundError:
        continue
    if stat.S_ISLNK(root_st.st_mode):
        raise SystemExit(f'refusing symlink allowlist root for FIX_DATA_DIR: {root}')
    if not stat.S_ISDIR(root_st.st_mode):
        raise SystemExit(f'refusing non-directory allowlist root for FIX_DATA_DIR: {root}')

try:
    st = p.lstat()
except FileNotFoundError:
    raise SystemExit(f'refusing missing FIX_DATA_DIR (create it with mode 0700 first): {p}')
if stat.S_ISLNK(st.st_mode):
    raise SystemExit(f'refusing symlink FIX_DATA_DIR: {p}')

p = p.resolve(strict=True)
real_allowed = []
for root in allowed:
    try:
        root_st = root.lstat()
    except FileNotFoundError:
        continue
    if stat.S_ISDIR(root_st.st_mode) and not stat.S_ISLNK(root_st.st_mode):
        real_allowed.append(root)

if str(p) in {'/', str(pathlib.Path.home().resolve())} or not any(root in p.parents for root in real_allowed):
    raise SystemExit(f'refusing unsafe FIX_DATA_DIR: {p}')
if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.getuid():
    raise SystemExit(f'refusing unowned or non-directory FIX_DATA_DIR: {p}')
print(p)
PY
}

if [ "$#" -lt 1 ]; then
  echo "Usage: bash $0 <script.js>" >&2
  exit 2
fi
SCRIPT="$1"

if ! SAFE_SCRIPT="$(resolve_direct_script "$SCRIPT")"; then
  exit 2
fi

if ! FIX_DATA_DIR="$(read_fix_data_dir_from_env_file)"; then
  exit 2
fi

if ! SAFE_DATA_DIR="$(resolve_safe_data_dir "$FIX_DATA_DIR")"; then
  exit 2
fi

source "$DIR/.actual.env"
# Optional: Splitwise creds so reporting tools can pull live authoritative balances. Non-fatal.
[ -f "$DIR/.splitwise.env" ] && source "$DIR/.splitwise.env"

if ! POST_SOURCE_SAFE_DATA_DIR="$(resolve_safe_data_dir "${FIX_DATA_DIR}")"; then
  exit 2
fi
if [ "$POST_SOURCE_SAFE_DATA_DIR" != "$SAFE_DATA_DIR" ]; then
  echo "refusing FIX_DATA_DIR change after credential load: ${FIX_DATA_DIR}" >&2
  exit 2
fi

rm -rf "$SAFE_DATA_DIR"
mkdir -p "$SAFE_DATA_DIR"
chmod 700 "$SAFE_DATA_DIR"

# TOCTOU boundary: re-validate the script immediately before execution. A local operator
# with write access to actual-tools can still swap the file after this check; that trust
# boundary is intentionally limited to the invoking user account.
if ! SAFE_SCRIPT="$(resolve_direct_script "$SCRIPT")"; then
  exit 2
fi

node "$SAFE_SCRIPT" 2>&1 | awk '!/Breadcrumb|Syncing|Got messages|Loading|message:|^}/'
