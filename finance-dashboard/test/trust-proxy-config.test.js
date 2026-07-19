'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  loadTrustProxyConfig,
  parseTrustProxyHops,
  formatTrustProxyStartupWarning,
  rateLimitClientKey,
  MAX_TRUST_PROXY_HOPS,
  TRUST_PROXY_HOPS_PATTERN,
} = require('../lib/trust-proxy-config');

test('parseTrustProxyHops accepts exact single-digit hop counts only', () => {
  for (let hops = 0; hops <= MAX_TRUST_PROXY_HOPS; hops += 1) {
    assert.equal(parseTrustProxyHops(String(hops)), hops);
    assert.equal(TRUST_PROXY_HOPS_PATTERN.test(String(hops)), true);
  }
  assert.throws(() => parseTrustProxyHops('-1'), /\^\[0-3\]\$/);
  assert.throws(() => parseTrustProxyHops('abc'), /\^\[0-3\]\$/);
  assert.throws(() => parseTrustProxyHops('10'), /\^\[0-3\]\$/);
  assert.throws(() => parseTrustProxyHops('01'), /\^\[0-3\]\$/);
  assert.throws(() => parseTrustProxyHops('1 '), /\^\[0-3\]\$/);
  assert.throws(() => parseTrustProxyHops(' 1'), /\^\[0-3\]\$/);
  assert.throws(() => parseTrustProxyHops('0x1'), /\^\[0-3\]\$/);
  assert.throws(() => parseTrustProxyHops('1.0'), /\^\[0-3\]\$/);
  assert.throws(() => parseTrustProxyHops('1abc'), /\^\[0-3\]\$/);
});

test('loadTrustProxyConfig defaults absent values to zero hops everywhere', () => {
  assert.deepEqual(loadTrustProxyConfig({}), { hops: 0, explicit: false });
  assert.deepEqual(
    loadTrustProxyConfig({ FINANCE_TRUST_PROXY_HOPS: '1' }),
    { hops: 1, explicit: true },
  );
  assert.deepEqual(
    loadTrustProxyConfig({ FINANCE_TRUST_PROXY_HOPS: '0' }),
    { hops: 0, explicit: true },
  );
});

test('formatTrustProxyStartupWarning advises reverse-proxy deployments when hops stay at zero', () => {
  assert.equal(
    formatTrustProxyStartupWarning({ hops: 0, explicit: false }, { localOrigin: true }),
    null,
  );
  assert.equal(
    formatTrustProxyStartupWarning({ hops: 1, explicit: true }, { localOrigin: false }),
    null,
  );
  assert.match(
    formatTrustProxyStartupWarning({ hops: 0, explicit: false }, { localOrigin: false }),
    /defaulting to 0.*FINANCE_TRUST_PROXY_HOPS=1/s,
  );
  assert.match(
    formatTrustProxyStartupWarning({ hops: 0, explicit: true }, { localOrigin: false }),
    /FINANCE_TRUST_PROXY_HOPS=0.*sole ingress/s,
  );
});

test('rateLimitClientKey ignores spoofed forwarded headers unless trust proxy hops are enabled', () => {
  const req = {
    ip: '203.0.113.50',
    socket: { remoteAddress: '127.0.0.1' },
  };
  assert.equal(rateLimitClientKey(req, 0), '127.0.0.1');
  assert.equal(rateLimitClientKey(req, 1), '203.0.113.50');
});
