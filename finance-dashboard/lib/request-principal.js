'use strict';

const crypto = require('crypto');

function timingSafeTokenEqual(presented, expected) {
  if (!presented || !expected) return false;
  const a = Buffer.from(String(presented));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requestClaimsDemo(req) {
  return req.get('X-Demo-Mode') === '1' || req.query.demo === '1' || req.query.demo === 'true';
}

function deriveRequestPrincipal(req, {
  apiToken = process.env.FINANCE_API_TOKEN || '',
  selftest = process.env.SELFTEST === '1',
} = {}) {
  if (selftest) return 'selftest';
  if (requestClaimsDemo(req)) return 'demo';
  if (req.session?.authenticated) {
    const sessionId = typeof req.sessionID === 'string' && req.sessionID ? req.sessionID : 'unknown';
    return `session:${sessionId}`;
  }
  const headerTok = req.get('X-Finance-Token')
    || (req.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (timingSafeTokenEqual(headerTok, apiToken) && apiToken) return 'token:api';
  return 'anonymous';
}

module.exports = {
  deriveRequestPrincipal,
  requestClaimsDemo,
  timingSafeTokenEqual,
};
