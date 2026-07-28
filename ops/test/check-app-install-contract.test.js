'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const repositoryRoot = path.resolve(__dirname, '..', '..');
const appRoot = path.join(repositoryRoot, 'finance-app');
const contractScript = path.join(appRoot, 'scripts', 'check-app-install-contract.js');
const {
  EXPECTED_OVERRIDES,
  checkAppInstallContract,
  checkAppInstallContractAt,
  checkAppLockfileRepro,
} = require(contractScript);

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-app-contract-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeFixture(root, { pkg, lock }) {
  fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  fs.writeFileSync(path.join(root, 'package-lock.json'), `${JSON.stringify(lock, null, 2)}\n`);
}

test('repository finance-app install contract passes against current lockfile', () => {
  assert.doesNotThrow(() => checkAppInstallContract());
});

test('repository finance-app lockfile reproduces with package-lock-only in isolation', () => {
  const digest = checkAppLockfileRepro();
  assert.match(digest, /^[a-f0-9]{64}$/);
});

test('checkAppInstallContractAt rejects workspace-root fallback lockfiles', (t) => {
  const root = fixture(t);
  writeFixture(root, {
    pkg: {
      name: 'finance-app',
      version: '1.2.0',
      overrides: EXPECTED_OVERRIDES,
      dependencies: { expo: '~56.0.15' },
      devDependencies: { eslint: '^9.39.4' },
    },
    lock: {
      name: 'darkfinances',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': {
          name: 'darkfinances',
          version: '1.0.0',
          dependencies: { expo: '~56.0.15' },
          devDependencies: { eslint: '^9.39.4' },
        },
        'node_modules/postcss': { version: '8.5.23' },
        'node_modules/uuid': { version: '11.1.1' },
      },
    },
  });

  assert.throws(
    () => checkAppInstallContractAt(root),
    /top-level name must match|root package must be finance-app|must not fall back to workspace root package darkfinances/,
  );
});

test('checkAppInstallContractAt rejects missing expected overrides', (t) => {
  const root = fixture(t);
  writeFixture(root, {
    pkg: {
      name: 'finance-app',
      version: '1.2.0',
      dependencies: { expo: '~56.0.15' },
      devDependencies: { eslint: '^9.39.4' },
    },
    lock: {
      name: 'finance-app',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': {
          name: 'finance-app',
          version: '1.2.0',
          dependencies: { expo: '~56.0.15' },
          devDependencies: { eslint: '^9.39.4' },
        },
        'node_modules/postcss': { version: '8.5.23' },
        'node_modules/uuid': { version: '11.1.1' },
      },
    },
  });

  assert.throws(
    () => checkAppInstallContractAt(root),
    /overrides do not match the expected install contract/,
  );
});
