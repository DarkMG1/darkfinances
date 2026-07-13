const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { buildManifest, contractFingerprint } = require('../../scripts/release-manifest');

test('release manifest includes alignment and contract fields', () => {
  const manifest = buildManifest({ variant: 'test' });
  assert.equal(manifest.kind, 'darkfinances-release');
  assert.equal(manifest.schemaVersion, 1);
  assert.ok(manifest.lockfile.sha256);
  assert.equal(manifest.actual.dashboardApi, manifest.actual.toolsApi);
  assert.equal(manifest.actual.serverImage, '26.7.0');
  assert.match(manifest.contract.fingerprint, /^[a-f0-9]{16}$/);
  assert.equal(manifest.variant, 'test');
  assert.equal(contractFingerprint(), manifest.contract.fingerprint);
});

test('free-sideload manifest records its isolated OTA identity', () => {
  const manifest = buildManifest({ variant: 'free-sideload' });
  assert.equal(manifest.app.runtimeVersion, '1.2.0-free-sideload');
  assert.equal(manifest.app.updateChannel, 'free-sideload');
  assert.equal(manifest.app.iosBuildNumber, '5');
});
