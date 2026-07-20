const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const source = path.resolve(__dirname, '..', 'owes-snapshot.js');

function runFixture(t, mockSource, initial = '{"sentinel":true}\n', eventsContent = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-owes-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.copyFileSync(source, path.join(dir, 'owes-snapshot.js'));
  fs.writeFileSync(path.join(dir, 'splitwise-lib.js'), mockSource);
  const output = path.join(dir, 'owes-truth.json');
  const eventsPath = path.join(dir, 'events.json');
  fs.writeFileSync(output, initial);
  if (eventsContent !== null) fs.writeFileSync(eventsPath, eventsContent);
  const result = spawnSync(process.execPath, [path.join(dir, 'owes-snapshot.js')], {
    env: {
      ...process.env,
      OWES_TRUTH_PATH: output,
      EVENTS_PATH: eventsContent === null ? path.join(dir, 'missing-events.json') : eventsPath,
    },
    encoding: 'utf8',
  });
  return { dir, output, result };
}

test('a malformed events file fails closed and preserves the prior snapshot', (t) => {
  const fixture = runFixture(t, `
module.exports = {
  eventToGroup: { first: 'Group 1' },
  getDirectOwed: async () => (${JSON.stringify(pair(1, 'Group 1'))}),
  getItemizedOwed: async () => (${JSON.stringify(itemized(1))}),
};
`, '{"sentinel":true}\n', '{broken');
  assert.notEqual(fixture.result.status, 0);
  assert.match(fixture.result.stderr, /Invalid events file/);
  assert.equal(fs.readFileSync(fixture.output, 'utf8'), '{"sentinel":true}\n');
});

const pair = (id, name, amount = 10) => ({
  id,
  name,
  owedToMe: [{ name: 'Person', slug: 'person', amount }],
  iOweThem: [],
});
const itemized = (id) => ({
  id,
  perPerson: {},
  mySpendItems: [{ id: `${id}01`, date: '2026-07-01', desc: 'Meal', category: 'Dining', myShare: 5, paidByMe: false }],
});

test('a partial group failure leaves the prior authoritative snapshot untouched', (t) => {
  const fixture = runFixture(t, `
module.exports = {
  eventToGroup: { first: 'Group 1', second: 'Group 2' },
  getDirectOwed: async (group) => {
    if (group === 'Group 2') throw new Error('temporary failure');
    return ${JSON.stringify(pair(1, 'Group 1'))};
  },
  getItemizedOwed: async () => ${JSON.stringify(itemized(1))},
};
`);
  assert.notEqual(fixture.result.status, 0);
  assert.equal(fs.readFileSync(fixture.output, 'utf8'), '{"sentinel":true}\n');
});

test('duplicate mappings to one numeric group fail without double counting', (t) => {
  const fixture = runFixture(t, `
module.exports = {
  eventToGroup: { first: 'Alias 1', second: 'Alias 2' },
  getDirectOwed: async (group) => (${JSON.stringify(pair(1, 'One Group'))}),
  getItemizedOwed: async () => (${JSON.stringify(itemized(1))}),
};
`);
  assert.notEqual(fixture.result.status, 0);
  assert.equal(fs.readFileSync(fixture.output, 'utf8'), '{"sentinel":true}\n');
});

test('complete snapshots include a prune-safe manifest and private atomic output', (t) => {
  const fixture = runFixture(t, `
module.exports = {
  eventToGroup: { first: 'Group 1', second: 'Group 2' },
  getDirectOwed: async (group) => group === 'Group 1'
    ? (${JSON.stringify(pair(1, 'Group 1', 10))})
    : (${JSON.stringify(pair(2, 'Group 2', 20))}),
  getItemizedOwed: async (group) => group === 'Group 1'
    ? (${JSON.stringify(itemized(1))})
    : (${JSON.stringify(itemized(2))}),
};
`, '');
  assert.equal(fixture.result.status, 0, fixture.result.stderr);
  const snapshot = JSON.parse(fs.readFileSync(fixture.output, 'utf8'));
  assert.equal(snapshot.schemaVersion, 2);
  assert.equal(snapshot.manifest.complete, true);
  assert.equal(snapshot.manifest.expectedEvents, 2);
  assert.equal(snapshot.manifest.resolvedEvents, 2);
  assert.deepEqual(snapshot.manifest.uniqueGroupIds, ['1', '2']);
  assert.equal(snapshot.total, 30);
  assert.equal(fs.statSync(fixture.output).mode & 0o777, 0o600);
});
