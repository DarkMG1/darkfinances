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
| `systemd/finance-event-sync.service` | One-shot who-owes snapshot (`owes-snapshot.js`). |
| `systemd/finance-event-sync.timer` | Half-hour Pacific-time who-owes snapshot schedule. |
| `systemd/finance-sync-failure@.service` | `OnFailure` bridge to the alert script. |
| `bin/backup-dashboard-runtime.sh` | Private archive of dashboard JSON sidecars and receipts. |
| `bin/build-backup-bundle.sh` | Relocatable runtime backup bundle with embedded verification tooling. |
| `bin/backup-coordinated.sh` | Quiesced PR-16 bundle backup with writer inventory, run journal, and generation manifest. |
| `bin/restore-coordinated.sh` | Coordinated live restore with writer quiescence, admission tokens, and restart (`RESTORE_PRE_QUIESCED` applies here only). |
| `bin/write-dashboard-release-manifest.sh` | Content-address the reviewed files in a dashboard deployment. |
| `bin/verify-backup.sh` | Schema/checksum/receipt validation for a runtime archive. |
| `bin/verify-backup-bundle.sh` | Read-only validation for a relocatable runtime backup bundle. |
| `bin/restore-dashboard-runtime.sh` | Dry-run-first, CONFIRM-gated sidecar restore. |
| `bin/finance-sync-alert.sh` | Telegram alert delivery through an existing OpenClaw destination. |
| `logrotate-darkfinances.conf` | Rotation policy for finance logs that may contain transaction metadata. |

## Operational assumptions

- Services run as an unprivileged dedicated user.
- Actual and Finance Dashboard listen on loopback and are exposed only through a trusted HTTPS reverse
  proxy/private access layer. Set `FINANCE_TRUST_PROXY_HOPS=1` in the dashboard environment so
  rate limits and forwarded client addresses honor the proxy hop. The trusted proxy must be the sole
  ingress to Node and must overwrite or append `X-Forwarded-For` with the real client address.
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
# Dashboard client cache only — not Actual Server data. Coordinated server backup/archive
# uses ACTUAL_SERVER_DATA_DIR (set in ~/.openclaw/finance-dashboard.env or shell when needed):
# ACTUAL_SERVER_DATA_DIR=/home/<user>/actual/data
FINANCE_API_TOKEN=...
SESSION_SECRET=...
PUBLIC_ORIGIN=https://finances.example.com
FINANCE_TRUST_PROXY_HOPS=1
FINANCE_TIME_ZONE=America/Los_Angeles
TZ=America/Los_Angeles
```

`ACTUAL_DATA_DIR` is the dashboard/API client cache for downloaded budget data (for example
`/home/<user>/.cache/actual-dashboard` on openclaw). Coordinated Actual Server backup, generation
binding, and post-restart health use `ACTUAL_SERVER_DATA_DIR` (default `$HOME/actual/data`) — never
the dashboard cache. Set both explicitly when they differ:

```dotenv
ACTUAL_DATA_DIR=/home/<user>/.cache/actual-dashboard
ACTUAL_SERVER_DATA_DIR=/home/<user>/actual/data
```

Install it privately:

```bash
mkdir -p -m 700 "$HOME/.openclaw"
install -m 600 /path/to/finance-dashboard.env "$HOME/.openclaw/finance-dashboard.env"
```

Set `SESSION_DIR` and sidecar paths in the environment if they do not live under
`$HOME/finance-dashboard`. The checked-in `finance-dashboard.service` unit pins
`FINANCE_RUNTIME_MODE=production` and `NODE_ENV=production` (both pinned in the checked-in
systemd unit); do not set `ALLOW_RAW_ACTUAL_API=1`, `NODE_ENV=test`, or other test-only
Actual bypass flags in the deployment env file. Validate with
`node finance-dashboard/scripts/check-dashboard-deployment-env.js --file=~/.openclaw/finance-dashboard.env`
before restart. Configure first-passkey enrollment only for the short provisioning window
described in [`../finance-dashboard/README.md`](../finance-dashboard/README.md).

### Trust-proxy migration checklist (pre-restart)

When upgrading to dashboard code with fail-safe trust-proxy defaults (absent
`FINANCE_TRUST_PROXY_HOPS` defaults to `0`), edit
`~/.openclaw/finance-dashboard.env` **before** restarting `finance-dashboard.service`:

1. If the dashboard sits behind the normal trusted HTTPS reverse proxy on loopback, add
   `FINANCE_TRUST_PROXY_HOPS=1`.
2. Confirm the reverse proxy is the **sole ingress** to `127.0.0.1:5007` and overwrites or appends
   `X-Forwarded-For` with the real client address. Do not expose Node directly to the internet.
3. Leave `FINANCE_TRUST_PROXY_HOPS` unset or set it to `0` only when Node is reached without a
   trusted proxy (direct exposure). This is fail-safe: spoofed `X-Forwarded-For` values are ignored,
   but all proxied clients may share one rate-limit bucket until step 1 is applied.
4. Restart the dashboard service after saving the environment file:

```bash
systemctl --user restart finance-dashboard.service
journalctl --user -u finance-dashboard.service --since "5 min ago" | rg trust-proxy
```

Look for `[trust-proxy]` in the journal when hops remain at `0` on a non-loopback deployment; that
warning means per-client rate limits still key on the proxy connection address.

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

The unit sets `TimeoutStopSec=25`, aligned with the dashboard's 15s graceful-shutdown hard cap
(`FINANCE_SHUTDOWN_TIMEOUT_MS`) plus margin for journal flush and systemd SIGKILL escalation. PR-18
coordinated backup polls dashboard quiescence within its own stop deadline; do not raise
`TimeoutStopSec` above the coordinator's writer stop budget without updating both contracts.

An HTTP `503` from ping means the process is reachable but Actual data is not ready. Investigate the
journal before restarting repeatedly.

After each code deployment and before relying on `/ping` release identity, hash the files actually
present in the deployment. Production generation and verification require operator-provisioned signing
files (see [Release and provenance](../docs/RELEASE.md)):

```bash
export RELEASE_SIGNING_KEY_PATH=/secure/path/to/release-signing-key.json
export RELEASE_KEYRING_PATH=/secure/path/to/release-keyring.json
FINANCE_DASHBOARD_DIR="$HOME/finance-dashboard" \
  ops/bin/write-dashboard-release-manifest.sh
node scripts/release-manifest.js \
  --verify="$HOME/finance-dashboard/release-manifest.json"
```

Configure the dashboard systemd unit to load `RELEASE_KEYRING_PATH` from the deployment
`EnvironmentFile` (`~/.openclaw/finance-dashboard.env`). Production runtime startup fails closed when
the keyring is missing or the current dashboard manifest/signature pair does not verify. Until
signing files are provisioned, production manifest generation, verification, coordinated backup
release manifests, and signed `/ping` release identity will fail closed.

The helper uses a fixed reviewed runtime-file allowlist and does not enumerate ignored sidecars,
receipts, environment files, sessions, or dependencies. `DARKFINANCES_REPO_ROOT` must point to the
repository containing the exact source copied into `FINANCE_DASHBOARD_DIR`; generation fails if any
allowlisted source/deployment file differs. Set it explicitly when the helper is installed outside
the repository, and set `RELEASE_MANIFEST_PATH` when the service uses a non-default manifest
location. The standalone `--verify` command checks manifest structure, its canonical content digest,
and the detached Ed25519 signature against `RELEASE_KEYRING_PATH`. Dashboard `/ping` additionally
rehashes every allowlisted file against the running dashboard directory; it reports `release: null`
if deployed code or assets drift afterward, or if signature verification fails. Schema-v1 manifests
remain readable for migration but do not claim this live deployed-file verification.

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

## 5. Install scheduled who-owes snapshot sync

Production historically ran Splitwise snapshot collection from cron every 30 minutes:

```cron
*/30 * * * * bash /home/dark/actual-tools/run.sh owes-snapshot.js
```

Prefer the reviewed user units below. They reproduce the half-hour cadence in `America/Los_Angeles`,
apply a private umask, run as a safe oneshot job, deliver failures through the same
`finance-sync-failure@.service` bridge as bank sync, and log to the user journal instead of a
separate cron log file.

Prerequisites:

- `~/actual-tools` is deployed from this repository (including `run.sh` and `owes-snapshot.js`).
- Private `~/actual-tools/.actual.env` (copy from `actual-tools/.actual.env.example`) with
  `ACTUAL_SERVER_URL`, `ACTUAL_PASSWORD`, `ACTUAL_SYNC_ID`, `OWES_TRUTH_PATH`, and `FIX_DATA_DIR`
  pointing at an owned disposable cache directory (for example `$HOME/.cache/actual-tools`). `run.sh`
  sources `.actual.env`, wipes `FIX_DATA_DIR` on each run, and refuses unsafe, missing, or
  non-directory paths.
- Private `~/actual-tools/.splitwise.env` when live Splitwise reads are required.
- Section 6 (failure alerts) is installed so `OnFailure` can notify on nonzero exits.

The timer fires at `:00` and `:30` each hour in `America/Los_Angeles`, is persistent across
downtime, and adds up to two minutes of randomized delay.

Check a running installation with:

```bash
systemctl --user list-timers finance-event-sync.timer
systemctl --user status finance-event-sync.service
journalctl --user -u finance-event-sync.service --since today
```

### New hosts (no legacy cron)

Fresh installs with no existing snapshot cron may install, verify, and enable in one pass:

```bash
mkdir -p "$HOME/.config/systemd/user"
install -m 600 ops/systemd/finance-event-sync.service \
  "$HOME/.config/systemd/user/finance-event-sync.service"
install -m 600 ops/systemd/finance-event-sync.timer \
  "$HOME/.config/systemd/user/finance-event-sync.timer"
systemd-analyze --user verify \
  "$HOME/.config/systemd/user/finance-event-sync.service" \
  "$HOME/.config/systemd/user/finance-event-sync.timer"
systemctl --user daemon-reload
systemctl --user enable --now finance-event-sync.timer
systemctl --user start finance-event-sync.service
```

Before the first coordinated backup on that host, export `FINANCE_EVENT_SYNC_CONFIGURED=1` anywhere
`backup-coordinated.sh` runs (see below).

### Migrate from cron (production)

Do **not** enable the systemd timer while cron still runs. Duplicate writers race on
`owes-truth.json` and break coordinated backup quiescence. Use this transaction-safe sequence:

1. **Install and verify only** — copy units and run `systemd-analyze`, but do not enable or start:

```bash
mkdir -p "$HOME/.config/systemd/user"
install -m 600 ops/systemd/finance-event-sync.service \
  "$HOME/.config/systemd/user/finance-event-sync.service"
install -m 600 ops/systemd/finance-event-sync.timer \
  "$HOME/.config/systemd/user/finance-event-sync.timer"
systemd-analyze --user verify \
  "$HOME/.config/systemd/user/finance-event-sync.service" \
  "$HOME/.config/systemd/user/finance-event-sync.timer"
systemctl --user daemon-reload
```

2. **Save and remove only the legacy cron line** — keep a restorable copy, then delete the
   `*/30 … owes-snapshot.js` entry from crontab (or your scheduler of record):

```bash
crontab -l | tee "$HOME/finance-event-sync.cron.bak"
crontab -e   # remove the owes-snapshot.js line only; leave other jobs untouched
```

Confirm no in-flight snapshot process remains before enabling systemd (otherwise two writers can
race):

```bash
if pgrep -f 'owes-snapshot\.js' >/dev/null; then
  echo "wait for in-flight owes-snapshot.js to finish" >&2
  exit 1
fi
```

3. **Set the coordinator flag** before the next coordinated backup:

```bash
export FINANCE_EVENT_SYNC_CONFIGURED=1
```

Persist that export in the shell wrapper, systemd drop-in, or environment file sourced by
`backup-coordinated.sh`. Without the flag, event-sync writers are omitted from the inventory and
backup may proceed while snapshot jobs still run.

Example wrapper (sources dashboard secrets without printing them):

```bash
#!/usr/bin/env bash
set -euo pipefail
umask 077
set -a
. "$HOME/.openclaw/finance-dashboard.env"
set +a
export FINANCE_EVENT_SYNC_CONFIGURED=1
exec "$HOME/.local/bin/backup-coordinated.sh" "$@"
```

4. **Enable, start, and manually verify** one successful run — finish steps 2–4 as **one maintenance
   transaction**. Do **not** run `backup-coordinated.sh`, `restore-coordinated.sh`, or
   `restore-dashboard-runtime.sh` live between removing cron and confirming the systemd timer works;
   the deployment is mid-migration and writers are ambiguous until step 4 succeeds.

```bash
systemctl --user enable --now finance-event-sync.timer
systemctl --user start finance-event-sync.service
journalctl --user -u finance-event-sync.service --since "5 min ago"
```

5. **On unit failure in step 4**, restore the saved cron line immediately (before extended
   debugging) so snapshot collection resumes:

```bash
systemctl --user disable --now finance-event-sync.timer 2>/dev/null || true
crontab "$HOME/finance-event-sync.cron.bak"
```

Then investigate the journal, fix `.actual.env` / `.splitwise.env` / paths, and retry the migration
from step 1 once the root cause is resolved.

### Roll back to cron

If you must revert after a completed migration:

```bash
systemctl --user disable --now finance-event-sync.timer
rm -f "$HOME/.config/systemd/user/finance-event-sync.service" \
      "$HOME/.config/systemd/user/finance-event-sync.timer"
systemctl --user daemon-reload
```

Re-add the reviewed cron entry only after confirming no systemd timer remains enabled:

```cron
CRON_TZ=America/Los_Angeles
*/30 * * * * bash /home/dark/actual-tools/run.sh owes-snapshot.js
```

Unset `FINANCE_EVENT_SYNC_CONFIGURED` (or remove the export) so coordinated backup no longer waits
for units that are not installed.

## 6. Configure failure alerts

The provided alert script uses `openclaw cron list --json` to reuse the Telegram target from the
existing `finance-morning` job. It does not store that target in git.

```bash
install -m 700 ops/bin/finance-sync-alert.sh "$HOME/.local/bin/finance-sync-alert.sh"
install -m 600 ops/systemd/finance-sync-failure@.service \
  "$HOME/.config/systemd/user/finance-sync-failure@.service"
systemctl --user daemon-reload
"$HOME/.local/bin/finance-sync-alert.sh" --dry-run actual-sync.service
"$HOME/.local/bin/finance-sync-alert.sh" --dry-run finance-event-sync.service
# ALERT_DRY_RUN=1 is equivalent to --dry-run for OpenClaw delivery.
ALERT_DRY_RUN=1 "$HOME/.local/bin/finance-sync-alert.sh" actual-sync.service
```

Usage: `finance-sync-alert.sh [--dry-run] [unit]`. `--dry-run` may appear before or after the unit
name; unknown options, bare `--`, and extra positional arguments exit `2` before target discovery or
send. Systemd unit names are plain service identifiers (no option-like tokens). Default unit is
`actual-sync.service` (systemd `%i` still passes the failing unit on real alerts).

The dry run still requires OpenClaw and a discoverable destination. If you do not use OpenClaw,
replace `finance-sync-alert.sh` with your alert provider or remove `OnFailure` from the sync service.
A broken alert handler must not be mistaken for a successful bank sync or snapshot; inspect both the
failing job unit and `finance-sync-failure@*.service`.

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
- Builds a PR-16 relocatable bundle, optional Actual data archive, release manifest, and coordinated generation manifest. It does not mint restore authority.
- Restarts only originally active/enabled components in safe order (Actual → dashboard health → jobs/timers), then runs source-fresh health checks.
- On failure/interrupt, cleans run-owned staging only, preserves prior backups, and leaves `recovery_required` journal state when restart or health checks fail.

Verify each coordinated bundle before off-host storage or restore drills:

```bash
ops/bin/verify-backup-bundle.sh /path/to/dashboard-runtime-backup-bundle-<timestamp>.tgz
```

Dry run (`BACKUP_DRY_RUN=1` or `--dry-run`) performs discovery/preflight/stop-order planning only and exits `2` without mutating services or destination bytes.

```bash
install -m 700 ops/bin/backup-coordinated.sh \
  "$HOME/.local/bin/backup-coordinated.sh"
DARKFINANCES_REPO_ROOT=/path/to/darkfinances \
  "$HOME/.local/bin/backup-coordinated.sh"
```

Source the private dashboard environment before coordinated backup or restore so
`FINANCE_API_TOKEN` (and related paths) are present without echoing secrets:

```bash
set -a
. "$HOME/.openclaw/finance-dashboard.env"
set +a
export FINANCE_EVENT_SYNC_CONFIGURED=1   # after cron → systemd migration only
"$HOME/.local/bin/backup-coordinated.sh"
```

When `FINANCE_EVENT_SYNC_CONFIGURED=1`, coordinated backup and restore run a fail-closed deployment
audit: bounded `crontab -l` (argv-only, no shell) must show **no active** (non-comment) legacy
`owes-snapshot.js` cron lines. Commented examples and `no crontab for user` are accepted; ambiguous
`crontab` failures fail the run.

Environment:

| Variable | Default | Purpose |
| --- | --- | --- |
| `BACKUP_INCLUDE_ACTUAL_DATA` | `0` | Also archive `ACTUAL_SERVER_DATA_DIR` and bind Actual generation |
| `ACTUAL_SERVER_DATA_DIR` | `$HOME/actual/data` | Actual Server data tree for coordinated archive/generation binding (not dashboard cache) |
| `BACKUP_PRE_QUIESCED` | unset | Pre-quiesced backup: writers were stopped out-of-band; skips stop commands but still polls until all inventoried writers are quiescent; never mints restore authority |
| `BACKUP_DRY_RUN` | `0` | Discovery/plan only |
| `FINANCE_EVENT_SYNC_CONFIGURED` | unset | When `1`, coordinated backup quiesces `finance-event-sync.timer`/`.service` and rejects active legacy `owes-snapshot.js` cron entries |

`BACKUP_QUIESCE=0` is forbidden. Restore admission tokens are Ed25519-signed, short-lived, and issued only by the coordinated restore session while it holds the exclusive coordination lock — never during backup.

`BACKUP_PRE_QUIESCED=1` is a stop-skip mode for operators who already stopped writers manually
(maintenance window, incident response). It **never** skips quiescence polling or generation binding
checks; it only skips issuing new `systemctl stop` / `docker compose stop` commands. Backup still
creates artifacts. Do not set the flag to bypass a live writer — active timers, jobs, or the
dashboard still fail the run.

`RESTORE_PRE_QUIESCED=1` applies **only** to coordinated restore (`restore-coordinated.sh` /
`runCoordinatedRestore`). The standalone `restore-dashboard-runtime.sh` helper ignores this flag.
Set it only when the same out-of-band stop sequence used for backup has already been performed and
verified; it skips stop commands but still re-verifies quiescence before the first destination
mutation.

## Restore dashboard runtime state

Install the restore helper next to the backup helper:

```bash
install -m 700 ops/bin/restore-dashboard-runtime.sh \
  "$HOME/.local/bin/restore-dashboard-runtime.sh"
```

Preview first (PR-16 archive trust chain, generation-binding validation, preflight space, and
read-only writer discovery — **not** live all-writer quiescence proof). Default invocation is
dry-run (`--dry-run`); live swap requires `CONFIRM=1`. `RESTORE_DRY_RUN=1` applies only to
`restore-coordinated.sh`, not this standalone helper.

```bash
RESTORE_QUIESCENCE_ADMISSION_PATH=/path/to/quiescence-admission.json \
  "$HOME/.local/bin/restore-dashboard-runtime.sh" \
  /path/to/dashboard-runtime-backup-bundle-<timestamp>.tgz
```

Dry run exits `2` on success. Active writers may appear as warnings only; do not treat a successful
preview as evidence that production is safe to mutate. Live swap requires PR-18 writer quiescence
evidence plus `CONFIRM=1`:

```bash
RESTORE_QUIESCENCE_ADMISSION_PATH=/path/to/quiescence-admission.json \
  CONFIRM=1 "$HOME/.local/bin/restore-dashboard-runtime.sh" \
  /path/to/dashboard-runtime-backup-bundle-<timestamp>.tgz
```

This standalone helper does **not** honor `RESTORE_PRE_QUIESCED` and does not stop/start systemd
writers itself. Use coordinated restore when you need PR-18 stop/restart orchestration.

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
- Production restore admission must be supplied via `RESTORE_QUIESCENCE_ADMISSION_PATH` pointing at a
  mode-`0600` regular file under trusted coordinator roots (owner, symlink, hard-link, and path checks).
  Inline JSON/token transport (`RESTORE_QUIESCENCE_ADMISSION_TOKEN`) is rejected for production preview
  and live swap; live restore (`CONFIRM=1` / `--confirm`, i.e. `dryRun !== true`) always requires the
  trusted file path even in tests.
- Fsyncs journals (write-temp-then-rename), staged files, and parent directories at mutation boundaries where
  the platform supports it.
- Refuses restore without a PR-18 quiescence admission token (this script does not stop/start services).
- Dry-run uses temporary staging only and must not create the destination tree or persistent control paths.
- Dry-run writer preview is read-only discovery; live restore re-verifies all inventoried writers
  immediately before the first destination mutation (`assertAllWritersQuiescentForAdmission`).

Afterward, verify `/api/v1/ping`, browser passkey login, the app, receipts, reimbursements, and
reconciliation state.

## Coordinated live restore

Install the coordinated restore entrypoint next to the backup helper:

```bash
install -m 700 ops/bin/restore-coordinated.sh \
  "$HOME/.local/bin/restore-coordinated.sh"
```

Source dashboard secrets the same way as coordinated backup (never print `FINANCE_API_TOKEN`):

```bash
set -a
. "$HOME/.openclaw/finance-dashboard.env"
set +a
export FINANCE_EVENT_SYNC_CONFIGURED=1   # when event-sync systemd is installed
"$HOME/.local/bin/restore-coordinated.sh" /path/to/dashboard-runtime-backup-bundle-<timestamp>.tgz
```

Dry-run preview (`RESTORE_DRY_RUN=1` or `--dry-run`) performs read-only writer discovery only; it
does not mutate the destination. During a live restore, the coordinated restore session issues a
short-lived admission token while holding its exclusive lock, then performs writer stop → staged
swap → restart/health verification. Backup never mints restore authority.

When writers were stopped out-of-band immediately before restore, only this coordinated path honors
`RESTORE_PRE_QUIESCED=1`: it skips issuing new stop commands but still re-verifies quiescence before
the first destination mutation (same stop-skip semantics as `BACKUP_PRE_QUIESCED=1` for backup):

```bash
set -a
. "$HOME/.openclaw/finance-dashboard.env"
set +a
export RESTORE_PRE_QUIESCED=1
export FINANCE_EVENT_SYNC_CONFIGURED=1
"$HOME/.local/bin/restore-coordinated.sh" /path/to/dashboard-runtime-backup-bundle-<timestamp>.tgz
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `RESTORE_QUIESCENCE_ADMISSION_PATH` | unset | Path to signed PR-18 quiescence admission JSON (`0600`, trusted coordinator roots); required for production preview and live restore |
| `RESTORE_PRE_QUIESCED` | unset | Coordinated restore only: skip stop commands when writers were stopped out-of-band; still verifies quiescence |
| `RESTORE_DRY_RUN` | unset | Coordinated restore discovery/preview only (`restore-coordinated.sh`; not `restore-dashboard-runtime.sh`) |
| `FINANCE_EVENT_SYNC_CONFIGURED` | unset | When `1`, coordinated restore quiesces event-sync writers and rejects active legacy `owes-snapshot.js` cron |

## Graceful shutdown verification

PR-14 graceful shutdown is covered on every PR by dashboard integration tests (including in-flight
read abort during `SIGTERM`). Full bounded stress is opt-in or scheduled so routine CI stays fast:

```bash
# Deterministic gate (runs via npm run check / check:dashboard):
npm --prefix finance-dashboard test -- --test-name-pattern 'graceful shutdown during in-flight read'

# Bounded scheduled/manual stress (dedicated file only; 100 serial + 100 parallel by default):
npm run check:shutdown-stress

# Reduced local/CI profile example:
FINANCE_QUERY_SHUTDOWN_STRESS_SERIAL=5 FINANCE_QUERY_SHUTDOWN_STRESS_PARALLEL=5 \
  FINANCE_QUERY_SHUTDOWN_STRESS_WORKERS=2 npm run check:shutdown-stress
```

`check:shutdown-stress` sets `FINANCE_QUERY_SHUTDOWN_STRESS=1` and `ALLOW_RAW_ACTUAL_API=1`, then
runs `node --test finance-dashboard/test/query-scaling-shutdown-stress.test.js` (Node flags precede
the file path; it does not invoke the full dashboard `npm test` harness). Tune volume with
`FINANCE_QUERY_SHUTDOWN_STRESS_SERIAL`, `_PARALLEL`, and `_WORKERS`. The scheduled GitHub workflow
runs a reduced bounded profile nightly via the same script.

## Log rotation

Reviewed systemd units log to the **user journal** (`journalctl --user -u <unit>`). File-based
logging is legacy-only: historical cron jobs redirected bank sync and actual-tools output into
`/home/<user>/actual/bank-sync.log` and `~/actual-tools/*.log`. After migrating bank sync and
who-owes snapshot collection to the reviewed timers/services, treat journald as authoritative and
use logrotate only to compress or retire residual files still on disk.

`ops/lib/logrotate-contract.json` documents each rotated path, how it was opened in legacy
deployments, and the zero-loss contract:

| Path | Reviewed replacement | Legacy open semantics |
| --- | --- | --- |
| `~/actual/bank-sync.log` | `actual-sync.service` → journald | Shell append once per cron/systemd oneshot invocation |
| `~/actual-tools/*.log` | `finance-event-sync.service` → journald | Shell append from cron (for example `owes-snapshot.log`) |

The checked-in `logrotate-darkfinances.conf` uses **rename/create** rotation (logrotate default) with
`su <user> <group>` and `create 0600 <user> <group>`. The `create` ownership must exactly match `su`
and the service account declared in `ops/lib/logrotate-contract.json` (`rotation.runAsUser` /
`rotation.runAsGroup`). **Do not** use `copytruncate`. Rename/create is safe for short-lived appenders and
for held descriptors (writes after rotation continue into the rotated inode). `copytruncate` can drop
lines when a writer keeps an open descriptor or is mid-write during truncation.

After full systemd migration you may archive residual `*.log` files and remove the logrotate stanza;
until then, install it for legacy cleanup only:

```bash
# Edit /home/dark/... paths and su dark dark for your service account first.
sudo install -m 644 /path/to/reviewed-logrotate.conf \
  /etc/logrotate.d/darkfinances
sudo logrotate -d /etc/logrotate.d/darkfinances   # non-writing syntax/debug pass
sudo logrotate -f /etc/logrotate.d/darkfinances     # optional one-shot cleanup
```

No service reload is required for journald-backed units when updating logrotate. Changing systemd
units still requires `systemctl --user daemon-reload` and restarting affected services. Finance logs
can contain transaction metadata; restrict ownership (`0600`) and avoid forwarding them to untrusted
log services.

Contract tests live in `ops/test/logrotate-contract.test.js` (configuration parity plus, when
`logrotate` is installed locally, a concurrent append harness proving rename/create preserves unique
lines).

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

## Toolchain verification (local / CI)

Default repository checks stay offline (`npm run check`). CI additionally verifies pinned GitHub Action
tags against upstream release refs (`node scripts/check-github-action-pins.js --verify-upstream` in
`.github/workflows/ci.yml`).

Optional real-artifact verification (network required; not part of default `npm test`):

```bash
# Linux x86_64: pinned ShellCheck bootstrap + version contract
DARKFINANCES_TOOLCHAIN_NETWORK_TEST=1 node --test ops/test/toolchain-network.test.js

# macOS: pinned Maestro bootstrap + version contract
DARKFINANCES_TOOLCHAIN_NETWORK_TEST=1 node --test ops/test/toolchain-network.test.js
```

Manual wrapper commands (expected exit `0`, stdout ends with absolute binary path, `--version` matches
contract):

```bash
bash scripts/ensure-shellcheck.sh   # Linux x86_64 CI only; local macOS skips
bash scripts/ensure-maestro.sh      # macOS CI only; local Linux skips
```

OTA publishing operator contract:

- Supported publisher platform: **darwin/arm64** (bound in `ops/toolchain/eas-cli-runtime-closure.json`).
- Required install layout: standalone `ops/publisher-toolchain/node_modules` only — no repo-root or finance-app hoist fallback.
- Root npm workspaces are a closed list of literal paths; workspace glob/extglob/brace patterns are rejected so they cannot silently absorb `ops/publisher-toolchain`.
- Prepare publisher host: `npm --prefix ops/publisher-toolchain ci --workspaces=false --ignore-scripts`
- Preflight before OTA (same as merge gate byte verification, no publish):

```bash
npm --prefix ops/publisher-toolchain ci --workspaces=false --ignore-scripts
npm run check:publisher-closure
node finance-app/scripts/run-pinned-eas.js --version
```

- The isolated publisher install disables dependency lifecycle scripts, avoiding unreviewed install-time
  execution and nondeterministic native build artifacts. The merge gate proves the pinned EAS CLI runs
  successfully from the resulting install.
- Invocation copies the installed publisher tree into a private temp snapshot, verifies the lock-derived physical package set and byte closure on that snapshot, sanitizes injection-related environment variables, then runs `process.execPath` with the snapshot's absolute `eas-cli/bin/run` while keeping child `cwd` at `finance-app`. This closes verification/use races under the trusted same-UID publisher-host model; it does not claim OS-level adversary resistance.
- Regenerate closure contract after eas-cli/lock changes (darwin/arm64 only):
  `node scripts/compute-eas-cli-runtime-closure.js`
- Platform-agnostic CI (`ubuntu-latest`) validates closure contract freshness on every run
  (lock SHA-256, eas-cli version/SRI, pin alignment, lock-derived package count) via
  `verifyRuntimeClosureContractFreshness`.
- **Merge gate:** `.github/workflows/ci.yml` job `publisher-closure` on **`macos-15` (arm64)**
  runs standalone `npm --prefix ops/publisher-toolchain ci --workspaces=false --ignore-scripts`, then
  `node scripts/check-publisher-closure.js` and `node finance-app/scripts/run-pinned-eas.js --version`
  to validate installed-byte `runtimeClosureDigest`, `packageCount`, and `fileCount` on every PR/main
  push. Use `macos-15-intel` only for x64; do not conflate labels.
- Operator pre-publish on darwin/arm64 (same commands as the merge gate, no OTA publish):

```bash
npm --prefix ops/publisher-toolchain ci --workspaces=false --ignore-scripts
npm run check:publisher-closure
node finance-app/scripts/run-pinned-eas.js --version
```

Direct `node scripts/release-manifest.js --mode=ota …` (without injected test fixtures) calls
`verifyPublisherToolchain` with `{ verifyInstalled: true }` and fails before writing when the host
is off-platform or lacks a verified standalone install. Use `finance-app/scripts/ota-publish.sh` for
the supported production OTA provenance path. OTA invocation uses a verified private snapshot of the
publisher install (see above); the publisher host must be same-UID/trusted during publish.

Current bound closure (regenerate after lock changes): **510 packages**, **15190 files**.

## Security checklist

- Keep all finance listeners on loopback.
- Terminate TLS at a trusted reverse proxy, set the exact `PUBLIC_ORIGIN`, and add HSTS there.
- Use long independent values for `FINANCE_API_TOKEN` and `SESSION_SECRET`.
- Keep environment, session, sidecar, receipt, log, and backup permissions private.
- Leave passkey enrollment variables unset except during short enrollment windows.
- Never expose demo headers as a route to live resolvers.
- Test backups and restore previews regularly.
- Monitor `actual-sync.timer`, `finance-event-sync.timer` (when installed), and alert delivery.
- Keep secrets and generated financial data out of git.
