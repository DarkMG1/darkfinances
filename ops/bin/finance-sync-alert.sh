#!/usr/bin/env bash
set -uo pipefail

dry_run=0
unit=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run)
      dry_run=1
      shift
      ;;
    --)
      echo "finance-sync-alert.sh: unsupported option: --" >&2
      exit 2
      ;;
    -*)
      echo "finance-sync-alert.sh: unknown option: $1" >&2
      exit 2
      ;;
    *)
      if [ -n "$unit" ]; then
        echo "finance-sync-alert.sh: too many arguments" >&2
        exit 2
      fi
      unit="$1"
      shift
      ;;
  esac
done

if [ -z "$unit" ]; then
  unit="actual-sync.service"
fi

if [ "${ALERT_DRY_RUN:-0}" = "1" ]; then
  dry_run=1
fi

export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:/usr/bin:/bin"
NODE_BIN="$(command -v node 2>/dev/null || true)"
target="$(
  openclaw cron list --json 2>/dev/null |
    "${NODE_BIN:-node}" -e '
      const raw = require("fs").readFileSync(0, "utf8");
      const payload = JSON.parse(raw);
      const job = (payload.jobs || []).find((item) => item.name === "finance-morning");
      if (job && job.delivery && job.delivery.to) process.stdout.write(String(job.delivery.to));
    ' 2>/dev/null || true
)"

if [ -z "$target" ]; then
  echo "finance sync alert: no Telegram target available" >&2
  exit 1
fi

case "$unit" in
  finance-event-sync.service)
    impact="Who-owes snapshot data may be stale (Splitwise reimbursement balances)."
    ;;
  actual-sync.service)
    impact="Bank transactions may be stale."
    ;;
  *)
    impact="A scheduled finance job may not have completed successfully."
    ;;
esac

message="DarkFinances alert: ${unit} failed at $(date '+%Y-%m-%d %H:%M:%S %Z'). ${impact} Check: systemctl --user status ${unit}"
args=(message send --channel telegram --target "$target" --message "$message")
if [ "$dry_run" = "1" ]; then
  args+=(--dry-run)
fi
openclaw "${args[@]}"
