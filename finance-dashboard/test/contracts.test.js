const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const server = fs.readFileSync(path.resolve(__dirname, '..', 'server.js'), 'utf8');
const generated = fs.readFileSync(path.resolve(__dirname, '..', '..', 'finance-app', 'src', 'api', 'generated', 'endpoints.ts'), 'utf8');

function serverRoutes() {
  return [...server.matchAll(/\bv1\.(get|post|delete|put|patch)\('([^']+)'/g)]
    .map((match) => `${match[1].toUpperCase()} /api/v1${match[2]}`)
    .sort();
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
