'use strict';

const MAX_TRUST_PROXY_HOPS = 3;

function parseTrustProxyHops(raw, fieldName = 'FINANCE_TRUST_PROXY_HOPS') {
  if (raw == null || raw === '') return null;
  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > MAX_TRUST_PROXY_HOPS) {
    throw new Error(`${fieldName} must be an integer from 0 through ${MAX_TRUST_PROXY_HOPS}`);
  }
  return parsed;
}

function loadTrustProxyConfig(env = process.env, { localOrigin = false } = {}) {
  const parsed = parseTrustProxyHops(env.FINANCE_TRUST_PROXY_HOPS);
  if (parsed == null) {
    if (!localOrigin) {
      throw new Error(
        'FINANCE_TRUST_PROXY_HOPS is required for non-loopback deployments '
        + `(set 0 for direct Node exposure or 1 when behind one trusted reverse proxy; max ${MAX_TRUST_PROXY_HOPS})`,
      );
    }
    return Object.freeze({ hops: 0 });
  }
  return Object.freeze({ hops: parsed });
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
  applyExpressTrustProxy,
  loadTrustProxyConfig,
  parseTrustProxyHops,
  rateLimitClientKey,
};
