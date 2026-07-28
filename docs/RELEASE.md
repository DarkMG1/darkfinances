# Release and provenance

DarkFinances ships through three coordinated paths:

1. **Full native build** — widgets, App Groups, push-notification entitlement, EAS Update on the `production` channel.
2. **Free sideload IPA** — `FREE_IOS_SIDELOAD=1` removes widget/push entitlements; local notifications remain.
3. **OTA updates** — JavaScript/assets only when the installed `runtimeVersion` matches.

## Content-addressed release manifest

Schema-v2 manifests separate display metadata such as `builtAt`, the short commit, and the local
branch from the identity-bearing `content` object. `contentDigest.value` is the SHA-256 of canonical
JSON for `content`; regenerating equivalent evidence at a different time therefore preserves the
digest.

Production release evidence is **Ed25519-signed**. Generation writes a sibling commit marker
`<manifest>.sig.json` with a strict envelope (`kind`, `schemaVersion`, `algorithm=ed25519`, `keyId`,
`signedAt`, `manifestDigest`, `signature`). The manifest itself never contains a signature field.
Verification binds the signature payload to the full validated manifest digest, so transplanting a
signature or tampering with manifest bytes fails closed.

Verify a stored manifest and its signature before using it:

```bash
export RELEASE_KEYRING_PATH=/path/to/release-keyring.json
node scripts/release-manifest.js --verify=/path/to/release-manifest.json
```

Production modes (`dashboard`, `ipa`, `ota`, `backup`) always require keyring + sibling signature
for verification, generation, restore binding, coordinated backup health, and `/ping` identity.
There is no opt-in downgrade when `RELEASE_KEYRING_PATH` is unset. `--allow-unsigned` remains
source-mode only.

```bash
export RELEASE_SIGNING_KEY_PATH=/path/to/release-signing-key.json
export RELEASE_KEYRING_PATH=/path/to/release-keyring.json
```

`--stdout`, `--source-digest`, and `--check-*` are source-only helpers. `--stdout` is rejected for
production modes (`dashboard`, `ipa`, `ota`, `backup`) before generation because detached signatures
cannot accompany stdout output; `--allow-unsigned` does not override this guard. Non-production
writes to a destination require `--allow-unsigned` explicitly. `--allow-unsigned` is rejected for
production modes regardless of `NODE_ENV`.

Create operator-owned signing material once per environment (never commit production keys). Do this
**before** the first production deploy:

```bash
node scripts/release-signing-keygen.js --output-dir=/secure/path/to/release-signing-v1
# prints keyId only; creates release-signing-key.json (0600) and release-keyring.json (0600)
export RELEASE_SIGNING_KEY_PATH=/secure/path/to/release-signing-v1/release-signing-key.json
export RELEASE_KEYRING_PATH=/secure/path/to/release-signing-v1/release-keyring.json
```

Add `RELEASE_KEYRING_PATH` to the dashboard systemd `EnvironmentFile`. Keep the private signing key
offline; deploy only the public keyring to the host.

Atomic publication renames the manifest first and the sibling signature second. The signature rename
is the commit marker: a crash between renames leaves verification failing and production startup
unhealthy until the pair is repaired or regenerated.

Until both files exist, env vars are configured, and manifests are signed, production manifest
generation and verification will fail closed.

Every manifest binds the Git commit, a SHA-256 aggregate of tracked working-tree content and
non-ignored untracked source (including executable semantics), clean/tracked-dirty/untracked state,
the root lockfile, contract fingerprint, Actual version alignment, and app
variant/version/runtime/channel/build identity.
Untracked filenames and source contents are not recorded. Git-ignored environment files, runtime
sidecars, receipts, dependencies, and build output are neither enumerated nor hashed automatically.

Release evidence is mode-specific:

| Mode | Required bound evidence |
| --- | --- |
| `source` | Source and contract identity only; the default used by side-effect-free CI checks. |
| `dashboard` | The explicit deployed dashboard root and the reviewed runtime-file allowlist. |
| `ipa` | The supplied IPA/artifact basename, byte length, and SHA-256. |
| `ota` | EAS update/group IDs, runtime, release profile, environment, channel, and branch. |
| `backup` | The backup sidecar manifest and every supplied archive basename, byte length, and SHA-256. |

Examples:

```bash
# No writes, builds, deploys, publications, or backups:
npm run check:release
node scripts/release-manifest.js --stdout
node scripts/release-manifest.js --source-digest

# Hash reviewed files in the deployed dashboard and write the manifest read by /ping:
FINANCE_DASHBOARD_DIR="$HOME/finance-dashboard" \
  ops/bin/write-dashboard-release-manifest.sh

# Explicit evidence can be added without creating it:
node scripts/release-manifest.js \
  --source-archive=/path/to/source.tar.gz \
  --dirty-patch=/path/to/working-tree.patch \
  build/source-release-manifest.json
```

Release callers store the exact one-line `--source-digest` output before a long build or publication
and pass it back with `--expected-source-digest=<sha256>` when creating the final manifest.

The dashboard helper requires `DARKFINANCES_REPO_ROOT` to identify the repository containing the
exact deployed source. It hashes each reviewed runtime path in both `finance-dashboard/` and the
deployment and refuses to create a manifest unless bytes, SHA-256, size, and executable semantics
match. It never walks or trusts arbitrary deployment contents. For schema v2, every `/ping` request
rehashes those files in the current dashboard runtime directory and returns `release: null` if a file
is missing, replaced, symlinked, reordered, or differs in bytes, SHA-256, or executable state.

The IPA and OTA scripts capture `--source-digest` immediately before the long operation and require
the same digest when generating the final manifest. This prevents a built artifact or published
update from being attributed to source that changed during the operation. IPA, backup, source
archive, and dirty-patch evidence is hashed incrementally in bounded chunks.

OTA publication retains the checked-in profile mappings: `production` uses its production
branch/channel/environment, `preview` uses its preview branch/channel/environment, and
`free-sideload` uses its isolated branch/channel with the production EAS environment. Production and
preview are validated against `finance-app/eas.json`. The publisher captures EAS `--json` output
after publication and then writes and verifies
`finance-app/dist/ota-release-manifest.json`; it does not create temporary branches or remap channels.
Direct `--mode=ota` manifest generation (outside `ota-publish.sh`) requires a verified standalone
`ops/publisher-toolchain/node_modules` install on the bound publisher platform; freshness-only contract checks
are insufficient for production OTA evidence. OTA invocation copies the publisher install into a private
temp snapshot and verifies the full physical package set and byte closure before spawning EAS; the publisher
host must remain same-UID/trusted during publish.
`npm run sideload:ios` continues to write a free-sideload manifest beside its unsigned IPA.

Supplied artifact, backup, source-archive, and dirty-patch paths must be existing regular files.
Only basenames and hashes enter the manifest; absolute local paths and file contents do not.

## Variant verification

```bash
node finance-app/scripts/verify-release-variant.js
```

This asserts that the full and free-sideload Expo configs have the intended entitlement/plugin
differences and use separate OTA channels and runtime identities.

## Version alignment gate

```bash
node scripts/check-version-alignment.js
```

Requires exact `x.y.z` versions in `ops/actual-compose.yml`, `finance-dashboard/package.json`, and
`actual-tools/package.json`, with both API dependencies exactly equal to the pinned server image.
Manifest construction and verification reuse this same alignment rule.

## Contract freshness

```bash
npm run check:contract
```

Compares `finance-dashboard/server.js` routes to `finance-app/src/api/generated/endpoints.ts` and
tracks a fingerprint stamp at `finance-app/src/api/generated/.contract-fingerprint`. This is a
verification-only command: a missing or stale stamp fails CI and is never created or repaired by
the check.

After intentionally regenerating the endpoint and type artifacts for a contract change, update the
stamp explicitly:

```bash
npm run update:contract-stamp
```

This updates only the fingerprint stamp; it does not generate contract artifacts.

## Lockfile reproducibility

```bash
node scripts/check-lockfile-repro.js
```

Runs `npm ci --ignore-scripts` and fails if `package-lock.json` mutates. It uses only Node built-ins
before that install, so CI can execute it directly from a dependency-empty checkout.

## Supply-chain preflight in CI

Merge CI (`.github/workflows/ci.yml`) and native/stress workflows
(`ios-pr-smoke`, `android-compile-smoke`, `maestro-full-suite`, `shutdown-stress`)
run a supply-chain preflight immediately after `npm ci` and before builds or
stress execution:

```bash
npm run check:action-pins:upstream
npm run check:vulnerabilities
```

Local `npm run check` keeps offline semantics: it runs source-only action pin
alignment (`check:action-pins`) but not upstream verification or live npm audit.
Use the explicit commands above when validating dependency or workflow pin
changes before relying on CI. See [`docs/vulnerability-policy.md`](vulnerability-policy.md)
for exception policy ownership.

## Coordinated backup provenance

`ops/bin/backup-coordinated.sh` quiesces timers/services when available, builds a PR-16 relocatable
bundle (not a legacy runtime archive), optional Actual data archive, release manifest, coordinated
generation manifest, and short-TTL restore admission token. Verify coordinated bundles before restore:

```bash
ops/bin/verify-backup-bundle.sh /path/to/dashboard-runtime-backup-bundle-<timestamp>.tgz
```

Legacy dashboard runtime archives from `backup-dashboard-runtime.sh` use `ops/bin/verify-backup.sh`
instead.

### Restore dry-run vs live all-writer re-verification

- **Standalone preview** (`restore-dashboard-runtime.sh` without `CONFIRM=1`, default
  `--dry-run`): validates archive trust chain, generation bindings, preflight space, and read-only
  writer discovery. A passing preview does **not** prove current live quiescence; active writers
  produce warnings (hard failure only when `RESTORE_DRY_RUN_STRICT=1`).
- **Coordinated restore preview** (`restore-coordinated.sh --dry-run` or `RESTORE_DRY_RUN=1`): same
  read-only writer boundary checks inside the coordinated session; does not stop services or mutate
  destination bytes. `RESTORE_DRY_RUN` applies only to coordinated restore, not the standalone helper.
- **Live restore** — standalone: `CONFIRM=1` with a PR-18 quiescence admission token; coordinated:
  live session without `--dry-run`/`RESTORE_DRY_RUN`. Both paths re-verify **all** inventoried writers
  with live state checks (`assertAllWritersQuiescentForAdmission`) immediately before the first
  destination mutation. Stale tokens or post-token writer activity fail closed.

Restore remains `CONFIRM=1` gated. The restore helper does not stop or start services; live swap
requires writers to already be quiescent or a coordinated restore session that stops them first.

### Restore admission transport migration

Production **preview and live restore** now require quiescence admission via
`RESTORE_QUIESCENCE_ADMISSION_PATH` only. Inline JSON/token transport
(`RESTORE_QUIESCENCE_ADMISSION_TOKEN`) and direct token injection are rejected outside explicit
test-only opt-in.

Trusted admission file requirements:

- mode `0600` regular file (not directory, symlink, or hard link)
- owned by the invoking service account
- single link count (no hard links)
- path resolved under trusted coordinator roots (`controlRoot`, `workRoot`, `canonicalRoot`)

Preview vs live mode is explicit boolean `dryRun` on the restore contract (not `NODE_ENV`):

- **Standalone preview**: default/`--dry-run`; `--dry-run` wins over ambient `CONFIRM=1`
- **Standalone live**: `--confirm` or `CONFIRM=1` without `--dry-run`
- **Coordinated preview**: `restore-coordinated.sh --dry-run` or `RESTORE_DRY_RUN=1` (read-only;
  does not consume admission)
- **Coordinated live**: neither flag set; admission issued to a trusted path during the session

Conflicting mode signals (`--dry-run` with `--confirm` or with `CONFIRM=1`) fail closed at the CLI.

## Dashboard trust-proxy migration

Upgrades that add fail-safe trust-proxy defaults remain available without a configuration outage:
when `FINANCE_TRUST_PROXY_HOPS` is absent the dashboard defaults to `0`, ignores
client-supplied `X-Forwarded-For` for rate limiting, and logs a `[trust-proxy]` startup warning on
non-loopback deployments.

Before restarting production after such an upgrade:

1. Add `FINANCE_TRUST_PROXY_HOPS=1` to the private dashboard environment when the process sits behind
   the usual trusted HTTPS reverse proxy on loopback.
2. Keep that reverse proxy as the sole ingress to Node and configure it to overwrite or append
   `X-Forwarded-For` with the real client address.
3. Restart `finance-dashboard.service` and confirm the `[trust-proxy]` warning disappears once hops
   are set to `1`.

Leaving the variable unset preserves security during the rollout but shares one rate-limit bucket
across all proxied clients until step 1 is applied. See [`ops/README.md`](../ops/README.md) for the
full pre-restart checklist.
