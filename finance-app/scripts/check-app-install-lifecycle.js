#!/usr/bin/env node
'use strict';

const path = require('path');
const {
  checkUnrsResolver,
} = require('../../scripts/check-install-lifecycle');

const APP_ROOT = path.resolve(__dirname, '..');

function checkAppInstallLifecycle({ root = APP_ROOT } = {}) {
  checkUnrsResolver(root, { localOnly: true });
  return {
    root,
    modules: ['unrs-resolver'],
  };
}

function main() {
  try {
    const result = checkAppInstallLifecycle();
    console.log(`app-install-lifecycle: ok (${result.modules.join(', ')})`);
  } catch (error) {
    console.error(`app-install-lifecycle: ${error.message}`);
    process.exit(1);
  }
}

if (require.main === module) main();
module.exports = {
  checkAppInstallLifecycle,
};
