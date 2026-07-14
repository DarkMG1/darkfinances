const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  CLASSIFICATIONS,
  MUTATION_ROUTES,
  routeKey,
} = require('../lib/mutation-route-registry');

test('every versioned mutation route is registered through lifecycle coverage', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'server.js'), 'utf8');
  assert.equal(
    /\bv1\.(?:post|put|patch|delete)\s*\(/.test(source),
    false,
    'direct v1 mutation registration bypasses lifecycle classification',
  );

  const registered = new Set();
  const registration = /registerV1Mutation\(\s*'([A-Z]+)'\s*,\s*'([^']+)'/g;
  for (const match of source.matchAll(registration)) registered.add(routeKey(match[1], match[2]));
  const classified = new Set(MUTATION_ROUTES.map(({ method, path: route }) => routeKey(method, route)));

  assert.deepEqual([...registered].sort(), [...classified].sort());
  assert.equal(registered.size, MUTATION_ROUTES.length);
});

test('mutation lifecycle registry is unique and completely classified', () => {
  const validClassifications = new Set(Object.values(CLASSIFICATIONS));
  const seen = new Set();
  for (const definition of MUTATION_ROUTES) {
    const key = routeKey(definition.method, definition.path);
    assert.equal(seen.has(key), false, `duplicate route ${key}`);
    seen.add(key);
    assert.ok(validClassifications.has(definition.classification), `${key} has an invalid classification`);
    assert.ok(definition.firstEffect.length > 0, `${key} is missing its first-effect boundary`);
    assert.equal(definition.requiresCheckpoint, true, `${key} must require a durable checkpoint`);
  }
});
