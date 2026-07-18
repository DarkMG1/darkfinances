#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { contractFingerprint } = require('./contract-fingerprint');

const root = path.resolve(__dirname, '..');
const stampPath = path.join(root, 'finance-app', 'src', 'api', 'generated', '.contract-fingerprint');

function fail(message) {
  console.error(`contract-freshness: ${message}`);
  process.exit(1);
}

const current = contractFingerprint();
if (!fs.existsSync(stampPath)) {
  fail(`generated contract stamp is missing. Regenerate endpoints/types and run npm run update:contract-stamp`);
}

const stamped = fs.readFileSync(stampPath, 'utf8').trim();
if (stamped !== current) {
  fail(`generated contract is stale (stamp=${stamped}, current=${current}). Regenerate endpoints/types and run npm run update:contract-stamp`);
}

const server = fs.readFileSync(path.join(root, 'finance-dashboard', 'server.js'), 'utf8');
const generated = fs.readFileSync(path.join(root, 'finance-app', 'src', 'api', 'generated', 'endpoints.ts'), 'utf8');

function routes(source, pattern) {
  return [...source.matchAll(pattern)]
    .map((match) => `${match[1].toUpperCase()} /api/v1${match[2]}`)
    .sort();
}

const serverRoutes = [...new Set([
  ...routes(server, /\bv1\.(get|post|delete|put|patch)\('([^']+)'/g),
  ...routes(server, /\bregisterV1Mutation\('(POST|DELETE|PUT|PATCH)', '([^']+)'/g),
])]
  .filter((route) => !route.includes('/test/'))
  .sort();
const generatedRoutes = [...generated.matchAll(/\bdef\('([^']+)', '(GET|POST|DELETE|PUT|PATCH)'/g)]
  .map((match) => `${match[2]} ${match[1]}`)
  .sort();

if (JSON.stringify(serverRoutes) !== JSON.stringify(generatedRoutes)) {
  fail('generated endpoints.ts does not match finance-dashboard/server.js routes');
}

console.log(`contract-freshness: ok (${current}, ${serverRoutes.length} routes)`);
