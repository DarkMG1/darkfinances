#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
}

function actualApiVersion(pkgRel) {
  return readJson(pkgRel).dependencies?.['@actual-app/api'] || null;
}

function fail(message) {
  console.error(`version-alignment: ${message}`);
  process.exit(1);
}

const compose = fs.readFileSync(path.join(root, 'ops', 'actual-compose.yml'), 'utf8');
const serverTag = compose.match(/actual-server:([0-9.]+)/)?.[1];
const dashboardApi = actualApiVersion('finance-dashboard/package.json');
const toolsApi = actualApiVersion('actual-tools/package.json');

if (!serverTag) fail('ops/actual-compose.yml is missing an actual-server image tag');
if (!dashboardApi) fail('finance-dashboard/package.json is missing @actual-app/api');
if (!toolsApi) fail('actual-tools/package.json is missing @actual-app/api');

const expectedMajorMinor = serverTag.split('.').slice(0, 2).join('.');
for (const [label, spec] of [['dashboard', dashboardApi], ['actual-tools', toolsApi]]) {
  if (!spec.includes(expectedMajorMinor)) {
    fail(`${label} @actual-app/api (${spec}) does not align with Actual server ${serverTag}`);
  }
}

if (dashboardApi !== toolsApi) {
  fail(`@actual-app/api mismatch: dashboard=${dashboardApi}, actual-tools=${toolsApi}`);
}

console.log(`version-alignment: ok (server ${serverTag}, api ${dashboardApi})`);
