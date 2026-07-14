const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const server = fs.readFileSync(path.resolve(__dirname, '..', 'server.js'), 'utf8');
const generated = fs.readFileSync(path.resolve(__dirname, '..', '..', 'finance-app', 'src', 'api', 'generated', 'endpoints.ts'), 'utf8');
const browser = fs.readFileSync(path.resolve(__dirname, '..', 'public', 'index.html'), 'utf8');
const appHome = fs.readFileSync(path.resolve(__dirname, '..', '..', 'finance-app', 'src', 'app', '(tabs)', 'index.tsx'), 'utf8');

function serverRoutes() {
  const direct = [...server.matchAll(/\bv1\.(get|post|delete|put|patch)\('([^']+)'/g)]
    .map((match) => `${match[1].toUpperCase()} /api/v1${match[2]}`);
  const journaled = [...server.matchAll(/\bregisterV1Mutation\('([A-Z]+)', '([^']+)'/g)]
    .map((match) => `${match[1]} /api/v1${match[2]}`);
  return [...new Set([...direct, ...journaled])].sort();
}

function generatedRoutes() {
  return [...generated.matchAll(/\bdef\('([^']+)', '(GET|POST|DELETE|PUT|PATCH)'/g)]
    .map((match) => `${match[2]} ${match[1]}`)
    .sort();
}

test('native generated endpoint catalog matches every server route', () => {
  assert.deepEqual(generatedRoutes(), serverRoutes());
});

test('generated contract includes semimonthly cadence', () => {
  const types = fs.readFileSync(path.resolve(__dirname, '..', '..', 'finance-app', 'src', 'api', 'generated', 'types.ts'), 'utf8');
  assert.match(types, /'semimonthly'/);
});

test('app and web render incomplete Safe-to-Spend as unavailable, never zero', () => {
  assert.match(browser, /Safe to Spend/);
  assert.match(browser, /metric\?\.complete === true && Number\.isFinite\(metric\.value\)/);
  assert.match(browser, /available \? fmt\(metric\.value\) : 'Unavailable'/);
  assert.doesNotMatch(browser, /fmt\(metric\.value\s*\|\|\s*0\)/);

  assert.match(appHome, /safeToSpend\?\.complete && safeToSpend\.value != null/);
  assert.match(appHome, /Safe to Spend unavailable/);
  assert.doesNotMatch(appHome, /fmtMoney\(safeToSpend\.value\s*\|\|\s*0\)/);
});
