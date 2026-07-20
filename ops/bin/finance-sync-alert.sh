#!/usr/bin/env bash
set -uo pipefail

NODE_BIN="$(command -v node 2>/dev/null || true)"
export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:/usr/bin:/bin"
unit="${1:-actual-sync.service}"
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
if [ "${ALERT_DRY_RUN:-0}" = "1" ]; then
  args+=(--dry-run)
fi
openclaw "${args[@]}"
