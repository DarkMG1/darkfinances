# Release and provenance

DarkFinances ships through three coordinated paths:

1. **Full native build** — widgets, App Groups, push-notification entitlement, EAS Update on the `production` channel.
2. **Free sideload IPA** — `FREE_IOS_SIDELOAD=1` removes widget/push entitlements; local notifications remain.
3. **OTA updates** — JavaScript/assets only when the installed `runtimeVersion` matches.

## Content-addressed release manifest

Schema-v2 manifests separate display metadata such as `builtAt`, the short commit, and the local
branch from the identity-bearing `content` object. `contentDigest.value` is the SHA-256 of canonical
JSON for `content`; regenerating equivalent evidence at a different time therefore preserves the
digest. Verify a stored manifest before using it:

```bash
node scripts/release-manifest.js --verify=/path/to/release-manifest.json
```

This is content integrity, not authenticity. There is no signing key or cryptographic signature:
anyone able to replace both the content and its digest can create a different internally consistent
manifest. Protect or attest the manifest through the release system if publisher authenticity is
required.

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

## Coordinated backup provenance

`ops/bin/backup-coordinated.sh` quiesces timers/services when available, archives dashboard sidecars
with embedded `.backup-manifest.json`, writes an external manifest + SHA-256 checksum, and records a
release manifest beside the archive. When Actual data is included, its archive is also bound as
additional backup evidence. Verify before restore:

```bash
ops/bin/verify-backup.sh /path/to/dashboard-runtime-<timestamp>.tgz
```

Restore remains `CONFIRM=1` gated and refuses to run while `finance-dashboard.service` is active.

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
