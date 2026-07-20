#!/usr/bin/env node
const { getConfig } = require('@expo/config');
const path = require('path');

const appRoot = path.resolve(__dirname, '..');

function resolveMaestroAppId(env = process.env) {
  const explicit = env.MAESTRO_APP_ID || env.EXPO_PUBLIC_MAESTRO_APP_ID;
  if (explicit) return explicit;
  if (env.MAESTRO_EXPO_GO === '1' || env.EXPO_USE_EXPO_GO === '1') {
    return 'host.exp.Exponent';
  }
  const previous = process.env.FREE_IOS_SIDELOAD;
  if (env.FREE_IOS_SIDELOAD === undefined) delete process.env.FREE_IOS_SIDELOAD;
  else process.env.FREE_IOS_SIDELOAD = env.FREE_IOS_SIDELOAD;
  try {
    const { exp } = getConfig(appRoot, { skipSDKVersionRequirement: true });
    return exp?.ios?.bundleIdentifier || exp?.android?.package || 'dev.darkmg1.finances';
  } finally {
    if (previous === undefined) delete process.env.FREE_IOS_SIDELOAD;
    else process.env.FREE_IOS_SIDELOAD = previous;
  }
}

if (require.main === module) {
  process.stdout.write(`${resolveMaestroAppId()}\n`);
}

module.exports = { resolveMaestroAppId };
