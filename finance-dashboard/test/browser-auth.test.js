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

async function request(base, pathname, options = {}) {
  const response = await fetch(`${base}${pathname}`, options);
  const text = await response.text();
  return { response, body: text };
}

function sessionIdFromSetCookie(setCookieHeader) {
  const raw = String(setCookieHeader || '').split(';')[0];
  const encodedValue = raw.includes('=') ? raw.slice(raw.indexOf('=') + 1) : '';
  const decodedValue = decodeURIComponent(encodedValue);
  const match = decodedValue.match(/^s:([^.]+)/);
  return match ? match[1] : null;
}

async function patchSessionAuthenticated(sessionDir, setCookieHeader) {
  const sessionId = sessionIdFromSetCookie(setCookieHeader);
  assert.ok(sessionId, 'expected connect.sid cookie');
  const sessionPath = path.join(sessionDir, `${sessionId}.json`);
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(sessionPath)) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(fs.existsSync(sessionPath), `session file missing: ${sessionPath}`);
  const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  session.authenticated = true;
  fs.writeFileSync(sessionPath, JSON.stringify(session));
}

function spawnTestServer(t) {
  const portPromise = unusedPort();
  return portPromise.then((port) => {
    const base = `http://127.0.0.1:${port}`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-browser-auth-'));
    const code = 'test-enrollment-code';
    const logs = { value: '' };
    const child = spawn(process.execPath, ['server.js'], {
      cwd: path.resolve(__dirname, '..'),
      env: {
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
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => { logs.value += chunk; });
    child.stderr.on('data', (chunk) => { logs.value += chunk; });
    t.after(() => {
      child.kill('SIGTERM');
      fs.rmSync(dir, { recursive: true, force: true });
    });
    return waitForServer(base, child, logs).then(() => ({
      base,
      dir,
      code,
      child,
      logs,
    }));
  });
}

test('dashboard HTML requires session while demo static assets stay public', async (t) => {
  const { base, dir, code } = await spawnTestServer(t);

  const protectedPaths = ['/', '/index.html'];
  for (const pathname of protectedPaths) {
    const result = await request(base, pathname, { redirect: 'manual' });
    assert.equal(result.response.status, 302, pathname);
    assert.equal(result.response.headers.get('location'), '/login', pathname);
  }

  const publicPaths = [
    '/demo',
    '/login',
    '/login.html',
    '/js/app.js',
    '/css/dashboard.css',
    '/css/login.css',
    '/vendor/chart.umd.js',
    '/vendor/chart-js.manifest.json',
    '/browser-manifest.json',
  ];
  for (const pathname of publicPaths) {
    const result = await request(base, pathname, { redirect: 'manual' });
    assert.equal(result.response.status, 200, pathname);
  }

  const enroll = await request(base, '/auth/enroll/authorize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  assert.equal(enroll.response.status, 200);
  const cookie = enroll.response.headers.get('set-cookie').split(';')[0];
  await patchSessionAuthenticated(path.join(dir, 'sessions'), enroll.response.headers.get('set-cookie'));

  for (const pathname of protectedPaths) {
    const result = await request(base, pathname, {
      redirect: 'manual',
      headers: { Cookie: cookie },
    });
    assert.equal(result.response.status, 200, `authenticated ${pathname}`);
    assert.equal(result.response.headers.get('cache-control'), 'no-store');
    assert.equal(result.response.headers.get('x-content-type-options'), 'nosniff');
  }

  for (const pathname of publicPaths) {
    const result = await request(base, pathname, {
      redirect: 'manual',
      headers: { Cookie: cookie },
    });
    assert.equal(result.response.status, 200, `authenticated ${pathname}`);
  }
});
