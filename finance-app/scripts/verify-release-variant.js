#!/usr/bin/env node
const assert = require('assert/strict');
const { getConfig } = require('@expo/config');
const path = require('path');

const appRoot = path.resolve(__dirname, '..');

function pluginNames(config) {
  return (config.plugins || []).map((plugin) => (Array.isArray(plugin) ? plugin[0] : plugin));
}

function loadConfig(env = {}) {
  const previous = process.env.FREE_IOS_SIDELOAD;
  if (env.FREE_IOS_SIDELOAD === undefined) delete process.env.FREE_IOS_SIDELOAD;
  else process.env.FREE_IOS_SIDELOAD = env.FREE_IOS_SIDELOAD;
  try {
    return getConfig(appRoot, { skipSDKVersionRequirement: true });
  } finally {
    if (previous === undefined) delete process.env.FREE_IOS_SIDELOAD;
    else process.env.FREE_IOS_SIDELOAD = previous;
  }
}

function fail(message) {
  console.error(`release-variant: ${message}`);
  process.exit(1);
}

try {
  const full = loadConfig({});
  const sideload = loadConfig({ FREE_IOS_SIDELOAD: '1' });

  const fullPlugins = pluginNames(full.exp);
  const sideloadPlugins = pluginNames(sideload.exp);

  assert.ok(fullPlugins.includes('expo-widgets'), 'full build must include expo-widgets');
  assert.ok(fullPlugins.includes('expo-notifications'), 'full build must include expo-notifications');
  assert.ok(!sideloadPlugins.includes('expo-widgets'), 'sideload build must drop expo-widgets');
  assert.ok(!sideloadPlugins.includes('expo-notifications'), 'sideload build must drop expo-notifications');
  assert.ok(sideloadPlugins.includes('./plugins/with-free-sideload'), 'sideload build must add with-free-sideload');

  const fullChannel = full.exp.updates?.requestHeaders?.['expo-channel-name'];
  const sideloadChannel = sideload.exp.updates?.requestHeaders?.['expo-channel-name'];
  assert.notEqual(fullChannel, sideloadChannel, 'incompatible native variants must use separate OTA channels');

  const fullRuntime = full.exp.runtimeVersion;
  const sideloadRuntime = sideload.exp.runtimeVersion;
  assert.notDeepEqual(fullRuntime, sideloadRuntime, 'incompatible native variants must use separate runtimes');
  assert.equal(full.exp.extra?.freeSideload, false, 'full build must expose full capabilities');
  assert.equal(sideload.exp.extra?.freeSideload, true, 'sideload build must expose reduced capabilities');
} catch (error) {
  fail(error.message || String(error));
}

console.log('release-variant: ok (full vs free-sideload config)');
