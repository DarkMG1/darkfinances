# Release and provenance

DarkFinances ships through three coordinated paths:

1. **Full native build** — widgets, App Groups, push-notification entitlement, EAS Update on the `production` channel.
2. **Free sideload IPA** — `FREE_IOS_SIDELOAD=1` removes widget/push entitlements; local notifications remain.
3. **OTA updates** — JavaScript/assets only when the installed `runtimeVersion` matches.

## Immutable release manifest

`scripts/release-manifest.js` writes a checksum-stable JSON manifest without modifying
`finance-dashboard/server.js`:

```bash
npm run release:manifest
node scripts/release-manifest.js --stdout
RELEASE_VARIANT=free-sideload node scripts/release-manifest.js build/sideload/manifest.json
```

Fields include git commit, lockfile SHA-256, Actual server/API alignment, contract fingerprint,
and Expo runtime/channel metadata. `npm run sideload:ios` writes a variant-stamped manifest next to
the unsigned IPA.

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

Requires `ops/actual-compose.yml`, `finance-dashboard/package.json`, and `actual-tools/package.json`
to agree on `@actual-app/api` and the pinned Actual server image.

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
release manifest beside the archive. Verify before restore:

```bash
ops/bin/verify-backup.sh /path/to/dashboard-runtime-<timestamp>.tgz
```

Restore remains `CONFIRM=1` gated and refuses to run while `finance-dashboard.service` is active.
