# Operations

- `actual-compose.yml` pins Actual Server to the same version as `@actual-app/api`.
- `systemd/` contains the reviewed user units deployed under `~/.config/systemd/user/`.
- `bin/backup-dashboard-runtime.sh` backs up non-Actual sidecars and receipts with mode `0600`.
- `bin/restore-dashboard-runtime.sh` is dry-run by default and refuses to restore while the dashboard is running.
- `bin/finance-sync-alert.sh` discovers the existing finance Telegram destination from OpenClaw without storing it in git.
- `logrotate-darkfinances.conf` bounds finance logs that can contain transaction metadata.

After changing units, run `systemd-analyze --user verify`, `systemctl --user daemon-reload`, and the relevant service smoke tests.
