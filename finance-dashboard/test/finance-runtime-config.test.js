'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const {
  assertProductionRuntimeSafe,
  isRawActualApiAllowed,
  isTestRuntime,
  lintDeploymentEnv,
} = require('../lib/finance-runtime-config');
const {
  expandHomePath,
  main: lintDeploymentEnvFile,
  resolveDeploymentEnvFile,
} = require('../scripts/check-dashboard-deployment-env');
const {
  buildSignatureEnvelope,
  generateSigningMaterial,
  loadSigningKey,
  writeKeyMaterialAtomic,
  writeManifestAndSignatureAtomic,
} = require('../lib/release-signing');
const { sha256Canonical, collectDeployedFiles } = require('../../scripts/release-manifest');
const { DASHBOARD_RUNTIME_FILES } = require('../lib/release-files');

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

function dashboardRoot() {
  return path.resolve(__dirname, '..');
}

function productionEnv(overrides = {}) {
  return {
    FINANCE_RUNTIME_MODE: 'production',
    NODE_ENV: 'production',
    FINANCE_QUERY_CURSOR_SECRET: 'deployment-cursor-secret',
    RELEASE_KEYRING_PATH: '/tmp/df-release-keyring.json',
    ...overrides,
  };
}


async function spawnStartupProbe(env, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-runtime-config-'));
  const preloadPath = path.join(dir, 'demo-ready-preload.js');
  fs.writeFileSync(preloadPath, DEMO_READY_PRELOAD);
  const logs = { value: '' };
  const child = spawn(process.execPath, ['server.js'], {
    cwd: dashboardRoot(),
    env: {
      PATH: process.env.PATH,
      SESSION_SECRET: 'test-session-secret-with-sufficient-length',
      SESSION_DIR: path.join(dir, 'sessions'),
      TEST_DASHBOARD_ROOT: dashboardRoot(),
      NODE_OPTIONS: `--require=${preloadPath}`,
      FINANCE_API_TOKEN: 'test-api-token',
      PORT: '0',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { logs.value += chunk; });
  child.stderr.on('data', (chunk) => { logs.value += chunk; });
  const readyPattern = options.readyPattern || null;
  const result = await new Promise((resolve) => {
    let settled = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGTERM');
      } catch {
        // best-effort
      }
      resolve(payload);
    };
    if (readyPattern) {
      const checkReady = (chunk) => {
        if (readyPattern.test(String(chunk)) || readyPattern.test(logs.value)) {
          finish({ exitCode: 0, logs: logs.value, ready: true });
        }
      };
      child.stdout.on('data', checkReady);
      child.stderr.on('data', checkReady);
    }
    child.once('exit', (exitCode) => finish({ exitCode, logs: logs.value, ready: false }));
    if (options.readyTimeoutMs) {
      setTimeout(
        () => finish({ exitCode: null, logs: logs.value, timedOut: true, ready: false }),
        options.readyTimeoutMs,
      );
    }
  });
  fs.rmSync(dir, { recursive: true, force: true });
  return result;
}

test('production runtime requires RELEASE_KEYRING_PATH', () => {
  assert.throws(
    () => assertProductionRuntimeSafe(productionEnv({ RELEASE_KEYRING_PATH: undefined })),
    /Production runtime requires RELEASE_KEYRING_PATH/,
  );
});

test('deployment env lint flags missing RELEASE_KEYRING_PATH in production', () => {
  assert.throws(
    () => lintDeploymentEnv('FINANCE_RUNTIME_MODE=production\nFINANCE_QUERY_CURSOR_SECRET=deployment-cursor-secret\n'),
    /RELEASE_KEYRING_PATH/,
  );
});

test('production startup rejects unsigned dashboard release manifest', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-runtime-unsigned-'));
  const keyringPath = path.join(dir, 'release-keyring.json');
  fs.writeFileSync(keyringPath, `${JSON.stringify({
    kind: 'darkfinances-release-keyring',
    schemaVersion: 1,
    keys: [],
  }, null, 2)}\n`, { mode: 0o644 });
  const manifestPath = path.join(dashboardRoot(), 'release-manifest.json');
  const priorManifest = fs.existsSync(manifestPath) ? fs.readFileSync(manifestPath, 'utf8') : null;
  fs.writeFileSync(manifestPath, `${JSON.stringify({
    kind: 'darkfinances-release',
    schemaVersion: 2,
    builtAt: '2026-02-02T00:00:00.000Z',
    content: { mode: 'dashboard' },
    contentDigest: { algorithm: 'sha256', canonicalization: 'darkfinances-canonical-json-v1', value: 'c'.repeat(64) },
    display: { repository: { commitShort: '1234567', branch: null } },
  }, null, 2)}\n`, { mode: 0o600 });
  try {
    const { exitCode, logs } = await spawnStartupProbe(productionEnv({
      RELEASE_KEYRING_PATH: keyringPath,
      RELEASE_MANIFEST_PATH: manifestPath,
      PUBLIC_ORIGIN: 'http://127.0.0.1:0',
    }));
    assert.notEqual(exitCode, 0);
    assert.match(logs, /signature|release manifest|keyring|repository identity/i);
    assert.doesNotMatch(logs, /Finance dashboard running on/);
  } finally {
    if (priorManifest == null) fs.rmSync(manifestPath, { force: true });
    else fs.writeFileSync(manifestPath, priorManifest);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('production startup accepts signed dashboard release manifest with keyring', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-runtime-signed-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const keyringPath = path.join(dir, 'release-keyring.json');
  const manifestPath = path.join(dir, 'release-manifest.json');
  const content = {
    mode: 'dashboard',
    repository: {
      commit: '1234567890abcdef1234567890abcdef12345678',
      dirty: false,
      source: {
        algorithm: 'sha256',
        digest: 'a'.repeat(64),
        state: 'clean',
        trackedDirty: false,
        untrackedSource: false,
      },
    },
    lockfile: { path: 'package-lock.json', sha256: 'b'.repeat(64) },
    actual: { serverImage: '26.7.0', dashboardApi: '26.7.0', toolsApi: '26.7.0' },
    contract: { fingerprint: 'e92dd64e2bba333f' },
    app: {
      variant: 'full',
      releaseProfile: 'production',
      version: '2.0.0',
      runtimeVersion: '2.0.0',
      updateChannel: 'production',
      iosBuildNumber: '5',
    },
    deployedFiles: collectDeployedFiles(dashboardRoot(), [...DASHBOARD_RUNTIME_FILES]),
  };
  const manifest = {
    kind: 'darkfinances-release',
    schemaVersion: 2,
    builtAt: '2026-02-02T00:00:00.000Z',
    content,
    contentDigest: {
      algorithm: 'sha256',
      canonicalization: 'darkfinances-canonical-json-v1',
      value: sha256Canonical(content),
    },
    display: { repository: { commitShort: '1234567', branch: null } },
  };
  const keysDir = path.join(dir, 'keys');
  const material = generateSigningMaterial({
    notBefore: '2020-01-01T00:00:00.000Z',
    notAfter: '2099-01-01T00:00:00.000Z',
  });
  const paths = writeKeyMaterialAtomic(keysDir, material);
  fs.copyFileSync(paths.keyringPath, keyringPath);
  fs.chmodSync(keyringPath, 0o644);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  const signingKey = loadSigningKey(paths.signingPath);
  writeManifestAndSignatureAtomic(
    manifestPath,
    manifest,
    buildSignatureEnvelope(manifest, {
      keyId: signingKey.keyId,
      privateKey: signingKey.privateKey,
      signedAt: manifest.builtAt,
    }),
  );
  const { exitCode, logs, ready } = await spawnStartupProbe(productionEnv({
    RELEASE_KEYRING_PATH: keyringPath,
    RELEASE_MANIFEST_PATH: manifestPath,
    PUBLIC_ORIGIN: 'http://127.0.0.1:0',
  }), {
    readyPattern: /Finance dashboard running on/,
    readyTimeoutMs: 15000,
  });
  assert.equal(ready, true, logs);
  assert.match(logs, /Finance dashboard running on/);
});

test('production runtime mode with raw flag fails startup assertion', () => {
  assert.throws(
    () => assertProductionRuntimeSafe(productionEnv({ ALLOW_RAW_ACTUAL_API: '1' })),
    /Production runtime rejects test-only configuration flags/,
  );
});

test('NODE_ENV production with raw flag fails startup assertion', () => {
  assert.throws(
    () => assertProductionRuntimeSafe({
      NODE_ENV: 'production',
      FINANCE_QUERY_CURSOR_SECRET: 'deployment-cursor-secret',
      ALLOW_RAW_ACTUAL_API: '1',
    }),
    /Production runtime rejects test-only configuration flags/,
  );
});

test('production dominates conflicting FINANCE_RUNTIME_MODE=test', () => {
  assert.throws(
    () => assertProductionRuntimeSafe(productionEnv({ FINANCE_RUNTIME_MODE: 'test' })),
    /Production runtime rejects conflicting test runtime configuration/,
  );
  assert.equal(isTestRuntime(productionEnv({ FINANCE_RUNTIME_MODE: 'test' })), false);
  assert.equal(isRawActualApiAllowed(productionEnv({
    FINANCE_RUNTIME_MODE: 'test',
    ALLOW_RAW_ACTUAL_API: '1',
  })), false);
});

test('production dominates conflicting NODE_ENV=test', () => {
  assert.throws(
    () => assertProductionRuntimeSafe({
      FINANCE_RUNTIME_MODE: 'production',
      NODE_ENV: 'test',
      FINANCE_QUERY_CURSOR_SECRET: 'deployment-cursor-secret',
    }),
    /Production runtime rejects conflicting test runtime configuration/,
  );
  assert.equal(isTestRuntime({
    FINANCE_RUNTIME_MODE: 'production',
    NODE_ENV: 'test',
  }), false);
});

test('test runtime mode with raw flag allows getter bypass', () => {
  assert.equal(isRawActualApiAllowed({
    NODE_ENV: 'test',
    ALLOW_RAW_ACTUAL_API: '1',
  }), true);
  assert.equal(isRawActualApiAllowed({
    FINANCE_RUNTIME_MODE: 'test',
    ALLOW_RAW_ACTUAL_API: '1',
  }), true);
});

test('production without raw flag passes startup assertion but getter remains blocked', () => {
  assert.doesNotThrow(() => assertProductionRuntimeSafe(productionEnv()));
  assert.equal(isRawActualApiAllowed(productionEnv({ ALLOW_RAW_ACTUAL_API: '1' })), false);

  const dataPath = path.join(dashboardRoot(), 'dataModule.js');
  const saved = {
    FINANCE_RUNTIME_MODE: process.env.FINANCE_RUNTIME_MODE,
    NODE_ENV: process.env.NODE_ENV,
    ALLOW_RAW_ACTUAL_API: process.env.ALLOW_RAW_ACTUAL_API,
    FINANCE_QUERY_CURSOR_SECRET: process.env.FINANCE_QUERY_CURSOR_SECRET,
  };
  Object.assign(process.env, productionEnv({ ALLOW_RAW_ACTUAL_API: '1' }));
  delete require.cache[dataPath];
  const data = require('../dataModule');
  assert.throws(() => data.api, /Direct data\.api access bypasses/);
  delete require.cache[dataPath];
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('production startup with raw flag exits before serving', async () => {
  const { exitCode, logs } = await spawnStartupProbe(productionEnv({
    ALLOW_RAW_ACTUAL_API: '1',
    PUBLIC_ORIGIN: 'http://127.0.0.1:0',
  }));
  assert.notEqual(exitCode, 0);
  assert.match(logs, /Production runtime rejects test-only configuration flags/);
  assert.doesNotMatch(logs, /Finance dashboard running on/);
  assert.doesNotMatch(logs, /require\('express'\)/);
});

test('production startup without cursor signing exits before imports', async () => {
  const { exitCode, logs } = await spawnStartupProbe({
    FINANCE_RUNTIME_MODE: 'production',
    NODE_ENV: 'production',
    PUBLIC_ORIGIN: 'http://127.0.0.1:0',
  });
  assert.notEqual(exitCode, 0);
  assert.match(logs, /Production runtime requires explicit query cursor signing/);
  assert.doesNotMatch(logs, /Finance dashboard running on/);
});

test('deployment env lint rejects test-only raw bypass flags without echoing values', () => {
  assert.throws(
    () => lintDeploymentEnv('ALLOW_RAW_ACTUAL_API=1\n'),
    /Production runtime rejects test-only configuration flags/,
  );
  assert.throws(
    () => lintDeploymentEnv('NODE_ENV=test\n'),
    /Production runtime rejects conflicting test runtime configuration/,
  );
  assert.throws(
    () => lintDeploymentEnv('FINANCE_RUNTIME_MODE=test\n'),
    /Production runtime rejects conflicting test runtime configuration/,
  );
  assert.throws(
    () => lintDeploymentEnv('FINANCE_RUNTIME_MODE=production\nNODE_ENV=test\n'),
    /Production runtime rejects conflicting test runtime configuration/,
  );
  assert.doesNotThrow(() => lintDeploymentEnv(
    '# production env\nFINANCE_RUNTIME_MODE=production\nACTUAL_SYNC_ID=00000000-0000-0000-0000-000000000001\nRELEASE_KEYRING_PATH=/secure/release-keyring.json\nFINANCE_QUERY_CURSOR_SECRET=deployment-cursor-secret\n',
  ));
});

test('deployment env lint script expands ~ using injected HOME', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-home-'));
  const envDir = path.join(homeDir, '.openclaw');
  fs.mkdirSync(envDir, { recursive: true });
  const envFile = path.join(envDir, 'finance-dashboard.env');
  fs.writeFileSync(envFile, 'FINANCE_RUNTIME_MODE=production\nACTUAL_SYNC_ID=00000000-0000-0000-0000-000000000001\nRELEASE_KEYRING_PATH=/secure/release-keyring.json\nFINANCE_QUERY_CURSOR_SECRET=deployment-cursor-secret\n');
  assert.equal(
    resolveDeploymentEnvFile(['node', 'script', '--file=~/.openclaw/finance-dashboard.env'], { HOME: homeDir }),
    envFile,
  );
  assert.equal(expandHomePath('~/.openclaw/finance-dashboard.env', homeDir), envFile);
  const stdout = [];
  const stderr = [];
  const originalStdout = process.stdout.write.bind(process.stdout);
  const originalStderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk) => { stdout.push(String(chunk)); return true; };
  process.stderr.write = (chunk) => { stderr.push(String(chunk)); return true; };
  try {
    lintDeploymentEnvFile({
      argv: ['node', 'script', '--file=~/.openclaw/finance-dashboard.env'],
      env: { HOME: homeDir },
    });
  } finally {
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
  }
  assert.match(stdout.join(''), /dashboard-deployment-env: ok/);
  assert.equal(stderr.join(''), '');
  fs.rmSync(homeDir, { recursive: true, force: true });
});

test('production rejects test-only SELFTEST and query-scaling probe env', () => {
  assert.throws(
    () => assertProductionRuntimeSafe(productionEnv({ SELFTEST: '1' })),
    /Production runtime rejects test-only configuration flags/,
  );
  assert.throws(
    () => assertProductionRuntimeSafe(productionEnv({ FINANCE_QUERY_TEST_BARRIER_DIR: '/tmp/barrier' })),
    /Production runtime rejects test-only configuration flags/,
  );
});
