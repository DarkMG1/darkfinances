#!/usr/bin/env node
'use strict';

const path = require('path');
const { verifyPublisherToolchain } = require('../finance-dashboard/lib/publisher-toolchain');
const { readRuntimeClosureContract } = require('../finance-dashboard/lib/eas-cli-runtime-closure');
const { checkPublisherInstallContractAt } = require('./check-publisher-install-contract');

const root = path.resolve(__dirname, '..');

function main() {
  checkPublisherInstallContractAt();
  const contract = readRuntimeClosureContract(root);
  const evidence = verifyPublisherToolchain(root, { verifyInstalled: true });
  if (evidence.runtimeClosureDigest !== contract.runtimeClosureDigest) {
    throw new Error('installed runtimeClosureDigest does not match checked-in contract');
  }
  if (evidence.packageCount !== contract.packageCount) {
    throw new Error(`installed packageCount ${evidence.packageCount} does not match contract ${contract.packageCount}`);
  }
  if (evidence.fileCount !== contract.fileCount) {
    throw new Error(`installed fileCount ${evidence.fileCount} does not match contract ${contract.fileCount}`);
  }
  process.stdout.write(
    `publisher-closure: ok ${evidence.packageCount} packages ${evidence.fileCount} files ${evidence.runtimeClosureDigest}\n`,
  );
}

main();
