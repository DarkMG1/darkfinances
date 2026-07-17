const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  assertInventoryMatchesRegistry,
  buildStateInventory,
  inventoryDigest,
  loadBackupStateInventory,
  sidecarFilenames,
} = require('../lib/backup-bundle-inventory');
const {
  bundleToolingSourcePaths,
  dashboardToolingFiles,
} = require('../lib/backup-bundle-tooling');
const {
  BUNDLE_KIND,
  BUNDLE_SCHEMA_VERSION,
  VERIFY_ENTRYPOINT,
} = require('../lib/backup-bundle-schema');
const { buildBackupBundle } = require('../lib/build-backup-bundle');
const {
  redactErrorMessage,
  stageRuntimeFromBundle,
  verifyBackupBundleArchive,
  verifyExtractedTree,
  inventoryFromBundle,
} = require('../lib/backup-bundle-verify');
const { writeProductionDashboard } = require('./fixtures/backup-bundle-dashboard-fixtures');

const repoRoot = path.resolve(__dirname, '..', '..');

function mkRoot(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function denyRepoEnv(root) {
  return {
    ...process.env,
    DARKFINANCES_REPO_ROOT: path.join(root, 'missing-repo'),
    NODE_PATH: '',
  };
}

function buildBundle(root, dashboardDir) {
  const archive = path.join(root, 'bundle.tgz');
  buildBackupBundle({ dashboardDir, archivePath: archive });
  return archive;
}

function extractBundle(archive, destination) {
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  const extract = spawnSync('tar', ['-xzf', archive, '-C', destination], { encoding: 'utf8' });
  assert.equal(extract.status, 0, extract.stderr);
}

test('backup-state-inventory matches STATE_REGISTRY with 28 backup stores', () => {
  const inventory = assertInventoryMatchesRegistry();
  assert.equal(inventory.storeCount, 28);
  assert.equal(sidecarFilenames().length, 28);
});

test('generate-backup-state-inventory is deterministic and parity-enforced', () => {
  const built = buildStateInventory();
  const committed = loadBackupStateInventory();
  assert.deepEqual(
    inventoryDigest(built),
    inventoryDigest(committed),
  );
});

test('bundle tooling closure resolves within dashboard lib seeds', () => {
  const tooling = bundleToolingSourcePaths();
  assert.ok(tooling.includes('ops/lib/backup-verify.js'));
  assert.ok(tooling.includes('finance-dashboard/lib/runtime-state-store.js'));
  for (const relative of dashboardToolingFiles()) {
    assert.ok(fs.existsSync(path.join(repoRoot, relative)), relative);
  }
});

test('build and verify relocatable bundle under alternate prefix without repository access', (t) => {
  const root = mkRoot(t, 'darkfinances-bundle-');
  const dashboard = path.join(root, 'dashboard-a');
  const backups = path.join(root, 'backups');
  const extract = path.join(root, 'extract-b');
  fs.mkdirSync(backups, { recursive: true, mode: 0o700 });
  writeProductionDashboard(dashboard, { includeLastGood: true });

  const archive = buildBundle(backups, dashboard);
  extractBundle(archive, extract);

  const verify = spawnSync('bash', [
    path.join(repoRoot, 'ops/bin/verify-backup-bundle.sh'),
    archive,
  ], {
    env: {
      ...denyRepoEnv(root),
      DARKFINANCES_BUNDLE_EXTRACT_DIR: extract,
    },
    encoding: 'utf8',
  });
  assert.equal(verify.status, 0, verify.stderr || verify.stdout);

  const manifest = JSON.parse(fs.readFileSync(path.join(extract, 'bundle-manifest.json'), 'utf8'));
  assert.equal(manifest.kind, BUNDLE_KIND);
  assert.equal(manifest.schemaVersion, BUNDLE_SCHEMA_VERSION);
  assert.equal(manifest.runtimeState.storeCount, 28);
  assert.equal(manifest.restoreTooling.verifyEntrypoint, VERIFY_ENTRYPOINT);
  assert.ok(manifest.files.some((entry) => entry.path === 'runtime/passkey-credentials.json'));
  assert.ok(manifest.files.some((entry) => entry.path === 'runtime/goals.json.last-good'));
  assert.ok(manifest.files.some((entry) => entry.path.startsWith('tooling/finance-dashboard/lib/runtime-state-store.js')));
  assert.ok(manifest.files.some((entry) => entry.path === 'tooling/ops/lib/backup-state-inventory.json'));

  const standalone = spawnSync(process.execPath, [
    path.join(extract, 'tooling/ops/bin/verify-backup-bundle.js'),
    extract,
  ], {
    env: denyRepoEnv(root),
    encoding: 'utf8',
  });
  assert.equal(standalone.status, 0, standalone.stderr || standalone.stdout);

  const staging = path.join(root, 'staging');
  stageRuntimeFromBundle({ bundleRoot: extract, stagingDir: staging, manifest });
  assert.equal(fs.existsSync(path.join(staging, 'passkey-credentials.json')), true);
  assert.equal(fs.existsSync(path.join(staging, 'receipts/r1.jpg')), true);
});

test('verify rejects checksum corruption and missing tooling', (t) => {
  const root = mkRoot(t, 'darkfinances-bundle-bad-');
  const dashboard = path.join(root, 'dashboard');
  writeProductionDashboard(dashboard);
  const archive = buildBundle(root, dashboard);

  const corrupt = `${archive}.corrupt`;
  fs.copyFileSync(archive, corrupt);
  fs.copyFileSync(`${archive}.manifest.json`, `${corrupt}.manifest.json`);
  fs.copyFileSync(`${archive}.sha256`, `${corrupt}.sha256`);
  const checksumLine = fs.readFileSync(`${corrupt}.sha256`, 'utf8').replace(path.basename(archive), path.basename(corrupt));
  fs.writeFileSync(`${corrupt}.sha256`, checksumLine);
  fs.appendFileSync(corrupt, 'truncated');
  assert.throws(
    () => verifyBackupBundleArchive({ archivePath: corrupt }),
    /archive checksum mismatch/,
  );

  const extract = path.join(root, 'extract');
  extractBundle(archive, extract);
  fs.rmSync(path.join(extract, 'tooling/ops/bin/verify-backup-bundle.js'));
  const missingTooling = spawnSync(process.execPath, [
    path.join(extract, 'tooling/ops/bin/verify-backup-bundle.js'),
    extract,
  ], { encoding: 'utf8' });
  assert.notEqual(missingTooling.status, 0);
  assert.match(missingTooling.stderr, /Cannot find module|ENOENT/);
});

test('verify rejects future bundle schema, unsafe tar paths, and unexpected members', (t) => {
  const root = mkRoot(t, 'darkfinances-bundle-guard-');
  const dashboard = path.join(root, 'dashboard');
  writeProductionDashboard(dashboard);
  const archive = buildBundle(root, dashboard);
  const manifest = JSON.parse(fs.readFileSync(`${archive}.manifest.json`, 'utf8'));

  const futureManifest = { ...manifest, schemaVersion: 99 };
  const futureArchive = path.join(root, 'future.tgz');
  const staging = path.join(root, 'stage-future');
  fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(staging, 'bundle-manifest.json'), `${JSON.stringify(futureManifest, null, 2)}\n`);
  for (const entry of manifest.files) {
    const source = path.join(root, 'extract-src');
    if (!fs.existsSync(source)) {
      extractBundle(archive, source);
    }
    const from = path.join(source, entry.path);
    const to = path.join(staging, entry.path);
    fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
    fs.copyFileSync(from, to);
  }
  spawnSync('tar', ['-C', staging, '-czf', futureArchive, '.'], { encoding: 'utf8' });
  fs.writeFileSync(`${futureArchive}.manifest.json`, `${JSON.stringify(futureManifest, null, 2)}\n`);
  assert.throws(
    () => verifyBackupBundleArchive({ archivePath: futureArchive }),
    /unsupported bundle schemaVersion 99/,
  );

  const unsafeArchive = path.join(root, 'unsafe.tgz');
  const unsafeStage = path.join(root, 'stage-unsafe');
  fs.mkdirSync(unsafeStage, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(unsafeStage, 'runtime'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(unsafeStage, 'bundle-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(path.join(unsafeStage, 'runtime/escape.json'), '{}\n');
  fs.symlinkSync('/etc/passwd', path.join(unsafeStage, 'runtime/link.json'));
  const unsafeManifest = {
    ...manifest,
    files: [
      ...manifest.files,
      {
        path: '../outside.json',
        sha256: '0'.repeat(64),
        bytes: 2,
        mode: 0o600,
      },
    ],
  };
  fs.writeFileSync(path.join(unsafeStage, 'bundle-manifest.json'), `${JSON.stringify(unsafeManifest, null, 2)}\n`);
  spawnSync('tar', ['-C', unsafeStage, '-czf', unsafeArchive, 'bundle-manifest.json', 'runtime'], { encoding: 'utf8' });
  fs.writeFileSync(`${unsafeArchive}.manifest.json`, `${JSON.stringify(unsafeManifest, null, 2)}\n`);
  assert.throws(
    () => verifyBackupBundleArchive({ archivePath: unsafeArchive }),
    /unsafe|symbolic links are forbidden|unexpected archive member|duplicate/,
  );
});

test('verify rejects digest mismatch and unsafe runtime modes', (t) => {
  const root = mkRoot(t, 'darkfinances-bundle-digest-');
  const dashboard = path.join(root, 'dashboard');
  writeProductionDashboard(dashboard);
  const archive = buildBundle(root, dashboard);
  const extract = path.join(root, 'extract');
  extractBundle(archive, extract);

  const goals = path.join(extract, 'runtime/goals.json');
  fs.writeFileSync(goals, '[{"id":"tampered"}]\n');
  const manifest = JSON.parse(fs.readFileSync(path.join(extract, 'bundle-manifest.json'), 'utf8'));
  const inventory = inventoryFromBundle(extract);
  assert.throws(
    () => verifyExtractedTree({ bundleRoot: extract, manifest, inventory }),
    /checksum mismatch for runtime\/goals.json|size mismatch for runtime\/goals.json/,
  );

  extractBundle(archive, path.join(root, 'extract2'));
  const extract2 = path.join(root, 'extract2');
  fs.chmodSync(path.join(extract2, 'runtime/passkey-credentials.json'), 0o644);
  const manifest2 = JSON.parse(fs.readFileSync(path.join(extract2, 'bundle-manifest.json'), 'utf8'));
  const inventory2 = inventoryFromBundle(extract2);
  assert.throws(
    () => verifyExtractedTree({ bundleRoot: extract2, manifest: manifest2, inventory: inventory2 }),
    /mode mismatch for runtime\/passkey-credentials.json/,
  );
});

test('passkey and credential errors are redacted from surfaced messages', () => {
  const message = redactErrorMessage('passkey-credentials.json failed: credentialPublicKey invalid');
  assert.doesNotMatch(message, /credentialPublicKey invalid/);
  assert.match(message, /\[redacted\]/);
});

test('verify failure output does not echo secret sidecar contents', (t) => {
  const root = mkRoot(t, 'darkfinances-bundle-secrets-');
  const dashboard = path.join(root, 'dashboard');
  writeProductionDashboard(dashboard, {
    overrides: {
      passkeyCredentials: [{ credentialID: 'secret-id', credentialPublicKey: 'PUBLICKEYSECRET', counter: 0 }],
    },
  });
  const archive = buildBundle(root, dashboard);
  const extract = path.join(root, 'extract');
  extractBundle(archive, extract);
  fs.writeFileSync(
    path.join(extract, 'runtime/passkey-credentials.json'),
    '[{"credentialID":"secret-id","credentialPublicKey":"PUBLICKEYSECRET","counter":-1}]\n',
  );

  let thrown = null;
  try {
    verifyBackupBundleArchive({ archivePath: archive, bundleRoot: extract });
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown);
  const surfaced = `${thrown.message}\n${thrown.stack || ''}`;
  assert.doesNotMatch(surfaced, /PUBLICKEYSECRET/);
});

test('build-backup-bundle.sh produces a verifiable archive', (t) => {
  const root = mkRoot(t, 'darkfinances-bundle-script-');
  const dashboard = path.join(root, 'dashboard');
  const destination = path.join(root, 'backups');
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  writeProductionDashboard(dashboard);

  const build = spawnSync('bash', [path.join(repoRoot, 'ops/bin/build-backup-bundle.sh')], {
    env: {
      ...process.env,
      FINANCE_DASHBOARD_DIR: dashboard,
      DARKFINANCES_BACKUP_DIR: destination,
    },
    encoding: 'utf8',
  });
  assert.equal(build.status, 0, build.stderr);
  const archive = build.stdout.trim();
  verifyBackupBundleArchive({ archivePath: archive });
});
