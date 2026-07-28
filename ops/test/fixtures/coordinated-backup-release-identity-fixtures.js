'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { canonicalSerialize } = require('../../../finance-dashboard/lib/release-schema');
const { DASHBOARD_RUNTIME_FILES } = require('../../../finance-dashboard/lib/release-files');
const { collectDeployedFiles, sha256Canonical } = require('../../../scripts/release-manifest');
const { createMockRunners, defaultActiveUnits } = require('./coordinated-backup-fixtures');
const { hashDashboardReleaseIdentity } = require('../../lib/coordinated-backup-health');
const { createEphemeralSigningMaterial, writeSignedManifest } = require('../helpers/release-signing-fixtures');

function envelopedPingBody(payload) {
  return { data: payload };
}

const SCHEMA_V1_RELEASE_IDENTITY = Object.freeze({
  commit: 'abcdef0',
  dirty: false,
  lockSha256: 'b'.repeat(64),
  contract: 'e92dd64e2bba333f',
  appVersion: '2.0.0',
  builtAt: '2026-01-01T00:00:00.000Z',
});

const SCHEMA_V1_RELEASE_IDENTITY_DIGEST = hashDashboardReleaseIdentity(SCHEMA_V1_RELEASE_IDENTITY);

const RELEASE_MANIFEST_BODY = `${JSON.stringify({ contentDigest: { value: 'c'.repeat(64) } }, null, 2)}\n`;
const RELEASE_MANIFEST_DIGEST = crypto.createHash('sha256').update(RELEASE_MANIFEST_BODY).digest('hex');

function defaultEnvelopedPingResponse(release = SCHEMA_V1_RELEASE_IDENTITY) {
  return {
    status: 200,
    body: envelopedPingBody({ ok: true, release }),
  };
}

function writeSchemaV1ReleaseManifest(dashboardDir, identity = SCHEMA_V1_RELEASE_IDENTITY) {
  const manifest = {
    schemaVersion: 1,
    builtAt: identity.builtAt,
    repository: { commitShort: identity.commit, dirty: identity.dirty === true },
    lockfile: { sha256: identity.lockSha256 },
    contract: { fingerprint: identity.contract },
    app: { version: identity.appVersion },
  };
  fs.writeFileSync(
    path.join(dashboardDir, 'release-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o600 },
  );
  return manifest;
}

function writeSchemaV2ReleaseManifest(dashboardDir, deployedPaths = DASHBOARD_RUNTIME_FILES, options = {}) {
  for (const relative of deployedPaths) {
    const target = path.join(dashboardDir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (!fs.existsSync(target)) {
      fs.writeFileSync(target, `content for ${relative}\n`, { mode: 0o600 });
    }
  }
  const content = {
    mode: 'dashboard',
    repository: {
      commit: '1234567890abcdef1234567890abcdef12345678',
      dirty: false,
      source: {
        algorithm: 'sha256',
        digest: 'a'.repeat(64),
        state: 'clean',
        trackedDirty: false,
        untrackedSource: false,
      },
    },
    lockfile: { path: 'package-lock.json', sha256: SCHEMA_V1_RELEASE_IDENTITY.lockSha256 },
    actual: {
      serverImage: '26.7.0',
      dashboardApi: '26.7.0',
      toolsApi: '26.7.0',
    },
    contract: { fingerprint: SCHEMA_V1_RELEASE_IDENTITY.contract },
    app: {
      variant: 'full',
      releaseProfile: 'production',
      version: SCHEMA_V1_RELEASE_IDENTITY.appVersion,
      runtimeVersion: SCHEMA_V1_RELEASE_IDENTITY.appVersion,
      updateChannel: 'production',
      iosBuildNumber: '5',
    },
    deployedFiles: collectDeployedFiles(dashboardDir, deployedPaths),
  };
  const manifest = {
    kind: 'darkfinances-release',
    schemaVersion: 2,
    builtAt: SCHEMA_V1_RELEASE_IDENTITY.builtAt,
    content,
    contentDigest: {
      algorithm: 'sha256',
      canonicalization: 'darkfinances-canonical-json-v1',
      value: sha256Canonical(content),
    },
    display: { repository: { commitShort: 'unbound', branch: null } },
  };
  const manifestPath = path.join(dashboardDir, 'release-manifest.json');
  if (options.sign === false) {
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  } else {
    const signing = options.signing || createEphemeralSigningMaterial(dashboardDir);
    writeSignedManifest(manifestPath, manifest, signing.signingPath, signing.keyringPath);
  }
  return manifest;
}

function createBackupRunners(overrides = {}) {
  const {
    pingResponse,
    pingResponses,
    releaseIdentity,
    units = defaultActiveUnits(),
    ...rest
  } = overrides;
  const runners = createMockRunners({
    units,
    pingResponse: pingResponse || defaultEnvelopedPingResponse(releaseIdentity),
    ...rest,
  });
  if (Array.isArray(pingResponses) && pingResponses.length > 0) {
    let callIndex = 0;
    runners.httpGet = async (...args) => {
      runners.commands.push(['httpGet']);
      const entry = pingResponses[Math.min(callIndex, pingResponses.length - 1)];
      callIndex += 1;
      if (entry?.error) throw new Error(entry.error);
      return {
        status: entry.status || 200,
        async json() { return entry.body || envelopedPingBody({ ok: true }); },
      };
    };
  }
  return runners;
}

module.exports = {
  SCHEMA_V1_RELEASE_IDENTITY,
  SCHEMA_V1_RELEASE_IDENTITY_DIGEST,
  RELEASE_MANIFEST_BODY,
  RELEASE_MANIFEST_DIGEST,
  canonicalSerialize,
  envelopedPingBody,
  defaultEnvelopedPingResponse,
  writeSchemaV1ReleaseManifest,
  writeSchemaV2ReleaseManifest,
  createBackupRunners,
};
