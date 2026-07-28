'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const {
  attachChildLogHandlers,
  buildDashboardServerEnv,
  copyDashboardRuntimeFixture,
  dashboardRoot,
  provisionProductionReleaseEvidence,
  waitForChildExit,
} = require('./helpers/ephemeral-dashboard-server');

const DEMO_READY_PRELOAD = `
  const path = require('path');
  const dataPath = require.resolve(path.join(process.env.TEST_DASHBOARD_ROOT, 'dataModule.js'));
  require.cache[dataPath] = {
    id: dataPath,
    filename: dataPath,
    loaded: true,
    exports: {
      initApi: async () => ({ ok: true }),
      shutdownApi: async () => ({ ok: true }),
      getHealth: () => ({ ready: true }),
    },
    children: [],
    paths: [],
  };
`;

function createTempRuntimeCopy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-prod-runtime-'));
  copyDashboardRuntimeFixture(dashboardRoot(), dir);
  return dir;
}

async function spawnProductionStartupProbe({
  runtimeRoot,
  evidenceDir,
  releaseEvidence = null,
  extraEnv = {},
  readyPattern = /Finance dashboard running on/,
  readyTimeoutMs = 20_000,
} = {}) {
  const dir = evidenceDir || fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-prod-evidence-'));
  const preloadPath = path.join(dir, 'demo-ready-preload.js');
  fs.writeFileSync(preloadPath, DEMO_READY_PRELOAD);
  const evidence = releaseEvidence || provisionProductionReleaseEvidence(dir, runtimeRoot);
  const logs = { value: '' };
  const child = spawn(process.execPath, ['server.js'], {
    cwd: runtimeRoot,
    env: buildDashboardServerEnv({
      dir,
      instanceId: 'c'.repeat(32),
      nodeEnv: 'production',
      demoOnly: true,
      preloadPath,
      runtimeRoot,
      extraEnv: {
        RELEASE_KEYRING_PATH: evidence.keyringPath,
        RELEASE_MANIFEST_PATH: evidence.manifestPath,
        ...extraEnv,
      },
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  attachChildLogHandlers(child, logs);
  const result = await new Promise((resolve) => {
    let settled = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      resolve(payload);
    };
    const checkReady = () => {
      if (readyPattern.test(logs.value)) {
        finish({ exitCode: 0, logs: logs.value, ready: true, child, dir, releaseEvidence: evidence });
      }
    };
    child.stdout.on('data', checkReady);
    child.stderr.on('data', checkReady);
    child.once('exit', (exitCode) => finish({
      exitCode,
      logs: logs.value,
      ready: false,
      child,
      dir,
      releaseEvidence: evidence,
    }));
    setTimeout(
      () => finish({
        exitCode: child.exitCode,
        logs: logs.value,
        ready: false,
        timedOut: true,
        child,
        dir,
        releaseEvidence: evidence,
      }),
      readyTimeoutMs,
    );
  });
  return result;
}

async function cleanupProbe(result, { keepEvidenceDir = false } = {}) {
  if (result.child.exitCode == null) {
    result.child.kill('SIGTERM');
  }
  await waitForChildExit(result.child, 5_000).catch(() => {});
  if (!keepEvidenceDir && result.dir) {
    fs.rmSync(result.dir, { recursive: true, force: true });
  }
}

test('production startup accepts signed deployment when runtime bytes match manifest', async (t) => {
  const runtimeRoot = createTempRuntimeCopy();
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const result = await spawnProductionStartupProbe({ runtimeRoot });
  t.after(async () => cleanupProbe(result));
  assert.equal(result.ready, true, result.logs);
  assert.match(result.logs, /Finance dashboard running on/);
});

test('production startup rejects tampered runtime file bytes before listening', async (t) => {
  const runtimeRoot = createTempRuntimeCopy();
  const evidenceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-prod-evidence-'));
  t.after(() => {
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
    fs.rmSync(evidenceDir, { recursive: true, force: true });
  });
  const releaseEvidence = provisionProductionReleaseEvidence(evidenceDir, runtimeRoot);
  const tamperTarget = path.join(runtimeRoot, 'lib', 'errors.js');
  fs.appendFileSync(tamperTarget, '\n// tampered\n');
  const result = await spawnProductionStartupProbe({
    runtimeRoot,
    evidenceDir,
    releaseEvidence,
    readyPattern: /Finance dashboard running on/,
    readyTimeoutMs: 10_000,
  });
  assert.notEqual(result.exitCode, 0);
  assert.match(result.logs, /deployed file does not match manifest: lib\/errors\.js/);
  assert.doesNotMatch(result.logs, /Finance dashboard running on/);
  assert.doesNotMatch(result.logs, /BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY/);
  assert.equal(releaseEvidence.manifestPath, result.releaseEvidence.manifestPath);
});

test('production startup rejects symlink release manifest before listening', async (t) => {
  if (process.platform === 'win32') {
    t.skip('symlink semantics are POSIX-specific');
    return;
  }
  const runtimeRoot = createTempRuntimeCopy();
  const evidenceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-prod-symlink-'));
  t.after(() => {
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
    fs.rmSync(evidenceDir, { recursive: true, force: true });
  });
  const releaseEvidence = provisionProductionReleaseEvidence(evidenceDir, runtimeRoot);
  const symlinkPath = path.join(evidenceDir, 'linked-manifest.json');
  fs.symlinkSync(releaseEvidence.manifestPath, symlinkPath);
  const result = await spawnProductionStartupProbe({
    runtimeRoot,
    evidenceDir,
    releaseEvidence,
    extraEnv: { RELEASE_MANIFEST_PATH: symlinkPath },
    readyPattern: /Finance dashboard running on/,
    readyTimeoutMs: 10_000,
  });
  assert.notEqual(result.exitCode, 0);
  assert.match(result.logs, /symbolic link|readable release manifest/);
  assert.doesNotMatch(result.logs, /Finance dashboard running on/);
});

test('production startup rejects oversized release manifest before listening', async (t) => {
  const runtimeRoot = createTempRuntimeCopy();
  const evidenceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-prod-oversize-'));
  t.after(() => {
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
    fs.rmSync(evidenceDir, { recursive: true, force: true });
  });
  const releaseEvidence = provisionProductionReleaseEvidence(evidenceDir, runtimeRoot);
  fs.writeFileSync(releaseEvidence.manifestPath, Buffer.alloc(4 * 1024 * 1024 + 1, 0x7b), { mode: 0o600 });
  const result = await spawnProductionStartupProbe({
    runtimeRoot,
    evidenceDir,
    releaseEvidence,
    readyPattern: /Finance dashboard running on/,
    readyTimeoutMs: 10_000,
  });
  assert.notEqual(result.exitCode, 0);
  assert.match(result.logs, /size is out of bounds|readable release manifest/);
  assert.doesNotMatch(result.logs, /Finance dashboard running on/);
});

test('production startup rejects tampered runtime executable mode before listening', async (t) => {
  const runtimeRoot = createTempRuntimeCopy();
  const evidenceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-prod-evidence-'));
  t.after(() => {
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
    fs.rmSync(evidenceDir, { recursive: true, force: true });
  });
  const releaseEvidence = provisionProductionReleaseEvidence(evidenceDir, runtimeRoot);
  const tamperTarget = path.join(runtimeRoot, 'lib', 'graceful-shutdown.js');
  fs.chmodSync(tamperTarget, 0o755);
  const result = await spawnProductionStartupProbe({
    runtimeRoot,
    evidenceDir,
    releaseEvidence,
    readyPattern: /Finance dashboard running on/,
    readyTimeoutMs: 10_000,
  });
  assert.notEqual(result.exitCode, 0);
  assert.match(result.logs, /deployed file does not match manifest: lib\/graceful-shutdown\.js/);
  assert.doesNotMatch(result.logs, /Finance dashboard running on/);
});
