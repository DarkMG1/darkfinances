#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const {
  CONTRACT_REL,
  DERIVATION_VERSION,
  PACKAGE_NAME,
  PUBLISHER_ROOT_REL,
  STANDALONE_INSTALL_COMMAND,
  assertBoundPublisherPlatformForClosureRegen,
  computeRuntimeClosureFromInstall,
  hashFileSha256,
  resolvePublisherRoot,
} = require('../finance-dashboard/lib/eas-cli-runtime-closure');

const ROOT = path.resolve(__dirname, '..');
const PUBLISHER_ROOT = resolvePublisherRoot(ROOT);
const OUTPUT = path.join(ROOT, CONTRACT_REL);

function readEasIntegrity(lock) {
  const entry = lock.packages?.[`node_modules/${PACKAGE_NAME}`];
  if (!entry?.version || !entry?.integrity) {
    throw new Error(`${PUBLISHER_ROOT_REL}/package-lock.json missing eas-cli version/integrity`);
  }
  return entry;
}

function main(options = {}) {
  assertBoundPublisherPlatformForClosureRegen(options);
  const lockPath = path.join(PUBLISHER_ROOT, 'package-lock.json');
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  const easEntry = readEasIntegrity(lock);
  const computed = computeRuntimeClosureFromInstall(PUBLISHER_ROOT, lock, options);
  const contract = {
    schemaVersion: 1,
    derivationVersion: DERIVATION_VERSION,
    platform: options.platform ?? process.platform,
    arch: options.arch ?? process.arch,
    package: PACKAGE_NAME,
    version: easEntry.version,
    integrity: easEntry.integrity,
    lockfilePath: `${PUBLISHER_ROOT_REL}/package-lock.json`,
    lockfileSha256: hashFileSha256(lockPath),
    runtimeClosureDigest: computed.runtimeClosureDigest,
    packageCount: computed.packageCount,
    fileCount: computed.fileCount,
    standaloneInstallCommand: STANDALONE_INSTALL_COMMAND,
    provenance: `Derived from standalone ${PUBLISHER_ROOT_REL} install after ${STANDALONE_INSTALL_COMMAND} on ${options.platform ?? process.platform}/${options.arch ?? process.arch}; runtimeClosureDigest covers sorted lockPath/name/version/packagePayloadDigest records where each packagePayloadDigest hashes package files excluding nested node_modules after verifying the installed physical package set exactly matches the lock-derived closure.`,
  };
  fs.writeFileSync(OUTPUT, `${JSON.stringify(contract, null, 2)}\n`);
  process.stdout.write(
    `wrote ${OUTPUT} (${computed.packageCount} packages, ${computed.fileCount} files, digest ${computed.runtimeClosureDigest})\n`,
  );
  return contract;
}

if (require.main === module) main();
module.exports = {
  main,
  assertBoundPublisherPlatformForClosureRegen,
};
