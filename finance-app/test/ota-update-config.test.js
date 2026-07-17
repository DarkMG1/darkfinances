const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const script = path.resolve(__dirname, '../scripts/verify-release-variant.js');

test('release variants keep production, preview, and free-sideload OTA identities isolated', () => {
  const output = execFileSync(process.execPath, [script], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
    env: { ...process.env },
  });
  assert.match(output, /release-variant: ok/);
});

test('free-sideload config uses isolated runtime and channel semantics', () => {
  const { getConfig } = require('@expo/config');
  const appRoot = path.resolve(__dirname, '..');
  const previous = process.env.FREE_IOS_SIDELOAD;
  process.env.FREE_IOS_SIDELOAD = '1';
  try {
    const sideload = getConfig(appRoot, { skipSDKVersionRequirement: true }).exp;
    assert.equal(sideload.runtimeVersion, `${sideload.version}-free-sideload`);
    assert.equal(sideload.updates?.requestHeaders?.['expo-channel-name'], 'free-sideload');
    assert.equal(sideload.extra?.freeSideload, true);
    assert.ok(sideload.plugins.some((plugin) => {
      const name = Array.isArray(plugin) ? plugin[0] : plugin;
      return name === './plugins/with-free-sideload';
    }));
  } finally {
    if (previous === undefined) delete process.env.FREE_IOS_SIDELOAD;
    else process.env.FREE_IOS_SIDELOAD = previous;
  }
});

test('production config keeps production channel identity', () => {
  const { getConfig } = require('@expo/config');
  const appRoot = path.resolve(__dirname, '..');
  const previous = process.env.FREE_IOS_SIDELOAD;
  delete process.env.FREE_IOS_SIDELOAD;
  try {
    const full = getConfig(appRoot, { skipSDKVersionRequirement: true }).exp;
    assert.equal(full.updates?.requestHeaders?.['expo-channel-name'], 'production');
    assert.equal(full.extra?.freeSideload, false);
    assert.equal(full.runtimeVersion?.policy ?? full.runtimeVersion, 'appVersion');
  } finally {
    if (previous === undefined) delete process.env.FREE_IOS_SIDELOAD;
    else process.env.FREE_IOS_SIDELOAD = previous;
  }
});
