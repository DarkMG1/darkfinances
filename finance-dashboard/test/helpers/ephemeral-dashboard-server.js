'use strict';

const { pollBackoff } = require('./test-sync-barriers');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const {
  stripProductionUnsafeEnv,
  isProductionCursorSigningConfigured,
} = require('../../lib/finance-runtime-config');
const { DASHBOARD_RUNTIME_FILES } = require('../../lib/release-files');

function copyDashboardRuntimeFixture(sourceRoot, targetRoot) {
  for (const relative of DASHBOARD_RUNTIME_FILES) {
    const source = path.join(sourceRoot, relative);
    const target = path.join(targetRoot, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
    fs.chmodSync(target, fs.statSync(source).mode);
  }
  const nodeModulesSource = fs.existsSync(path.join(sourceRoot, 'node_modules'))
    ? path.join(sourceRoot, 'node_modules')
    : path.join(sourceRoot, '..', 'node_modules');
  const nodeModulesLink = path.join(targetRoot, 'node_modules');
  if (!fs.existsSync(nodeModulesLink)) {
    fs.symlinkSync(nodeModulesSource, nodeModulesLink);
  }
  return targetRoot;
}

function provisionProductionReleaseEvidence(dir, runtimeRoot = dashboardRoot()) {
  const {
    buildSignatureEnvelope,
    generateSigningMaterial,
    loadSigningKey,
    writeKeyMaterialAtomic,
    writeManifestAndSignatureAtomic,
  } = require('../../lib/release-signing');
  const { collectDeployedFiles, sha256Canonical } = require('../../../scripts/release-manifest');
  const root = path.resolve(runtimeRoot);
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
    deployedFiles: collectDeployedFiles(root, [...DASHBOARD_RUNTIME_FILES]),
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
  const material = generateSigningMaterial({
    notBefore: '2020-01-01T00:00:00.000Z',
    notAfter: '2099-01-01T00:00:00.000Z',
  });
  const paths = writeKeyMaterialAtomic(path.join(dir, 'release-signing-keys'), material);
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
  return { keyringPath, manifestPath, runtimeRoot: root };
}

const READY_RE = /^FINANCE_TEST_SERVER_READY (\d+) ([0-9a-f]+)$/;
const FINANCE_API_TOKEN = 'test-api-token';

const RESERVED_ENV_KEYS = new Set([
  'NODE_ENV',
  'PORT',
  'TEST_SERVER_INSTANCE_ID',
  'FINANCE_API_TOKEN',
  'TEST_DASHBOARD_ROOT',
  'NODE_OPTIONS',
  'DEMO_ONLY',
]);

const TRUST_SEMANTICS_ENV_KEYS = Object.freeze([
  'FINANCE_TRUST_PROXY_HOPS',
  'PUBLIC_ORIGIN',
  'WEBAUTHN_ORIGIN',
  'WEBAUTHN_RP_ID',
]);

function parentEnvWithoutTrustSemantics(parentEnv = process.env) {
  const env = { ...parentEnv };
  for (const key of TRUST_SEMANTICS_ENV_KEYS) delete env[key];
  return env;
}

function finalizeTrustProxyHopsEnv(env, extraEnv = {}) {
  if (!Object.prototype.hasOwnProperty.call(extraEnv, 'FINANCE_TRUST_PROXY_HOPS')) {
    delete env.FINANCE_TRUST_PROXY_HOPS;
  }
  return env;
}

function dashboardRoot() {
  return path.resolve(__dirname, '..', '..');
}

function validateExtraEnv(extraEnv, label = 'extraEnv') {
  if (!extraEnv || typeof extraEnv !== 'object') return;
  const conflicts = Object.keys(extraEnv).filter((key) => RESERVED_ENV_KEYS.has(key));
  if (conflicts.length > 0) {
    throw new Error(`${label} cannot override reserved server identity keys: ${conflicts.sort().join(', ')}`);
  }
}

function provisionTestReleaseEvidence(dir, runtimeRoot = dashboardRoot()) {
  return provisionProductionReleaseEvidence(dir);
}

function buildDashboardServerEnv({
  dir,
  instanceId,
  preloadPath = null,
  parentEnv = process.env,
  extraEnv = {},
  demoOnly = true,
  nodeEnv = 'test',
  port = '0',
  runtimeRoot = null,
} = {}) {
  validateExtraEnv(extraEnv);
  const root = runtimeRoot || dashboardRoot();
  const nodeOptions = preloadPath
    ? `${parentEnv.NODE_OPTIONS || ''} --require=${preloadPath}`.trim()
    : (parentEnv.NODE_OPTIONS || '').trim();
  const defaults = {
    SESSION_SECRET: 'test-session-secret-with-sufficient-length',
    SESSION_DIR: path.join(dir, 'sessions'),
    OPERATION_JOURNAL_PATH: path.join(dir, 'operation-journal.json'),
    BULK_OPERATION_SAGAS_PATH: path.join(dir, 'bulk-operation-sagas.json'),
    PASSKEY_CREDENTIALS_FILE: path.join(dir, 'credentials.json'),
    RECEIPTS_PATH: path.join(dir, 'receipts.json'),
    RECEIPTS_DIR: path.join(dir, 'receipt-images'),
    TEST_DASHBOARD_ROOT: root,
    TEST_EFFECT_MARKER: path.join(dir, 'effects.log'),
    TEST_MARKER: path.join(dir, 'marker.log'),
    PUBLIC_ORIGIN: 'http://127.0.0.1:0',
    WEBAUTHN_ORIGIN: 'http://127.0.0.1:0',
    WEBAUTHN_RP_ID: 'localhost',
  };
  const env = finalizeTrustProxyHopsEnv({
    ...parentEnvWithoutTrustSemantics(parentEnv),
    ...defaults,
    ...extraEnv,
    ...(nodeOptions ? { NODE_OPTIONS: nodeOptions } : {}),
    NODE_ENV: nodeEnv,
    DEMO_ONLY: demoOnly ? '1' : '0',
    PORT: String(port),
    TEST_SERVER_INSTANCE_ID: instanceId,
    FINANCE_API_TOKEN,
  }, extraEnv);
  if (nodeEnv === 'production') {
    const pinned = {
      ...stripProductionUnsafeEnv(env),
      NODE_ENV: 'production',
      FINANCE_RUNTIME_MODE: 'production',
    };
    const hasExplicitCursorEnv = Object.prototype.hasOwnProperty.call(env, 'FINANCE_QUERY_CURSOR_SECRET')
      || Object.prototype.hasOwnProperty.call(env, 'ACTUAL_SYNC_ID');
    if (!hasExplicitCursorEnv && !isProductionCursorSigningConfigured(pinned)) {
      pinned.FINANCE_QUERY_CURSOR_SECRET = 'ephemeral-production-probe-cursor-secret';
    }
    const hasReleaseEvidence = env.RELEASE_KEYRING_PATH && env.RELEASE_MANIFEST_PATH;
    if (hasReleaseEvidence) {
      pinned.RELEASE_KEYRING_PATH = env.RELEASE_KEYRING_PATH;
      pinned.RELEASE_MANIFEST_PATH = env.RELEASE_MANIFEST_PATH;
    } else {
      const releaseEvidence = provisionProductionReleaseEvidence(dir, root);
      pinned.RELEASE_KEYRING_PATH = releaseEvidence.keyringPath;
      pinned.RELEASE_MANIFEST_PATH = releaseEvidence.manifestPath;
    }
    return pinned;
  }
  return env;
}

function attachChildLogHandlers(child, logs, state = {}) {
  child.stdout.on('data', (chunk) => { logs.value += chunk; });
  child.stderr.on('data', (chunk) => { logs.value += chunk; });
  child.on('error', (error) => {
    state.spawnError = error;
    logs.value += `\n[spawn error] ${error.stack || error.message}\n`;
  });
  child.on('exit', () => {
    state.exited = true;
  });
  return state;
}

function waitForChildExit(child, timeoutMs = 10_000) {
  if (child.exitCode != null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (child.exitCode == null) {
        try { child.kill('SIGKILL'); } catch (_) {}
      }
      reject(new Error(`server child did not exit within ${timeoutMs}ms (signal=${child.signalCode ?? 'none'})`));
    }, timeoutMs);
    timer.unref?.();
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

function parseReadyLine(logs, instanceId) {
  for (const line of logs.split('\n')) {
    const match = READY_RE.exec(line.trim());
    if (match && match[2] === instanceId) {
      return { port: Number(match[1], 10), instanceId: match[2] };
    }
  }
  return null;
}

function pingTestInstanceId(body) {
  return body?.data?.testInstanceId ?? body?.testInstanceId ?? null;
}

function readinessTimeoutError(logs, instanceId, child, spawnError, timeoutMs) {
  return new Error([
    `server did not become ready within ${timeoutMs}ms`,
    `instanceId=${instanceId}`,
    `exitCode=${child.exitCode}`,
    `signal=${child.signalCode ?? 'none'}`,
    spawnError ? `spawnError=${spawnError.message}` : null,
    `logs=${logs.value}`,
  ].filter(Boolean).join('\n'));
}

async function waitForEphemeralServer(child, logs, instanceId, {
  timeoutMs = 30_000,
  spawnError = null,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (spawnError) {
      throw readinessTimeoutError(logs, instanceId, child, spawnError, timeoutMs);
    }
    if (child.signalCode != null) {
      throw new Error(`server terminated early (signal=${child.signalCode}, code=${child.exitCode}): ${logs.value}`);
    }
    if (child.exitCode != null) {
      throw new Error(`server exited early (code=${child.exitCode}, signal=${child.signalCode ?? 'none'}): ${logs.value}`);
    }
    const ready = parseReadyLine(logs.value, instanceId);
    if (ready) {
      const base = `http://127.0.0.1:${ready.port}`;
      try {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) break;
        const response = await fetch(`${base}/api/v1/ping`, {
          headers: { 'X-Finance-Token': FINANCE_API_TOKEN },
          signal: AbortSignal.timeout(Math.min(10_000, remainingMs)),
        });
        const body = await response.json();
        if (pingTestInstanceId(body) === instanceId) {
          return { base, port: ready.port };
        }
      } catch (_) {}
    }
    await pollBackoff();
  }
  throw readinessTimeoutError(logs, instanceId, child, spawnError, timeoutMs);
}

function registerEphemeralServerCleanup(t, { child, dir }) {
  t.after(async () => {
    if (child.exitCode == null) {
      child.kill('SIGTERM');
    }
    try {
      await waitForChildExit(child);
    } catch (_) {
      try { child.kill('SIGKILL'); } catch (_) {}
      await waitForChildExit(child, 2_000).catch(() => {});
    }
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

function spawnEphemeralDashboardServer({
  preloadBody = null,
  preloadPath = null,
  preloadFileName = 'mock-data-module.js',
  extraEnv = {},
  extraEnvForDir = null,
  prepareDir = null,
  instanceId = crypto.randomBytes(16).toString('hex'),
  tempPrefix = 'darkfinances-ephemeral-server-',
  demoOnly = true,
  nodeEnv = 'test',
  dir: existingDir = null,
} = {}) {
  const dir = existingDir || fs.mkdtempSync(path.join(os.tmpdir(), tempPrefix));
  if (prepareDir) prepareDir(dir);
  const dirExtra = extraEnvForDir ? extraEnvForDir(dir) : {};
  validateExtraEnv(dirExtra, 'extraEnvForDir');
  const preload = preloadPath || path.join(dir, preloadFileName);
  if (preloadBody) fs.writeFileSync(preload, preloadBody);
  const logs = { value: '' };
  const childState = {};
  const child = spawn(process.execPath, ['server.js'], {
    cwd: dashboardRoot(),
    env: buildDashboardServerEnv({
      dir,
      instanceId,
      preloadPath: preloadBody || preloadPath ? preload : null,
      extraEnv: { ...extraEnv, ...dirExtra },
      demoOnly,
      nodeEnv,
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  attachChildLogHandlers(child, logs, childState);
  return {
    child,
    logs,
    dir,
    instanceId,
    dashboardRoot: dashboardRoot(),
    childState,
    preloadPath: preloadBody || preloadPath ? preload : null,
    markerPath: path.join(dir, 'marker.log'),
    effectMarkerPath: path.join(dir, 'effects.log'),
  };
}

async function startEphemeralDashboardServer(t, options = {}) {
  const {
    awaitReady = true,
    registerCleanup = true,
    ...spawnOptions
  } = options;
  const spawned = spawnEphemeralDashboardServer(spawnOptions);
  if (t && registerCleanup) {
    registerEphemeralServerCleanup(t, { child: spawned.child, dir: spawned.dir });
  }
  if (!awaitReady) {
    return { ...spawned, base: null, port: null };
  }
  const { base, port } = await waitForEphemeralServer(
    spawned.child,
    spawned.logs,
    spawned.instanceId,
    { spawnError: spawned.childState.spawnError },
  );
  return { ...spawned, base, port };
}

module.exports = {
  FINANCE_API_TOKEN,
  RESERVED_ENV_KEYS,
  TRUST_SEMANTICS_ENV_KEYS,
  attachChildLogHandlers,
  buildDashboardServerEnv,
  dashboardRoot,
  finalizeTrustProxyHopsEnv,
  parentEnvWithoutTrustSemantics,
  parseReadyLine,
  pingTestInstanceId,
  copyDashboardRuntimeFixture,
  provisionProductionReleaseEvidence,
  provisionTestReleaseEvidence,
  registerEphemeralServerCleanup,
  spawnEphemeralDashboardServer,
  startEphemeralDashboardServer,
  validateExtraEnv,
  waitForChildExit,
  waitForEphemeralServer,
};
