'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REPOSITORY_ROOT = path.resolve(__dirname, '..', '..');

function readRepo(relativePath) {
  return fs.readFileSync(path.join(REPOSITORY_ROOT, relativePath), 'utf8');
}

test('ops runbook and env example document FINANCE_TRUST_PROXY_HOPS for reverse-proxy deployments', () => {
  const envExample = readRepo('finance-dashboard/.env.example');
  const opsReadme = readRepo('ops/README.md');
  const releaseDoc = readRepo('docs/RELEASE.md');
  const dashboardReadme = readRepo('finance-dashboard/README.md');

  for (const source of [envExample, opsReadme, releaseDoc, dashboardReadme]) {
    assert.match(source, /FINANCE_TRUST_PROXY_HOPS/);
  }

  assert.match(envExample, /FINANCE_TRUST_PROXY_HOPS=1/);
  assert.match(opsReadme, /FINANCE_TRUST_PROXY_HOPS=1/);
  assert.match(
    opsReadme,
    /Trust-proxy migration checklist[\s\S]*sole ingress[\s\S]*discard any inbound `X-Forwarded-For`[\s\S]*overwrite[\s\S]*Only after[\s\S]*FINANCE_TRUST_PROXY_HOPS=1/i,
  );
  assert.match(opsReadme, /Fail the rollout[\s\S]*proxy-bypass[\s\S]*forged/i);
  assert.match(releaseDoc, /FINANCE_TRUST_PROXY_HOPS=1/);
  assert.match(releaseDoc, /pre-restart|Before restarting/i);
  assert.match(
    releaseDoc,
    /Dashboard trust-proxy migration[\s\S]*sole ingress[\s\S]*discard any inbound `X-Forwarded-For`[\s\S]*overwrite[\s\S]*Only after[\s\S]*FINANCE_TRUST_PROXY_HOPS=1/i,
  );
  assert.match(releaseDoc, /Fail the rollout[\s\S]*bypasses[\s\S]*forged/i);
});
