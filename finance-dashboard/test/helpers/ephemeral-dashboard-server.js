'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const READY_RE = /^FINANCE_TEST_SERVER_READY (\d+) ([0-9a-f]+)$/;

function waitForChildExit(child, timeoutMs = 10_000) {
  if (child.exitCode != null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (child.exitCode == null) {
        try { child.kill('SIGKILL'); } catch (_) {}
      }
      reject(new Error(`server child did not exit within ${timeoutMs}ms`));
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

async function waitForEphemeralServer(child, logs, instanceId, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode != null) {
      throw new Error(`server exited early: ${logs.value}`);
    }
    const ready = parseReadyLine(logs.value, instanceId);
    if (ready) {
      const base = `http://127.0.0.1:${ready.port}`;
      try {
        const response = await fetch(`${base}/api/v1/ping`, {
          headers: { 'X-Finance-Token': 'test-api-token' },
        });
        if (response.status !== 200) continue;
        const body = await response.json();
        if (body?.data?.testInstanceId === instanceId) {
          return { base, port: ready.port };
        }
      } catch (_) {}
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`server did not become ready: ${logs.value}`);
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
  preloadBody,
  extraEnv = {},
  instanceId = crypto.randomBytes(16).toString('hex'),
  tempPrefix = 'darkfinances-ephemeral-server-',
} = {}) {
  const dashboardRoot = path.resolve(__dirname, '..', '..');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), tempPrefix));
  const preload = path.join(dir, 'mock-data-module.js');
  if (preloadBody) fs.writeFileSync(preload, preloadBody);
  const logs = { value: '' };
  const nodeOptions = preloadBody
    ? `${process.env.NODE_OPTIONS || ''} --require=${preload}`.trim()
    : (process.env.NODE_OPTIONS || '').trim();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: dashboardRoot,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DEMO_ONLY: '1',
      ...(nodeOptions ? { NODE_OPTIONS: nodeOptions } : {}),
      PORT: '0',
      TEST_SERVER_INSTANCE_ID: instanceId,
      PUBLIC_ORIGIN: 'http://127.0.0.1:0',
      WEBAUTHN_ORIGIN: 'http://127.0.0.1:0',
      WEBAUTHN_RP_ID: 'localhost',
      FINANCE_API_TOKEN: 'test-api-token',
      SESSION_SECRET: 'test-session-secret-with-sufficient-length',
      SESSION_DIR: path.join(dir, 'sessions'),
      OPERATION_JOURNAL_PATH: path.join(dir, 'operation-journal.json'),
      BULK_OPERATION_SAGAS_PATH: path.join(dir, 'bulk-operation-sagas.json'),
      PASSKEY_CREDENTIALS_FILE: path.join(dir, 'credentials.json'),
      TEST_DASHBOARD_ROOT: dashboardRoot,
      TEST_EFFECT_MARKER: path.join(dir, 'effects.log'),
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { logs.value += chunk; });
  child.stderr.on('data', (chunk) => { logs.value += chunk; });
  return { child, logs, dir, instanceId, dashboardRoot };
}

async function startEphemeralDashboardServer(t, options = {}) {
  const spawned = spawnEphemeralDashboardServer(options);
  registerEphemeralServerCleanup(t, { child: spawned.child, dir: spawned.dir });
  const { base, port } = await waitForEphemeralServer(
    spawned.child,
    spawned.logs,
    spawned.instanceId,
  );
  return { ...spawned, base, port };
}

module.exports = {
  spawnEphemeralDashboardServer,
  startEphemeralDashboardServer,
  waitForChildExit,
  waitForEphemeralServer,
  registerEphemeralServerCleanup,
};
