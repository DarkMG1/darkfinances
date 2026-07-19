'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  loadTrustProxyConfig,
  parseTrustProxyHops,
  rateLimitClientKey,
  MAX_TRUST_PROXY_HOPS,
} = require('../lib/trust-proxy-config');

test('parseTrustProxyHops accepts bounded hop counts and rejects malformed values', () => {
  assert.equal(parseTrustProxyHops('0'), 0);
  assert.equal(parseTrustProxyHops('1'), 1);
  assert.equal(parseTrustProxyHops(String(MAX_TRUST_PROXY_HOPS)), MAX_TRUST_PROXY_HOPS);
  assert.throws(() => parseTrustProxyHops('-1'), /integer from 0 through/);
  assert.throws(() => parseTrustProxyHops('abc'), /integer from 0 through/);
  assert.throws(
    () => parseTrustProxyHops(String(MAX_TRUST_PROXY_HOPS + 1)),
    /integer from 0 through/,
  );
});

test('loadTrustProxyConfig defaults to zero hops on loopback and requires explicit production choice', () => {
  assert.deepEqual(loadTrustProxyConfig({}, { localOrigin: true }), { hops: 0 });
  assert.throws(
    () => loadTrustProxyConfig({}, { localOrigin: false }),
    /FINANCE_TRUST_PROXY_HOPS is required/,
  );
  assert.deepEqual(
    loadTrustProxyConfig({ FINANCE_TRUST_PROXY_HOPS: '1' }, { localOrigin: false }),
    { hops: 1 },
  );
  assert.deepEqual(
    loadTrustProxyConfig({ FINANCE_TRUST_PROXY_HOPS: '0' }, { localOrigin: false }),
    { hops: 0 },
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
