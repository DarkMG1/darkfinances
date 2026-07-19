'use strict';

const MAX_TRUST_PROXY_HOPS = 3;
const TRUST_PROXY_HOPS_PATTERN = /^[0-3]$/;

function parseTrustProxyHops(raw, fieldName = 'FINANCE_TRUST_PROXY_HOPS') {
  if (raw == null || raw === '') return null;
  const value = String(raw);
  if (!TRUST_PROXY_HOPS_PATTERN.test(value)) {
    throw new Error(
      `${fieldName} must match ^[0-3]$ exactly (no whitespace, suffix, or alternate radix)`,
    );
  }
  return Number(value);
}

function loadTrustProxyConfig(env = process.env) {
  const raw = env.FINANCE_TRUST_PROXY_HOPS;
  const explicit = raw != null && raw !== '';
  const hops = explicit ? parseTrustProxyHops(raw) : 0;
  return Object.freeze({ hops, explicit });
}

function formatTrustProxyStartupWarning(config, { localOrigin = false } = {}) {
  if (localOrigin || config.hops !== 0) return null;
  const prefix = config.explicit
    ? 'FINANCE_TRUST_PROXY_HOPS=0'
    : 'FINANCE_TRUST_PROXY_HOPS is unset (defaulting to 0)';
  return (
    `${prefix}: rate limits ignore X-Forwarded-For and key on the TCP remote address. `
    + 'Reverse-proxy deployments must set FINANCE_TRUST_PROXY_HOPS=1, keep the trusted proxy as the '
    + 'sole ingress to Node, and configure it to overwrite or append X-Forwarded-For with the real '
    + 'client address so per-client buckets work.'
  );
}

function applyExpressTrustProxy(app, config) {
  if (config.hops > 0) app.set('trust proxy', config.hops);
}

function rateLimitClientKey(req, trustProxyHops) {
  const remoteAddress = req.socket?.remoteAddress || 'unknown';
  if (trustProxyHops > 0) {
    return req.ip || remoteAddress;
  }
  return remoteAddress;
}

module.exports = {
  MAX_TRUST_PROXY_HOPS,
  TRUST_PROXY_HOPS_PATTERN,
  applyExpressTrustProxy,
  formatTrustProxyStartupWarning,
  loadTrustProxyConfig,
  parseTrustProxyHops,
  rateLimitClientKey,
};
