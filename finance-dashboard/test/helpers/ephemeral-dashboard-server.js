'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

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

function buildDashboardServerEnv({
  dir,
  instanceId,
  preloadPath = null,
  parentEnv = process.env,
  extraEnv = {},
  demoOnly = true,
  nodeEnv = 'test',
  port = '0',
} = {}) {
  validateExtraEnv(extraEnv);
  const root = dashboardRoot();
  const nodeOptions = preloadPath
    ? `${parentEnv.NODE_OPTIONS || ''} --require=${preloadPath}`.trim()
    : (parentEnv.NODE_OPTIONS || '').trim();
  const defaults = {
    SESSION_SECRET: 'test-session-secret-with-sufficient-length',
    SESSION_DIR: path.join(dir, 'sessions'),
    OPERATION_JOURNAL_PATH: path.join(dir, 'operation-journal.json'),
    BULK_OPERATION_SAGAS_PATH: path.join(dir, 'bulk-operation-sagas.json'),
    PASSKEY_CREDENTIALS_FILE: path.join(dir, 'credentials.json'),
    TEST_DASHBOARD_ROOT: root,
    TEST_EFFECT_MARKER: path.join(dir, 'effects.log'),
    TEST_MARKER: path.join(dir, 'marker.log'),
    PUBLIC_ORIGIN: 'http://127.0.0.1:0',
    WEBAUTHN_ORIGIN: 'http://127.0.0.1:0',
    WEBAUTHN_RP_ID: 'localhost',
  };
  return {
    ...parentEnv,
    ...defaults,
    ...extraEnv,
    ...(nodeOptions ? { NODE_OPTIONS: nodeOptions } : {}),
    NODE_ENV: nodeEnv,
    DEMO_ONLY: demoOnly ? '1' : '0',
    PORT: String(port),
    TEST_SERVER_INSTANCE_ID: instanceId,
    FINANCE_API_TOKEN,
  };
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
    await new Promise((resolve) => setImmediate(resolve));
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
  attachChildLogHandlers,
  buildDashboardServerEnv,
  dashboardRoot,
  parseReadyLine,
  pingTestInstanceId,
  registerEphemeralServerCleanup,
  spawnEphemeralDashboardServer,
  startEphemeralDashboardServer,
  validateExtraEnv,
  waitForChildExit,
  waitForEphemeralServer,
};
