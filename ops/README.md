# DarkFinances Operations

This directory contains reviewed production assets for running Actual Budget, Finance Dashboard, bank
sync, backups, restore, alerts, and log rotation on a private Linux host.

These files are templates, not a turnkey public-cloud deployment. Review paths, usernames, credentials,
reverse-proxy settings, and alert delivery before installation.

## Contents

| Path | Purpose |
| --- | --- |
| `actual-compose.yml` | Actual Server container pinned to the version expected by this repository. |
| `systemd/finance-dashboard.service` | Private user service for the Express dashboard. |
| `systemd/actual-sync.service` | One-shot scheduled bank-sync service. |
| `systemd/actual-sync.timer` | Twice-daily Pacific-time bank-sync schedule. |
| `systemd/finance-sync-failure@.service` | `OnFailure` bridge to the alert script. |
| `bin/backup-dashboard-runtime.sh` | Private archive of dashboard JSON sidecars and receipts. |
| `bin/build-backup-bundle.sh` | Relocatable runtime backup bundle with embedded verification tooling. |
| `bin/backup-coordinated.sh` | Quiesced PR-16 bundle backup with writer inventory, run journal, generation manifest, and restore admission token. |
| `bin/write-dashboard-release-manifest.sh` | Content-address the reviewed files in a dashboard deployment. |
| `bin/verify-backup.sh` | Schema/checksum/receipt validation for a runtime archive. |
| `bin/verify-backup-bundle.sh` | Read-only validation for a relocatable runtime backup bundle. |
| `bin/restore-dashboard-runtime.sh` | Dry-run-first, CONFIRM-gated sidecar restore. |
| `bin/finance-sync-alert.sh` | Telegram alert delivery through an existing OpenClaw destination. |
| `logrotate-darkfinances.conf` | Rotation policy for finance logs that may contain transaction metadata. |

## Operational assumptions

- Services run as an unprivileged dedicated user.
- Actual and Finance Dashboard listen on loopback and are exposed only through a trusted HTTPS reverse
  proxy/private access layer.
- The repository is deployed as `~/finance-dashboard` and supporting tools as `~/actual-tools`.
- Service secrets live in `~/.openclaw/finance-dashboard.env` with mode `0600`.
- User systemd is available and, if needed after logout, lingering is enabled for the service account.
- Finance date boundaries and schedules use `America/Los_Angeles`.

Adjust the unit files if your layout differs. Do not add secrets directly to unit files.

## 1. Deploy Actual Server

The Compose file pins Actual Server to `26.7.0`, matching `finance-dashboard`'s `@actual-app/api`.

```bash
mkdir -p "$HOME/actual/data"
cp ops/actual-compose.yml "$HOME/actual/compose.yml"
docker compose -f "$HOME/actual/compose.yml" pull
docker compose -f "$HOME/actual/compose.yml" up -d
docker compose -f "$HOME/actual/compose.yml" ps
```

The container publishes only `127.0.0.1:5006`. Preserve `$HOME/actual/data` across upgrades and include
it in your independent Actual backup strategy.

Version alignment matters across:

1. `actualbudget/actual-server` in Compose.
2. `@actual-app/api` in `finance-dashboard/package.json`.
3. Any standalone/global `@actual-app/api` used by scheduled bank-sync or tools.

Do not upgrade only one layer. Schema errors during download/sync commonly indicate a mismatch.

## 2. Configure Finance Dashboard

Create the private environment file from `finance-dashboard/.env.example`. At minimum configure:

```dotenv
ACTUAL_SERVER_URL=http://127.0.0.1:5006
ACTUAL_PASSWORD=...
ACTUAL_SYNC_ID=...
ACTUAL_DATA_DIR=/home/<user>/.cache/actual-dashboard
FINANCE_API_TOKEN=...
SESSION_SECRET=...
PUBLIC_ORIGIN=https://finances.example.com
FINANCE_TIME_ZONE=America/Los_Angeles
TZ=America/Los_Angeles
```

Install it privately:

```bash
mkdir -p -m 700 "$HOME/.openclaw"
install -m 600 /path/to/finance-dashboard.env "$HOME/.openclaw/finance-dashboard.env"
```

Set `SESSION_DIR` and sidecar paths in the environment if they do not live under
`$HOME/finance-dashboard`. Configure first-passkey enrollment only for the short provisioning window
described in [`../finance-dashboard/README.md`](../finance-dashboard/README.md).

## 3. Install the dashboard service

```bash
mkdir -p "$HOME/.config/systemd/user"
install -m 600 ops/systemd/finance-dashboard.service \
  "$HOME/.config/systemd/user/finance-dashboard.service"
systemd-analyze --user verify "$HOME/.config/systemd/user/finance-dashboard.service"
systemctl --user daemon-reload
systemctl --user enable --now finance-dashboard.service
```

Verify startup and readiness:

```bash
systemctl --user status finance-dashboard.service
journalctl --user -u finance-dashboard.service --since today
curl -fsS -H "X-Finance-Token: $FINANCE_API_TOKEN" \
  http://127.0.0.1:5007/api/v1/ping
```

An HTTP `503` from ping means the process is reachable but Actual data is not ready. Investigate the
journal before restarting repeatedly.

After each code deployment and before relying on `/ping` release identity, hash the files actually
present in the deployment:

```bash
FINANCE_DASHBOARD_DIR="$HOME/finance-dashboard" \
  ops/bin/write-dashboard-release-manifest.sh
node scripts/release-manifest.js \
  --verify="$HOME/finance-dashboard/release-manifest.json"
```

The helper uses a fixed reviewed runtime-file allowlist and does not enumerate ignored sidecars,
receipts, environment files, sessions, or dependencies. `DARKFINANCES_REPO_ROOT` must point to the
repository containing the exact source copied into `FINANCE_DASHBOARD_DIR`; generation fails if any
allowlisted source/deployment file differs. Set it explicitly when the helper is installed outside
the repository, and set `RELEASE_MANIFEST_PATH` when the service uses a non-default manifest
location. The standalone `--verify` command checks manifest structure and its canonical
content digest. Dashboard `/ping` additionally rehashes every allowlisted file against the running
dashboard directory; it reports `release: null` if deployed code or assets drift afterward. Schema-v1
manifests remain readable for migration but do not claim this live deployed-file verification.

## 4. Install scheduled bank sync

The service expects a deployment-specific executable at:

```text
~/.local/bin/actual-sync.sh
```

That script is intentionally not checked in because its bank provider and credentials are
deployment-specific. It must:

- Exit nonzero on download, bank-sync, or upload/sync failure.
- Use a private disposable cache.
- Avoid printing credentials.
- Use an `@actual-app/api` version compatible with the server.

Install the reviewed units:

```bash
mkdir -p "$HOME/.local/bin" "$HOME/.config/systemd/user"
install -m 600 ops/systemd/actual-sync.service \
  "$HOME/.config/systemd/user/actual-sync.service"
install -m 600 ops/systemd/actual-sync.timer \
  "$HOME/.config/systemd/user/actual-sync.timer"
systemd-analyze --user verify \
  "$HOME/.config/systemd/user/actual-sync.service" \
  "$HOME/.config/systemd/user/actual-sync.timer"
systemctl --user daemon-reload
systemctl --user enable --now actual-sync.timer
systemctl --user start actual-sync.service
```

The timer runs at 10:00 and 22:00 in `America/Los_Angeles`, is persistent across downtime, and adds up
to five minutes of randomized delay.

Check it with:

```bash
systemctl --user list-timers actual-sync.timer
systemctl --user status actual-sync.service
journalctl --user -u actual-sync.service --since today
```

## 5. Configure failure alerts

The provided alert script uses `openclaw cron list --json` to reuse the Telegram target from the
existing `finance-morning` job. It does not store that target in git.

```bash
install -m 700 ops/bin/finance-sync-alert.sh "$HOME/.local/bin/finance-sync-alert.sh"
install -m 600 ops/systemd/finance-sync-failure@.service \
  "$HOME/.config/systemd/user/finance-sync-failure@.service"
systemctl --user daemon-reload
ALERT_DRY_RUN=1 "$HOME/.local/bin/finance-sync-alert.sh" actual-sync.service
```

The dry run still requires OpenClaw and a discoverable destination. If you do not use OpenClaw,
replace `finance-sync-alert.sh` with your alert provider or remove `OnFailure` from the sync service.
A broken alert handler must not be mistaken for a successful bank sync; inspect both units.

## Back up dashboard runtime state

Install and run:

```bash
install -m 700 ops/bin/backup-dashboard-runtime.sh \
  "$HOME/.local/bin/backup-dashboard-runtime.sh"
"$HOME/.local/bin/backup-dashboard-runtime.sh"
```

Defaults:

- Dashboard: `$HOME/finance-dashboard`
- Destination: `$HOME/darkfinances-backups`
- Archive mode: `0600`
- Checksum: adjacent `.sha256`

Override paths with `FINANCE_DASHBOARD_DIR` and `DARKFINANCES_BACKUP_DIR`.

The archive includes known dashboard JSON sidecars, passkey credentials, receipt metadata, and receipt
images. It does **not** include:

- The Actual data volume/budget.
- The dashboard environment file or `SESSION_SECRET`.
- Browser session files.
- Reverse-proxy certificates/config.
- Source code.

Back those up separately using appropriate encrypted storage. Restored passkey credentials require the
same WebAuthn relying-party ID/origin. Keep `SESSION_SECRET` stable in a secret manager; changing it
invalidates any browser sessions preserved elsewhere.

Verify an archive:

```bash
ops/bin/verify-backup.sh /path/to/dashboard-runtime-<timestamp>.tgz
sha256sum -c dashboard-runtime-<timestamp>.tgz.sha256
tar -tzf dashboard-runtime-<timestamp>.tgz
```

Each archive embeds `.backup-manifest.json` with per-file SHA-256 checksums, schema version, git
commit, and recovery metadata. A matching `dashboard-runtime-<timestamp>.tgz.manifest.json` is
written beside the archive.

### Relocatable runtime backup bundle (PR-16)

For off-host verification drills without a repository checkout, build a self-contained bundle:

```bash
install -m 700 ops/bin/build-backup-bundle.sh \
  "$HOME/.local/bin/build-backup-bundle.sh"
FINANCE_DASHBOARD_DIR="$HOME/finance-dashboard" \
  "$HOME/.local/bin/build-backup-bundle.sh"
```

Defaults match the runtime archive helper (`FINANCE_DASHBOARD_DIR`, `DARKFINANCES_BACKUP_DIR`).
Each bundle includes:

- `runtime/` — all registry `backup:true` sidecars present at build time, optional eligible
  `.last-good` sidecars, and receipt bytes referenced by `receipts.json`
- `tooling/` — embedded Node verification tooling (authoritative runtime-state schemas, inventory
  snapshot, read-only verifier entrypoint)
- `bundle-manifest.json` — artifact identity, provenance, file inventory (relative safe paths,
  SHA-256, bytes, mode), runtime-state inventory digest, and required restore tooling identity

Verify on any host with Node 24+ and `tar`:

```bash
ops/bin/verify-backup-bundle.sh /path/to/dashboard-runtime-backup-bundle-<timestamp>.tgz
sha256sum -c dashboard-runtime-backup-bundle-<timestamp>.tgz.sha256
```

The shell verifier runs the full archive trust chain: archive checksum sidecar, embedded/sidecar
manifest parity, tar member/type/closed-world parity, bounded preflight, private temp extraction,
extracted-tree verification, and optional publish to `DARKFINANCES_BUNDLE_EXTRACT_DIR` only after
success. Untrusted archives are never certified by merely extracting and invoking the standalone tree
verifier.

For trusted pre-extracted bundle trees (for example after a successful archive verify), use the
embedded `tooling/ops/bin/verify-backup-bundle.js`. That entrypoint skips archive checksum,
sidecar/embedded parity, and tar member checks; do not use it as the first verifier for untrusted
`.tgz` input.

The verifier is read-only. It rejects symlinks, path traversal, duplicate paths, unexpected
members, digest/size/mode mismatch, future bundle schema versions, missing required runtime stores,
tampered provenance fields, archive bombs, and unsafe private modes.
Passkey credential payloads are validated but never logged.

Regenerate the committed inventory snapshot after registry changes:

```bash
node ops/lib/generate-backup-state-inventory.js
```

PR-17 adds staged live swap/generation-bound restore; PR-18 adds writer quiescence. Do not treat
bundle verification as evidence of a successful production restore.

### Coordinated quiesced backup (PR-18)

`backup-coordinated.sh` delegates to the PR-18 coordinator (`ops/lib/coordinated-backup-cli.js`). It:

- Takes an exclusive lock under `$DARKFINANCES_BACKUP_DIR/.darkfinances-coordinated/` so backup, restore, and sync cannot overlap.
- Captures an immutable run journal with pre-mutation writer `active`/`enabled`/`running` snapshots from the authoritative inventory (`ops/lib/writer-inventory.json`).
- Stops writers in order: timers → active jobs → dashboard (systemd `SIGTERM` graceful drain via PR-14) → Actual container when `BACKUP_INCLUDE_ACTUAL_DATA=1` → restore-lock check.
- Verifies quiescence with bounded polling; a successful stop command alone is not proof.
- Builds a PR-16 relocatable bundle, optional Actual data archive, release manifest, coordinated generation manifest, and short-TTL restore admission token bound to artifact/destination/generation evidence.
- Restarts only originally active/enabled components in safe order (Actual → dashboard health → jobs/timers), then runs source-fresh health checks.
- On failure/interrupt, cleans run-owned staging only, preserves prior backups, and leaves `recovery_required` journal state when restart or health checks fail.

Dry run (`BACKUP_DRY_RUN=1` or `--dry-run`) performs discovery/preflight/stop-order planning only and exits `2` without mutating services or destination bytes.

```bash
install -m 700 ops/bin/backup-coordinated.sh \
  "$HOME/.local/bin/backup-coordinated.sh"
DARKFINANCES_REPO_ROOT=/path/to/darkfinances \
  "$HOME/.local/bin/backup-coordinated.sh"
```

Environment:

| Variable | Default | Purpose |
| --- | --- | --- |
| `BACKUP_QUIESCE` | `1` | Stop/verify/restart writers around backup |
| `BACKUP_INCLUDE_ACTUAL_DATA` | `0` | Also archive `ACTUAL_DATA_DIR` and bind Actual generation |
| `BACKUP_DRY_RUN` | `0` | Discovery/plan only |
| `FINANCE_EVENT_SYNC_CONFIGURED` | unset | Include optional event-sync writers when `1` |

Use `BACKUP_QUIESCE=0` only on hosts without user systemd or when writers are already quiesced manually.

## Restore dashboard runtime state

Install the restore helper next to the backup helper:

```bash
install -m 700 ops/bin/restore-dashboard-runtime.sh \
  "$HOME/.local/bin/restore-dashboard-runtime.sh"
```

Preview first (performs every PR-16 archive check, generation-binding validation, and preflight
without writing destination bytes):

```bash
RESTORE_QUIESCENCE_ADMISSION_PATH=/path/to/quiescence-admission.json \
  "$HOME/.local/bin/restore-dashboard-runtime.sh" \
  /path/to/dashboard-runtime-backup-bundle-<timestamp>.tgz
```

Dry run exits `2` on success. Live swap requires PR-18 writer quiescence evidence plus `CONFIRM=1`:

```bash
RESTORE_QUIESCENCE_ADMISSION_PATH=/path/to/quiescence-admission.json \
  CONFIRM=1 "$HOME/.local/bin/restore-dashboard-runtime.sh" \
  /path/to/dashboard-runtime-backup-bundle-<timestamp>.tgz
```

The helper:

- Accepts only PR-16 verified backup bundles (sidecar manifest, checksum, embedded manifest, closed-world inventory).
- Validates generation binding for active operation-journal entries and saga stores before swap.
- Builds a complete replacement tree in private staging; destination-only stale files are removed.
- Refuses unknown destination files outside the documented narrow exclusions.
- Uses a fixed control directory under the destination (`.darkfinances-restore/`) with journal schema v2,
  pre-restore snapshot manifest, and private work staging. Interrupted restores resume on the next invocation
  without an explicit work root; symlinked destination/control paths are rejected.
- Performs crash-convergent per-file same-filesystem rename replacement (not a single globally atomic swap),
  with journaled rollback phases (`rollback_in_progress`, `rollback_failed`, `rolled_back`) driven by the
  snapshot manifest rather than post-mutation live-tree enumeration.
- Re-verifies archive SHA-256 and manifest artifact ID before treating a `complete` journal as idempotent.
- Re-verifies the full installed destination closed-world tree (bytes, modes, sidecar schemas, receipt
  references) against the bound manifest before returning `complete`; destination drift fails closed.
- Serializes live restores with an atomic `restore.lock` in the control root (`O_EXCL`); concurrent
  invocations fail with `restore already in progress`.
- Requires a PR-18 quiescence admission token with TTL and bindings to archive SHA-256 and destination path;
  generation evidence is re-read immediately before the first mutation.
- Fsyncs journals (write-temp-then-rename), staged files, and parent directories at mutation boundaries where
  the platform supports it.
- Refuses restore without a PR-18 quiescence admission token (this script does not stop/start services).
- Dry-run uses temporary staging only and must not create the destination tree or persistent control paths.

Afterward, verify `/api/v1/ping`, browser passkey login, the app, receipts, reimbursements, and
reconciliation state.

## Log rotation

`logrotate-darkfinances.conf` rotates matching logs daily or at 5 MB, retains 14 compressed
generations, and creates files with mode `0600`.

The checked-in file contains deployment-specific `/home/dark/...` paths and `su dark dark`. Edit both
for your service account before installing:

```bash
sudo install -m 644 /path/to/reviewed-logrotate.conf \
  /etc/logrotate.d/darkfinances
sudo logrotate -d /etc/logrotate.d/darkfinances
```

Use `-d` for a non-writing debug pass. Finance logs can contain transaction metadata; restrict
ownership and avoid forwarding them to untrusted log services.

## Deploying changes safely

Before replacing a live version:

1. Run `npm run check` from the repository root.
2. Back up dashboard runtime state and Actual independently.
3. Confirm Actual server/client version alignment.
4. Stage private environment or unit changes with correct modes.
5. Run `systemd-analyze --user verify` for changed units.
6. Restart only affected services.
7. Check service status, journal errors, authenticated ping, browser login, and a read-only app view.
8. For mutation changes, smoke test against an isolated Actual clone before production.

If a deployment fails, preserve logs and runtime state before rollback. Do not delete Actual caches or
sidecars blindly; corruption recovery may depend on `.last-good` files.

## Security checklist

- Keep all finance listeners on loopback.
- Terminate TLS at a trusted reverse proxy, set the exact `PUBLIC_ORIGIN`, and add HSTS there.
- Use long independent values for `FINANCE_API_TOKEN` and `SESSION_SECRET`.
- Keep environment, session, sidecar, receipt, log, and backup permissions private.
- Leave passkey enrollment variables unset except during short enrollment windows.
- Never expose demo headers as a route to live resolvers.
- Test backups and restore previews regularly.
- Monitor `actual-sync.timer` and alert delivery.
- Keep secrets and generated financial data out of git.
