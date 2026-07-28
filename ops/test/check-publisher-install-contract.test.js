'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  EXPECTED_TYPESCRIPT_OVERRIDE,
  checkNoEasCliAtRoot,
  checkPublisherInstallContractAt,
  checkPublisherNotWorkspaceMember,
  normalizeRootWorkspaces,
  workspacePatternCouldMatchPublisherToolchain,
} = require('../../scripts/check-publisher-install-contract');
const { checkNoEasCliInApp } = require('../../finance-app/scripts/check-app-install-contract');

const repositoryRoot = path.resolve(__dirname, '..', '..');
const publisherRoot = path.join(repositoryRoot, 'ops/publisher-toolchain');
const appRoot = path.join(repositoryRoot, 'finance-app');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-publisher-contract-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeMinimalPublisher(root, repoRoot, { workspaces, rootEas = false } = {}) {
  const publisherDir = path.join(root, 'ops/publisher-toolchain');
  const lockWorkspaces = workspaces == null ? undefined : normalizeRootWorkspaces(workspaces);
  fs.mkdirSync(publisherDir, { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'package.json'), JSON.stringify({
    name: 'darkfinances',
    version: '1.0.0',
    ...(workspaces != null ? { workspaces } : {}),
    ...(rootEas ? { devDependencies: { 'eas-cli': '21.3.0' } } : {}),
  }, null, 2));
  fs.writeFileSync(path.join(publisherDir, 'package.json'), JSON.stringify({
    name: 'publisher-toolchain',
    version: '1.0.0',
    overrides: { typescript: EXPECTED_TYPESCRIPT_OVERRIDE },
    devDependencies: { 'eas-cli': '21.3.0' },
  }, null, 2));
  fs.writeFileSync(path.join(publisherDir, 'package-lock.json'), JSON.stringify({
    name: 'publisher-toolchain',
    lockfileVersion: 3,
    packages: {
      '': { name: 'publisher-toolchain', version: '1.0.0' },
      'node_modules/eas-cli': {
        version: '21.3.0',
        integrity: 'sha512-6btEJ0LVhRw4Hx8XSlCHSaSXgGBRpPr+90/7+NYu2HZ+1CP4lRnWqerXUdui7kUWxyst4f6OolKO+oWQ58nqHQ==',
      },
      'node_modules/typescript': { version: EXPECTED_TYPESCRIPT_OVERRIDE },
    },
  }, null, 2));
  if (rootEas) {
    fs.writeFileSync(path.join(repoRoot, 'package-lock.json'), JSON.stringify({
      name: 'darkfinances',
      lockfileVersion: 3,
      packages: {
        '': {
          name: 'darkfinances',
          version: '1.0.0',
          ...(lockWorkspaces ? { workspaces: lockWorkspaces } : {}),
        },
        'node_modules/eas-cli': { version: '21.3.0' },
      },
    }, null, 2));
  } else {
    fs.writeFileSync(path.join(repoRoot, 'package-lock.json'), JSON.stringify({
      name: 'darkfinances',
      lockfileVersion: 3,
      packages: {
        '': {
          name: 'darkfinances',
          version: '1.0.0',
          ...(lockWorkspaces ? { workspaces: lockWorkspaces } : {}),
        },
      },
    }, null, 2));
  }
  return publisherDir;
}

test('publisher-toolchain is not a root npm workspace member', () => {
  assert.doesNotThrow(() => checkPublisherNotWorkspaceMember(repositoryRoot));
});

test('repository publisher install contract passes against current lockfile', () => {
  assert.doesNotThrow(() => checkPublisherInstallContractAt());
});

test('repository publisher lockfile resolves typescript override for npm ci reproducibility', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(publisherRoot, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(publisherRoot, 'package-lock.json'), 'utf8'));
  assert.equal(pkg.overrides.typescript, EXPECTED_TYPESCRIPT_OVERRIDE);
  assert.equal(lock.packages['node_modules/typescript'].version, EXPECTED_TYPESCRIPT_OVERRIDE);
});

test('normalizeRootWorkspaces accepts array and object forms', () => {
  assert.deepEqual(normalizeRootWorkspaces(['finance-app']), ['finance-app']);
  assert.deepEqual(normalizeRootWorkspaces({ packages: ['finance-app'] }), ['finance-app']);
});

test('workspacePatternCouldMatchPublisherToolchain rejects dangerous globs', () => {
  assert.equal(workspacePatternCouldMatchPublisherToolchain('ops/publisher-toolchain'), true);
  assert.equal(workspacePatternCouldMatchPublisherToolchain('./ops/publisher-toolchain/'), true);
  assert.equal(workspacePatternCouldMatchPublisherToolchain('ops/*'), true);
  assert.equal(workspacePatternCouldMatchPublisherToolchain('*'), true);
  assert.equal(workspacePatternCouldMatchPublisherToolchain('**/*'), true);
  assert.equal(workspacePatternCouldMatchPublisherToolchain('{finance-app,ops/publisher-toolchain}'), true);
  assert.equal(workspacePatternCouldMatchPublisherToolchain('ops/{publisher-toolchain,actual-tools}'), true);
  assert.equal(workspacePatternCouldMatchPublisherToolchain('ops/+(publisher-toolchain)'), true);
  assert.equal(workspacePatternCouldMatchPublisherToolchain('finance-app'), false);
});

test('checkPublisherNotWorkspaceMember rejects explicit publisher path', (t) => {
  const root = fixture(t);
  writeMinimalPublisher(root, root, { workspaces: ['ops/publisher-toolchain'] });
  assert.throws(
    () => checkPublisherNotWorkspaceMember(root),
    /can include ops\/publisher-toolchain/,
  );
});

test('checkPublisherNotWorkspaceMember rejects array glob ops/*', (t) => {
  const root = fixture(t);
  writeMinimalPublisher(root, root, { workspaces: ['finance-app', 'ops/*'] });
  assert.throws(
    () => checkPublisherNotWorkspaceMember(root),
    /pattern "ops\/\*"/,
  );
});

test('checkPublisherNotWorkspaceMember rejects object workspaces packages glob', (t) => {
  const root = fixture(t);
  writeMinimalPublisher(root, root, { workspaces: { packages: ['**/*'] } });
  assert.throws(
    () => checkPublisherNotWorkspaceMember(root),
    /pattern "\*\*\/\*"/,
  );
});

test('checkPublisherNotWorkspaceMember rejects brace and extglob patterns', (t) => {
  for (const pattern of [
    '{finance-app,ops/publisher-toolchain}',
    'ops/{publisher-toolchain,actual-tools}',
    'ops/+(publisher-toolchain)',
  ]) {
    const root = fixture(t);
    writeMinimalPublisher(root, root, { workspaces: ['finance-app', pattern] });
    assert.throws(
      () => checkPublisherNotWorkspaceMember(root),
      /publisher toolchain must remain isolated/,
    );
  }
});

test('checkPublisherNotWorkspaceMember allows existing workspace members', (t) => {
  const root = fixture(t);
  writeMinimalPublisher(root, root, {
    workspaces: ['finance-app', 'finance-dashboard', 'actual-tools'],
  });
  assert.doesNotThrow(() => checkPublisherNotWorkspaceMember(root));
});

test('checkPublisherNotWorkspaceMember rejects package-lock workspace drift', (t) => {
  const root = fixture(t);
  writeMinimalPublisher(root, root, { workspaces: ['finance-app'] });
  const lockPath = path.join(root, 'package-lock.json');
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  lock.packages[''].workspaces = ['finance-app', 'ops/*'];
  fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2));
  assert.throws(
    () => checkPublisherNotWorkspaceMember(root),
    /workspace lists must match exactly/,
  );
});

test('repository publisher lockfile reproduces with package-lock-only in isolation', () => {
  const { checkPublisherLockfileRepro } = require('../../scripts/check-publisher-install-contract');
  const digest = checkPublisherLockfileRepro();
  assert.match(digest, /^[a-f0-9]{64}$/);
});

test('checkNoEasCliAtRoot passes for repository root', () => {
  assert.doesNotThrow(() => checkNoEasCliAtRoot(repositoryRoot));
});

test('checkNoEasCliAtRoot rejects root package and lock entries', (t) => {
  const root = fixture(t);
  writeMinimalPublisher(root, root, { workspaces: [] });
  assert.doesNotThrow(() => checkNoEasCliAtRoot(root));
  const badRoot = fixture(t);
  writeMinimalPublisher(badRoot, badRoot, { rootEas: true });
  assert.throws(
    () => checkNoEasCliAtRoot(badRoot),
    /root package\.json must not declare eas-cli/,
  );
});

test('checkNoEasCliAtRoot rejects a lock-only eas-cli entry', (t) => {
  const root = fixture(t);
  writeMinimalPublisher(root, root, { workspaces: [] });
  const lockPath = path.join(root, 'package-lock.json');
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  lock.packages['node_modules/eas-cli'] = { version: '21.3.0' };
  fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2));
  assert.throws(
    () => checkNoEasCliAtRoot(root),
    /root package-lock\.json must not contain node_modules\/eas-cli/,
  );
});

test('finance-app install contract rejects eas-cli in package.json or lockfile', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(appRoot, 'package-lock.json'), 'utf8'));
  assert.doesNotThrow(() => checkNoEasCliInApp(pkg, lock));
  assert.throws(
    () => checkNoEasCliInApp({ ...pkg, devDependencies: { ...pkg.devDependencies, 'eas-cli': '21.3.0' } }, lock),
    /must not declare eas-cli/,
  );
});

test('checkPublisherInstallContractAt rejects missing typescript override', (t) => {
  const root = fixture(t);
  const publisherDir = writeMinimalPublisher(root, root, { workspaces: [] });
  const pkgPath = path.join(publisherDir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  delete pkg.overrides;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
  assert.throws(
    () => checkPublisherInstallContractAt(publisherDir, root),
    /must override typescript@5\.9\.3/,
  );
});
