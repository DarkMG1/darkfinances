#!/usr/bin/env bash
set -uo pipefail

export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:/usr/bin:/bin"
unit="${1:-actual-sync.service}"
target="$(
  openclaw cron list --json 2>/dev/null |
    /usr/bin/node -e '
      let raw = "";
      process.stdin.on("data", (chunk) => raw += chunk);
      process.stdin.on("end", () => {
        const payload = JSON.parse(raw);
        const job = (payload.jobs || []).find((item) => item.name === "finance-morning");
        if (job?.delivery?.to) process.stdout.write(String(job.delivery.to));
      });
    ' 2>/dev/null || true
)"

if [ -z "$target" ]; then
  echo "finance sync alert: no Telegram target available" >&2
  exit 1
fi

message="DarkFinances alert: ${unit} failed at $(date '+%Y-%m-%d %H:%M:%S %Z'). Bank transactions may be stale. Check: systemctl --user status ${unit}"
args=(message send --channel telegram --target "$target" --message "$message")
if [ "${ALERT_DRY_RUN:-0}" = "1" ]; then
  args+=(--dry-run)
fi
openclaw "${args[@]}"
