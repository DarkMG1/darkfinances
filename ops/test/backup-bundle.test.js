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
  EMBEDDED_MANIFEST,
  VERIFY_ENTRYPOINT,
  ARCHIVE_MAX_MEMBER_COUNT,
  ARCHIVE_MAX_DECLARED_BYTES,
} = require('../lib/backup-bundle-schema');
const { buildBackupBundle, removePartialArtifacts } = require('../lib/build-backup-bundle');
const {
  redactErrorMessage,
  stageRuntimeFromBundle,
  verifyBackupBundleArchive,
  verifyExtractedTree,
  inventoryFromBundle,
  assertArchivePreflightBounds,
} = require('../lib/backup-bundle-verify');
const { writeProductionDashboard } = require('./fixtures/backup-bundle-dashboard-fixtures');

const repoRoot = path.resolve(__dirname, '..', '..');
const verifyShell = path.join(repoRoot, 'ops/bin/verify-backup-bundle.sh');
const archiveVerifier = path.join(repoRoot, 'ops/lib/verify-backup-bundle-archive.js');

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

function runShellVerify(archive, env = {}) {
  return spawnSync('bash', [verifyShell, archive], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

function snapshotTree(root) {
  const files = [];
  function walk(relativeDir) {
    const absoluteDir = relativeDir ? path.join(root, relativeDir) : root;
    if (!fs.existsSync(absoluteDir)) return;
    for (const name of fs.readdirSync(absoluteDir).sort()) {
      const relativePath = relativeDir ? `${relativeDir}/${name}` : name;
      const absolutePath = path.join(root, relativePath);
      const stat = fs.lstatSync(absolutePath);
      files.push({
        path: relativePath,
        isSymlink: stat.isSymbolicLink(),
        isFile: stat.isFile(),
        isDirectory: stat.isDirectory(),
      });
      if (stat.isDirectory()) walk(relativePath);
    }
  }
  walk('');
  return files;
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
  assert.ok(tooling.includes('ops/lib/backup-bundle-manifest.js'));
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

  const verify = runShellVerify(archive, {
    ...denyRepoEnv(root),
    DARKFINANCES_BUNDLE_EXTRACT_DIR: extract,
  });
  assert.equal(verify.status, 0, verify.stderr || verify.stdout);
  assert.equal(fs.existsSync(path.join(extract, 'runtime/passkey-credentials.json')), true);

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

test('shell verify rejects appended archive bytes and checksum tamper', (t) => {
  const root = mkRoot(t, 'darkfinances-shell-checksum-');
  const dashboard = path.join(root, 'dashboard');
  writeProductionDashboard(dashboard);
  const archive = buildBundle(root, dashboard);

  const corrupt = path.join(root, 'corrupt.tgz');
  fs.copyFileSync(archive, corrupt);
  fs.copyFileSync(`${archive}.manifest.json`, `${corrupt}.manifest.json`);
  fs.copyFileSync(`${archive}.sha256`, `${corrupt}.sha256`);
  fs.appendFileSync(corrupt, 'truncated');

  assert.throws(
    () => verifyBackupBundleArchive({ archivePath: corrupt }),
    /archive checksum mismatch/,
  );

  const shell = runShellVerify(corrupt, denyRepoEnv(root));
  assert.notEqual(shell.status, 0);
  assert.match(shell.stderr + shell.stdout, /archive checksum mismatch/);
});

test('shell verify rejects sidecar and embedded manifest drift', (t) => {
  const root = mkRoot(t, 'darkfinances-shell-drift-');
  const dashboard = path.join(root, 'dashboard');
  writeProductionDashboard(dashboard);
  const archive = buildBundle(root, dashboard);
  const manifest = JSON.parse(fs.readFileSync(`${archive}.manifest.json`, 'utf8'));
  const drifted = { ...manifest, schemaVersion: 99 };
  fs.writeFileSync(`${archive}.manifest.json`, `${JSON.stringify(drifted, null, 2)}\n`);

  assert.throws(
    () => verifyBackupBundleArchive({ archivePath: archive }),
    /embedded manifest does not match sidecar manifest|unsupported bundle schemaVersion 99/,
  );

  const shell = runShellVerify(archive, denyRepoEnv(root));
  assert.notEqual(shell.status, 0);
});

test('shell verify rejects trimmed manifest omitting required passkey store', (t) => {
  const root = mkRoot(t, 'darkfinances-shell-trim-');
  const dashboard = path.join(root, 'dashboard');
  writeProductionDashboard(dashboard);
  const archive = buildBundle(root, dashboard);
  const extract = path.join(root, 'publish');
  fs.mkdirSync(extract, { recursive: true, mode: 0o700 });
  extractBundle(archive, extract);

  const manifest = JSON.parse(fs.readFileSync(path.join(extract, EMBEDDED_MANIFEST), 'utf8'));
  manifest.files = manifest.files.filter((entry) => entry.path !== 'runtime/passkey-credentials.json');
  fs.writeFileSync(path.join(extract, EMBEDDED_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(`${archive}.manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);

  const standalone = spawnSync(process.execPath, [
    path.join(extract, 'tooling/ops/bin/verify-backup-bundle.js'),
    extract,
  ], { encoding: 'utf8' });
  assert.notEqual(standalone.status, 0);
  assert.match(standalone.stderr + standalone.stdout, /required runtime store missing/);

  assert.throws(
    () => verifyBackupBundleArchive({ archivePath: archive, bundleRoot: extract }),
    /required runtime store missing|embedded manifest does not match/,
  );
});

test('build rejects missing required runtime store and removes partial artifacts', (t) => {
  const root = mkRoot(t, 'darkfinances-build-required-');
  const dashboard = path.join(root, 'dashboard');
  writeProductionDashboard(dashboard);
  fs.rmSync(path.join(dashboard, 'goals.json'));

  const archive = path.join(root, 'partial.tgz');
  assert.throws(
    () => buildBackupBundle({ dashboardDir: dashboard, archivePath: archive }),
    /required runtime store missing at build time: goals.json/,
  );
  assert.equal(fs.existsSync(archive), false);
  assert.equal(fs.existsSync(`${archive}.manifest.json`), false);
  assert.equal(fs.existsSync(`${archive}.sha256`), false);

  removePartialArtifacts(archive);
});

test('verify rejects checksum corruption and missing tooling', (t) => {
  const root = mkRoot(t, 'darkfinances-bundle-bad-');
  const dashboard = path.join(root, 'dashboard');
  writeProductionDashboard(dashboard);
  const archive = buildBundle(root, dashboard);

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
  fs.writeFileSync(`${futureArchive}.sha256`, `${require('../lib/backup-verify').sha256File(futureArchive)}  future.tgz\n`);
  assert.throws(
    () => verifyBackupBundleArchive({ archivePath: futureArchive }),
    /unsupported bundle schemaVersion 99|embedded manifest does not match/,
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
  fs.writeFileSync(`${unsafeArchive}.sha256`, `${require('../lib/backup-verify').sha256File(unsafeArchive)}  unsafe.tgz\n`);
  assert.throws(
    () => verifyBackupBundleArchive({ archivePath: unsafeArchive }),
    /unsafe|symbolic links are forbidden|unexpected archive member|duplicate/,
  );
});

test('failed symlink archive verify leaves no residue in publish destination', (t) => {
  const root = mkRoot(t, 'darkfinances-symlink-residue-');
  const dashboard = path.join(root, 'dashboard');
  writeProductionDashboard(dashboard);
  const archive = buildBundle(root, dashboard);
  const manifest = JSON.parse(fs.readFileSync(`${archive}.manifest.json`, 'utf8'));

  const hostile = path.join(root, 'hostile.tgz');
  const stage = path.join(root, 'hostile-stage');
  fs.mkdirSync(path.join(stage, 'runtime'), { recursive: true, mode: 0o700 });
  extractBundle(archive, stage);
  fs.rmSync(path.join(stage, 'runtime/goals.json'));
  fs.symlinkSync('/etc/passwd', path.join(stage, 'runtime/goals.json'));
  const hostileManifest = {
    ...manifest,
    files: manifest.files.map((entry) => (
      entry.path === 'runtime/goals.json'
        ? { ...entry, sha256: '0'.repeat(64), bytes: 1 }
        : entry
    )),
  };
  fs.writeFileSync(path.join(stage, EMBEDDED_MANIFEST), `${JSON.stringify(hostileManifest, null, 2)}\n`);
  spawnSync('tar', ['-C', stage, '-czf', hostile, EMBEDDED_MANIFEST, ...hostileManifest.files.map((e) => e.path)], { encoding: 'utf8' });
  fs.writeFileSync(`${hostile}.manifest.json`, `${JSON.stringify(hostileManifest, null, 2)}\n`);
  fs.writeFileSync(`${hostile}.sha256`, `${require('../lib/backup-verify').sha256File(hostile)}  hostile.tgz\n`);

  const publish = path.join(root, 'publish');
  fs.mkdirSync(publish, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(publish, 'keep.txt'), 'stay\n');
  const before = snapshotTree(publish);

  const shell = runShellVerify(hostile, {
    ...denyRepoEnv(root),
    DARKFINANCES_BUNDLE_EXTRACT_DIR: publish,
  });
  assert.notEqual(shell.status, 0);
  assert.deepEqual(snapshotTree(publish), before);
});

test('verify rejects tampered toolingDigest and artifact.id without self-repair', (t) => {
  const root = mkRoot(t, 'darkfinances-provenance-');
  const dashboard = path.join(root, 'dashboard');
  writeProductionDashboard(dashboard);
  const archive = buildBundle(root, dashboard);
  const extract = path.join(root, 'extract');
  extractBundle(archive, extract);

  const manifest = JSON.parse(fs.readFileSync(path.join(extract, EMBEDDED_MANIFEST), 'utf8'));
  const before = JSON.stringify(manifest);
  manifest.restoreTooling.toolingDigest = '0'.repeat(64);
  fs.writeFileSync(path.join(extract, EMBEDDED_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);

  const inventory = inventoryFromBundle(extract);
  assert.throws(
    () => verifyExtractedTree({ bundleRoot: extract, manifest, inventory }),
    /toolingDigest mismatch/,
  );
  assert.equal(fs.readFileSync(path.join(extract, EMBEDDED_MANIFEST), 'utf8'), `${JSON.stringify(manifest, null, 2)}\n`);

  const manifest2 = JSON.parse(before);
  manifest2.artifact.id = '0'.repeat(64);
  assert.throws(
    () => verifyExtractedTree({ bundleRoot: extract, manifest: manifest2, inventory }),
    /artifact.id mismatch/,
  );
});

test('verify rejects archive bounds before extraction', (t) => {
  const root = mkRoot(t, 'darkfinances-bounds-');
  const dashboard = path.join(root, 'dashboard');
  writeProductionDashboard(dashboard);
  const archive = buildBundle(root, dashboard);
  const manifest = JSON.parse(fs.readFileSync(`${archive}.manifest.json`, 'utf8'));

  const hugeManifest = {
    ...manifest,
    files: [
      ...manifest.files,
      {
        path: 'runtime/bomb.json',
        sha256: '0'.repeat(64),
        bytes: ARCHIVE_MAX_DECLARED_BYTES,
        mode: 0o600,
      },
    ],
  };
  assert.throws(
    () => assertArchivePreflightBounds(hugeManifest),
    /declared bytes exceed bound/,
  );

  const manyFiles = Array.from({ length: ARCHIVE_MAX_MEMBER_COUNT }, (_, index) => ({
    path: `runtime/pad-${index}.json`,
    sha256: '0'.repeat(64),
    bytes: 2,
    mode: 0o600,
  }));
  assert.throws(
    () => assertArchivePreflightBounds({ files: manyFiles }),
    /member count exceeds bound/,
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

test('archive verifier entrypoint enforces full trust chain under hidden repo relocation', (t) => {
  const root = mkRoot(t, 'darkfinances-hidden-repo-');
  const dashboard = path.join(root, 'dashboard');
  writeProductionDashboard(dashboard);
  const archive = buildBundle(root, dashboard);

  const result = spawnSync(process.execPath, [archiveVerifier, archive], {
    env: denyRepoEnv(root),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /verify-backup-bundle: ok/);
});
