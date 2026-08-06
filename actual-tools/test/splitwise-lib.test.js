const test = require('node:test');
const assert = require('node:assert/strict');
const { getDirectOwed, oneCurrency, resolveGroup, slugForName } = require('../splitwise-lib');

const groups = [
  { id: 1, name: 'Summer Trip' },
  { id: 2, name: 'Summer Trip Planning' },
  { id: 3, name: 'Apartment' },
];

test('group resolution prefers numeric and exact names and rejects ambiguity', () => {
  assert.equal(resolveGroup(groups, 2).id, 2);
  assert.equal(resolveGroup(groups, 'summer trip').id, 1);
  assert.equal(resolveGroup(groups, 'apartment').id, 3);
  assert.throws(() => resolveGroup(groups, 'summer'), /multiple/);
});

test('currency helper never silently adds unlike currencies', () => {
  assert.deepEqual(oneCurrency([{ amount: '10.25', currency_code: 'USD' }], 'test'), {
    amount: 10.25,
    currency: 'USD',
  });
  assert.throws(
    () => oneCurrency([
      { amount: '10', currency_code: 'USD' },
      { amount: '5', currency_code: 'EUR' },
    ], 'test'),
    /multiple currencies/
  );
});

test('empty names never create an undefined identity', () => {
  assert.equal(slugForName(''), null);
  assert.equal(slugForName('Alex Example'), 'alex');
});

test('direct pairwise results carry stable numeric Splitwise user ids', async (t) => {
  const priorFetch = global.fetch;
  const priorApiKey = process.env.SPLITWISE_API_KEY;
  t.after(() => {
    global.fetch = priorFetch;
    if (priorApiKey === undefined) delete process.env.SPLITWISE_API_KEY;
    else process.env.SPLITWISE_API_KEY = priorApiKey;
  });
  process.env.SPLITWISE_API_KEY = 'test-token';

  const payloads = {
    get_groups: {
      groups: [{
        id: 7,
        name: 'Stable IDs',
        members: [
          { id: 1, first_name: 'Me', last_name: 'Example' },
          { id: 101, first_name: 'Alex', last_name: 'Able' },
          { id: 202, first_name: 'Sam', last_name: 'Baker' },
        ],
      }],
    },
    get_current_user: { user: { id: 1, first_name: 'Me' } },
    get_friends: {
      friends: [
        {
          id: 101,
          first_name: 'Alex',
          last_name: 'Able',
          groups: [{ group_id: 7, balance: [{ amount: '12.34', currency_code: 'USD' }] }],
        },
        {
          id: 202,
          first_name: 'Sam',
          last_name: 'Baker',
          groups: [{ group_id: 7, balance: [{ amount: '-4.56', currency_code: 'USD' }] }],
        },
      ],
    },
  };
  global.fetch = async (url) => {
    const endpoint = new URL(url).pathname.split('/').pop();
    assert.ok(payloads[endpoint], `unexpected Splitwise endpoint ${endpoint}`);
    return new Response(JSON.stringify(payloads[endpoint]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const result = await getDirectOwed(7);
  assert.deepEqual(result.owedToMe, [{
    id: 101,
    name: 'Alex Able',
    slug: 'alex',
    amount: 12.34,
    currency: 'USD',
  }]);
  assert.deepEqual(result.iOweThem, [{
    id: 202,
    name: 'Sam Baker',
    slug: 'sam',
    amount: 4.56,
    currency: 'USD',
  }]);
});
