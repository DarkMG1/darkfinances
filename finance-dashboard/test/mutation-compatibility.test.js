const test = require('node:test');
const assert = require('node:assert/strict');
const { MUTATION_PAYLOAD_FIXTURES } = require('./fixtures/mutation-payloads');
const { validateMutationRequest, MUTATION_CONTRACTS } = require('../lib/request-contract');

function mockReq(fixture) {
  return {
    method: fixture.method,
    path: fixture.path,
    params: fixture.params || {},
    query: fixture.query || {},
    body: fixture.body ?? {},
  };
}

test('every mutation contract has at least one caller fixture', () => {
  const covered = new Set();
  for (const fixture of MUTATION_PAYLOAD_FIXTURES) {
    const req = mockReq(fixture);
    assert.doesNotThrow(
      () => validateMutationRequest(req),
      `${fixture.source} should pass contract validation`,
    );
    const contract = MUTATION_CONTRACTS.find(
      (entry) => entry.method === req.method && entry.pattern.test(
        req.path.replace(/^\/api(?:\/v1)?(?=\/|$)/i, '') || '/',
      ),
    );
    assert.ok(contract, `${fixture.source} resolves to a mutation contract`);
    covered.add(`${contract.method}:${contract.pattern}`);
  }
  assert.equal(covered.size, MUTATION_CONTRACTS.length, 'all mutation contracts covered by fixtures');
});

test('caller fixtures reject unknown fields consistently', () => {
  for (const fixture of MUTATION_PAYLOAD_FIXTURES) {
    if (!fixture.body || typeof fixture.body !== 'object' || Array.isArray(fixture.body)) continue;
    if (Object.keys(fixture.body).length === 0) continue;
    const polluted = { ...fixture.body, __unexpectedFixtureField: true };
    const req = mockReq({ ...fixture, body: polluted });
    assert.throws(
      () => validateMutationRequest(req),
      (error) => error.name === 'RequestValidationError',
      `${fixture.source} should reject unknown body fields`,
    );
  }
});
