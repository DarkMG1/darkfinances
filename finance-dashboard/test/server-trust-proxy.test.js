'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

async function unusedPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
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

async function waitForExit(child, logs, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && child.exitCode == null) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return child.exitCode;
}

function baseServerEnv(port, dir, overrides = {}) {
  const code = 'test-enrollment-code';
  return {
    ...process.env,
    NODE_ENV: 'test',
    PORT: String(port),
    DEMO_ONLY: '1',
    PUBLIC_ORIGIN: `http://localhost:${port}`,
    WEBAUTHN_ORIGIN: `http://localhost:${port}`,
    WEBAUTHN_RP_ID: 'localhost',
    FINANCE_API_TOKEN: 'test-api-token',
    SESSION_SECRET: 'test-session-secret-with-sufficient-length',
    SESSION_DIR: path.join(dir, 'sessions'),
    OPERATION_JOURNAL_PATH: path.join(dir, 'operation-journal.json'),
    PASSKEY_CREDENTIALS_FILE: path.join(dir, 'credentials.json'),
    PASSKEY_ENROLLMENT_TOKEN_HASH: crypto.createHash('sha256').update(code).digest('hex'),
    PASSKEY_ENROLLMENT_EXPIRES_AT: String(Date.now() + 60_000),
    ...overrides,
  };
}

function spawnServer(t, env) {
  const logs = { value: '' };
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { logs.value += chunk; });
  child.stderr.on('data', (chunk) => { logs.value += chunk; });
  t.after(() => {
    if (child.exitCode == null) child.kill('SIGTERM');
  });
  return { child, logs };
}

async function postJson(base, pathname, body, headers = {}) {
  const response = await fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch (_) { parsed = text; }
  return { response, body: parsed };
}

test('direct exposure ignores spoofed X-Forwarded-For for enrollment rate limits', async (t) => {
  const port = await unusedPort();
  const base = `http://127.0.0.1:${port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-trust-proxy-direct-'));
  const { child, logs } = spawnServer(t, baseServerEnv(port, dir, {
    FINANCE_TRUST_PROXY_HOPS: '0',
  }));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await waitForServer(base, child, logs);

  for (let i = 0; i < 10; i += 1) {
    const result = await postJson(base, '/auth/enroll/authorize', { code: 'wrong' }, {
      'X-Forwarded-For': `203.0.113.${i + 1}`,
    });
    assert.equal(result.response.status, 403, `attempt ${i + 1} should count toward the shared bucket`);
  }

  const limited = await postJson(base, '/auth/enroll/authorize', { code: 'wrong' }, {
    'X-Forwarded-For': '203.0.113.99',
  });
  assert.equal(limited.response.status, 429);
  assert.equal(limited.body.error, 'Too many requests');
});

test('trusted proxy hop honors forwarded client IP for enrollment rate limits', async (t) => {
  const port = await unusedPort();
  const base = `http://127.0.0.1:${port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-trust-proxy-enabled-'));
  const { child, logs } = spawnServer(t, baseServerEnv(port, dir, {
    FINANCE_TRUST_PROXY_HOPS: '1',
  }));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await waitForServer(base, child, logs);

  for (let i = 0; i < 10; i += 1) {
    const result = await postJson(base, '/auth/enroll/authorize', { code: 'wrong' }, {
      'X-Forwarded-For': '198.51.100.10',
    });
    assert.equal(result.response.status, 403);
  }
  const sameClientLimited = await postJson(base, '/auth/enroll/authorize', { code: 'wrong' }, {
    'X-Forwarded-For': '198.51.100.10',
  });
  assert.equal(sameClientLimited.response.status, 429);

  const otherClient = await postJson(base, '/auth/enroll/authorize', { code: 'wrong' }, {
    'X-Forwarded-For': '198.51.100.11',
  });
  assert.equal(otherClient.response.status, 403);
});

test('login and demo rate limits share the direct-exposure client key', async (t) => {
  const port = await unusedPort();
  const base = `http://127.0.0.1:${port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-trust-proxy-login-demo-'));
  const creds = [{
    credentialID: 'cred-id',
    credentialPublicKey: Buffer.from('public-key').toString('base64'),
    counter: 0,
    transports: [],
  }];
  fs.writeFileSync(path.join(dir, 'credentials.json'), JSON.stringify(creds));
  const { child, logs } = spawnServer(t, baseServerEnv(port, dir, {
    FINANCE_TRUST_PROXY_HOPS: '0',
  }));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await waitForServer(base, child, logs);

  for (let i = 0; i < 30; i += 1) {
    const result = await postJson(base, '/auth/login/start', {}, {
      'X-Forwarded-For': `203.0.113.${i + 1}`,
    });
    assert.notEqual(result.response.status, 429, `login attempt ${i + 1} should not be limited yet`);
  }
  const loginLimited = await postJson(base, '/auth/login/start', {}, {
    'X-Forwarded-For': '203.0.113.99',
  });
  assert.equal(loginLimited.response.status, 429);

  const demoPort = await unusedPort();
  const demoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-trust-proxy-demo-'));
  const { child: demoChild, logs: demoLogs } = spawnServer(t, baseServerEnv(demoPort, demoDir, {
    FINANCE_TRUST_PROXY_HOPS: '0',
  }));
  t.after(() => fs.rmSync(demoDir, { recursive: true, force: true }));
  const demoBase = `http://127.0.0.1:${demoPort}`;
  await waitForServer(demoBase, demoChild, demoLogs);

  for (let i = 0; i < 240; i += 1) {
    const response = await fetch(`${demoBase}/api/v1/accounts`, {
      headers: {
        'X-Demo-Mode': '1',
        'X-Forwarded-For': `198.51.100.${(i % 200) + 1}`,
      },
    });
    assert.notEqual(response.status, 429, `demo attempt ${i + 1} should not be limited yet`);
  }
  const demoLimited = await fetch(`${demoBase}/api/v1/accounts`, {
    headers: {
      'X-Demo-Mode': '1',
      'X-Forwarded-For': '198.51.100.250',
    },
  });
  assert.equal(demoLimited.status, 429);
});

test('malformed trust proxy config and missing production setting fail startup', async (t) => {
  const cases = [
    {
      name: 'malformed hop count',
      env: {
        FINANCE_TRUST_PROXY_HOPS: 'not-a-number',
        PUBLIC_ORIGIN: 'https://finances.example.test',
        WEBAUTHN_ORIGIN: 'https://finances.example.test',
        WEBAUTHN_RP_ID: 'finances.example.test',
        NODE_ENV: 'production',
      },
      pattern: /FINANCE_TRUST_PROXY_HOPS must be an integer/,
    },
    {
      name: 'hop count above cap',
      env: {
        FINANCE_TRUST_PROXY_HOPS: '99',
        PUBLIC_ORIGIN: 'https://finances.example.test',
        WEBAUTHN_ORIGIN: 'https://finances.example.test',
        WEBAUTHN_RP_ID: 'finances.example.test',
        NODE_ENV: 'production',
      },
      pattern: /FINANCE_TRUST_PROXY_HOPS must be an integer/,
    },
    {
      name: 'missing production setting',
      env: {
        PUBLIC_ORIGIN: 'https://finances.example.test',
        WEBAUTHN_ORIGIN: 'https://finances.example.test',
        WEBAUTHN_RP_ID: 'finances.example.test',
        NODE_ENV: 'production',
      },
      pattern: /FINANCE_TRUST_PROXY_HOPS is required/,
    },
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const port = await unusedPort();
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-trust-proxy-startup-'));
      const logs = { value: '' };
      const child = spawn(process.execPath, ['server.js'], {
        cwd: path.resolve(__dirname, '..'),
        env: {
          ...process.env,
          PORT: String(port),
          FINANCE_API_TOKEN: 'test-api-token',
          SESSION_SECRET: 'test-session-secret-with-sufficient-length',
          SESSION_DIR: path.join(dir, 'sessions'),
          OPERATION_JOURNAL_PATH: path.join(dir, 'operation-journal.json'),
          PASSKEY_CREDENTIALS_FILE: path.join(dir, 'credentials.json'),
          PASSKEY_ENROLLMENT_TOKEN_HASH: crypto.createHash('sha256').update('closed').digest('hex'),
          PASSKEY_ENROLLMENT_EXPIRES_AT: String(Date.now() + 60_000),
          FINANCE_QUERY_CURSOR_SECRET: 'test-cursor-secret-with-sufficient-length',
          ...testCase.env,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.on('data', (chunk) => { logs.value += chunk; });
      child.stderr.on('data', (chunk) => { logs.value += chunk; });
      t.after(() => {
        if (child.exitCode == null) child.kill('SIGTERM');
        fs.rmSync(dir, { recursive: true, force: true });
      });

      const exitCode = await waitForExit(child, logs);
      assert.notEqual(exitCode, 0);
      assert.match(logs.value, testCase.pattern);
    });
  }
});
