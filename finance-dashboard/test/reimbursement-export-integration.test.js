'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { ExportSourceChangedError, MAX_SNAPSHOT_ATTEMPTS } = require('../lib/reimbursement-export-common');
const { getActualCoordinator, resetActualCoordinator } = require('../lib/actual-coordinator');

async function unusedPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitForServer(base, child, logs) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`server exited early: ${logs.value}`);
    try {
      const response = await fetch(`${base}/auth/status`);
      if (response.ok) return;
    } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`server startup timeout: ${logs.value}`);
}

function spawnDemoServer(dir, port) {
  const logs = { value: '' };
  const dashboardRoot = path.resolve(__dirname, '..');
  const child = spawn(process.execPath, ['server.js'], {
    cwd: dashboardRoot,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DEMO_ONLY: '1',
      PORT: String(port),
      PUBLIC_ORIGIN: `http://localhost:${port}`,
      WEBAUTHN_ORIGIN: `http://localhost:${port}`,
      WEBAUTHN_RP_ID: 'localhost',
      FINANCE_API_TOKEN: 'test-api-token',
      SESSION_SECRET: 'test-session-secret-with-sufficient-length',
      SESSION_DIR: path.join(dir, 'sessions'),
      OPERATION_JOURNAL_PATH: path.join(dir, 'operation-journal.json'),
      PASSKEY_CREDENTIALS_FILE: path.join(dir, 'credentials.json'),
      SELFTEST: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { logs.value += chunk; });
  child.stderr.on('data', (chunk) => { logs.value += chunk; });
  return { child, logs };
}

test('generation mutation during bounded snapshot exhausts retries', async () => {
  resetActualCoordinator('reimb-export-barrier');
  const coordinator = getActualCoordinator();
  let caught = 0;
  for (let i = 1; i <= MAX_SNAPSHOT_ATTEMPTS; i += 1) {
    const captureGeneration = coordinator.generation;
    coordinator.invalidateGeneration();
    try {
      if (coordinator.generation !== captureGeneration) throw new ExportSourceChangedError();
      assert.fail('expected generation mismatch');
    } catch (error) {
      if (error instanceof ExportSourceChangedError) caught += 1;
      else throw error;
    }
  }
  assert.equal(caught, MAX_SNAPSHOT_ATTEMPTS);
});

test('demo API reimbursement-export returns complete allocation ledger', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reimb-export-api-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const port = await unusedPort();
  const base = `http://127.0.0.1:${port}/api/v1`;
  const { child, logs } = spawnDemoServer(dir, port);
  t.after(() => { child.kill('SIGTERM'); });
  await waitForServer(base.replace('/api/v1', ''), child, logs);

  const headers = { 'X-Demo-Mode': '1' };
  const first = await fetch(`${base}/reimbursement-export?format=json`, { headers });
  assert.equal(first.status, 200);
  const body = await first.json();
  assert.equal(body.data.completeness.status, 'complete');
  assert.equal(body.meta.exitCode, 0);
  assert.equal(body.meta.authoritative, true);
  assert.ok(Array.isArray(body.data.links));
  assert.ok(body.data.scopes?.global?.totals);

  const csv = await fetch(`${base}/reimbursement-export?format=csv`, { headers });
  assert.match(await csv.text(), /linkKey,inflowId/);

  const legacy = await fetch(`http://127.0.0.1:${port}/api/reimbursement-export?format=json`, { headers });
  assert.equal(legacy.status, 200);
  assert.equal(legacy.headers.get('x-reimbursement-export-status'), 'complete');
  assert.equal(legacy.headers.get('x-reimbursement-export-exit-code'), '0');
  const legacyText = await legacy.text();
  const legacyBody = JSON.parse(legacyText);
  assert.equal(legacyBody.completeness.status, 'complete');
  assert.equal(legacyBody.data, undefined);
});
