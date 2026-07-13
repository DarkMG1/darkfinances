#!/usr/bin/env node
/**
 * Immutable release provenance helper. Writes a JSON manifest without touching
 * finance-dashboard/server.js. Build/OTA/backup scripts can embed or ship it.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { getConfig } = require('@expo/config');
const { contractFingerprint } = require('./contract-fingerprint');

const root = path.resolve(__dirname, '..');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function sha256File(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function gitValue(args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) return null;
  return result.stdout.trim() || null;
}

function packageVersion(pkgPath) {
  const deps = readJson(pkgPath).dependencies || {};
  const spec = deps['@actual-app/api'];
  return spec || null;
}

function resolvedAppConfig(variant) {
  const previous = process.env.FREE_IOS_SIDELOAD;
  if (variant === 'free-sideload') process.env.FREE_IOS_SIDELOAD = '1';
  else delete process.env.FREE_IOS_SIDELOAD;
  try {
    return getConfig(path.join(root, 'finance-app'), { skipSDKVersionRequirement: true }).exp;
  } finally {
    if (previous === undefined) delete process.env.FREE_IOS_SIDELOAD;
    else process.env.FREE_IOS_SIDELOAD = previous;
  }
}

function buildManifest(extra = {}) {
  const lockfile = path.join(root, 'package-lock.json');
  const dashboardPkg = path.join(root, 'finance-dashboard', 'package.json');
  const toolsPkg = path.join(root, 'actual-tools', 'package.json');
  const compose = path.join(root, 'ops', 'actual-compose.yml');
  const actualServer = fs.readFileSync(compose, 'utf8').match(/actual-server:([0-9.]+)/)?.[1] || null;
  const app = resolvedAppConfig(extra.variant);

  return {
    kind: 'darkfinances-release',
    schemaVersion: 1,
    builtAt: new Date().toISOString(),
    repository: {
      commit: gitValue(['rev-parse', 'HEAD']),
      commitShort: gitValue(['rev-parse', '--short', 'HEAD']),
      dirty: gitValue(['status', '--porcelain']) ? true : false,
      branch: gitValue(['rev-parse', '--abbrev-ref', 'HEAD']),
    },
    lockfile: {
      path: 'package-lock.json',
      sha256: fs.existsSync(lockfile) ? sha256File(lockfile) : null,
    },
    actual: {
      serverImage: actualServer,
      dashboardApi: packageVersion(dashboardPkg),
      toolsApi: packageVersion(toolsPkg),
    },
    contract: {
      fingerprint: contractFingerprint(),
    },
    app: {
      version: app.version || null,
      runtimeVersion: app.runtimeVersion || null,
      updateChannel: app.updates?.requestHeaders?.['expo-channel-name'] || null,
      iosBuildNumber: app.ios?.buildNumber || null,
    },
    ...extra,
  };
}

function main() {
  const out = process.argv.includes('--stdout');
  const variant = process.env.RELEASE_VARIANT || process.argv.find((arg) => arg.startsWith('--variant='))?.split('=')[1] || null;
  const artifactPath = process.argv.find((arg) => arg.startsWith('--artifact='))?.slice('--artifact='.length) || null;
  const artifact = artifactPath ? {
    file: path.basename(artifactPath),
    sha256: sha256File(artifactPath),
  } : null;
  const manifest = buildManifest({
    ...(variant ? { variant } : {}),
    ...(artifact ? { artifact } : {}),
  });

  if (out) {
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
    return;
  }

  const dest = process.argv.slice(2).find((arg) => !arg.startsWith('--'))
    || path.join(root, 'build', 'release-manifest.json');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${dest}\n`);
}

if (require.main === module) main();
module.exports = { buildManifest, contractFingerprint, sha256File };
