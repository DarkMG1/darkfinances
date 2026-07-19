const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { startEphemeralDashboardServer } = require('./helpers/ephemeral-dashboard-server');
const { pollBackoff } = require('./helpers/test-sync-barriers');

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
    await pollBackoff();
  }
  assert.ok(fs.existsSync(sessionPath), `session file missing: ${sessionPath}`);
  const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  session.authenticated = true;
  fs.writeFileSync(sessionPath, JSON.stringify(session));
}

async function spawnTestServer(t) {
  const code = 'test-enrollment-code';
  const started = await startEphemeralDashboardServer(t, {
    tempPrefix: 'darkfinances-browser-auth-',
    extraEnvForDir: () => ({
      PASSKEY_ENROLLMENT_TOKEN_HASH: crypto.createHash('sha256').update(code).digest('hex'),
      PASSKEY_ENROLLMENT_EXPIRES_AT: String(Date.now() + 60_000),
    }),
  });
  return { ...started, code };
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
