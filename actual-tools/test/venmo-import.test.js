const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  mergeEvent,
  parseAmount,
  parseArgs,
  parseCsv,
  validateSidecar,
} = require('../venmo-import');

const source = path.resolve(__dirname, '..', 'venmo-import.js');
const VALID_SIDECAR = `${JSON.stringify({
  schemaVersion: 2,
  generatedAt: '2026-08-01T00:00:00.000Z',
  source: 'venmo-csv',
  event: 'Old',
  imports: {
    Old: {
      importedAt: '2026-08-01T00:00:00.000Z',
      sourceFile: 'old.csv',
      settledNet: {},
    },
  },
  bySlug: {
    sam: [{ event: 'Old', amount: 4.56 }],
  },
  people: [{ slug: 'sam', name: 'Sam Example', owed: 4.56 }],
}, null, 2)}\n`;

function csvCell(value) {
  const string = String(value ?? '');
  return /[",\r\n]/.test(string) ? `"${string.replaceAll('"', '""')}"` : string;
}

function statement(rows, { withId = true } = {}) {
  const columns = [
    ...(withId ? [['id', 'ID']] : []),
    ['datetime', 'Datetime'],
    ['type', 'Type'],
    ['status', 'Status'],
    ['note', 'Note'],
    ['from', 'From'],
    ['to', 'To'],
    ['amount', 'Amount (total)'],
  ];
  return [
    columns.map(([, label]) => label),
    ...rows.map((row) => columns.map(([key]) => row[key] ?? '')),
  ].map((row) => row.map(csvCell).join(',')).join('\n') + '\n';
}

function pending(overrides = {}) {
  return {
    id: 'txn-1',
    datetime: '2026-08-01T12:00:00',
    type: 'Charge',
    status: 'Pending',
    note: 'Dinner',
    from: 'Alex Example',
    to: 'Me Person',
    amount: '$12.34',
    ...overrides,
  };
}

function completed(overrides = {}) {
  return pending({
    id: 'txn-complete',
    type: 'Payment',
    status: 'Complete',
    from: 'Me Person',
    to: 'Alex Example',
    ...overrides,
  });
}

function runCli(t, csv, { args = [], initial = VALID_SIDECAR } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-venmo-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const input = path.join(dir, 'statement.csv');
  const output = path.join(dir, 'venmo-truth.json');
  fs.writeFileSync(input, csv);
  fs.writeFileSync(output, initial);
  const before = fs.readFileSync(output);
  const result = spawnSync(
    process.execPath,
    [source, input, '--me', 'Me Person', '--out', output, ...args],
    { encoding: 'utf8' },
  );
  return {
    result,
    output,
    before,
    after: fs.readFileSync(output),
  };
}

function assertFailedWithoutWrite(fixture, stderrPattern) {
  assert.notEqual(fixture.result.status, 0);
  assert.match(fixture.result.stderr, stderrPattern);
  assert.deepEqual(fixture.after, fixture.before);
  assert.equal(fs.existsSync(`${fixture.output}.last-good`), false);
}

test('CSV parser handles quoted commas and rejects unterminated fields', () => {
  assert.deepEqual(parseCsv('Type,Note\nCharge,\"Dinner, drinks\"\n'), [
    ['Type', 'Note'],
    ['Charge', 'Dinner, drinks'],
  ]);
  assert.throws(() => parseCsv('Type,Note\nCharge,\"Dinner'), /quoted field/);
});

test('CLI parser accepts only the declared option grammar', () => {
  assert.deepEqual(
    parseArgs(['statement.csv', '--me=Me Person', '--event', 'Trip', '--out=result.json', '--dry']),
    {
      flags: { me: 'Me Person', event: 'Trip', out: 'result.json', dry: true },
      pos: ['statement.csv'],
    },
  );
});

test('money parser accepts Venmo currency forms and rejects blank or malformed values', () => {
  assert.equal(parseAmount('+ $1,234.50'), 1234.5);
  assert.equal(parseAmount('-$0.75'), -0.75);
  for (const malformed of ['', '   ', '$12oops', '$1.2.3', '1,23.00', '--$5.00']) {
    assert.throws(() => parseAmount(malformed), /Invalid Venmo amount/);
  }
});

test('event imports replace only that event and preserve other Venmo debts', () => {
  const existing = {
    bySlug: {
      alex: [{ event: 'Trip A', amount: 10 }],
      sam: [{ event: 'Trip B', amount: 20 }],
    },
    people: [
      { slug: 'alex', name: 'Alex Example', owed: 10 },
      { slug: 'sam', name: 'Sam Example', owed: 20 },
    ],
    imports: { 'Trip A': { sourceFile: 'old.csv' } },
  };
  const merged = mergeEvent(existing, 'Trip A', {
    generatedAt: '2026-07-10T00:00:00.000Z',
    sourceFile: 'new.csv',
    settledNet: {},
    bySlug: { alex: [{ event: 'Trip A', amount: 15 }] },
    people: [{ slug: 'alex', name: 'Alex Example', owed: 15 }],
  });
  assert.deepEqual(merged.bySlug.alex, [{ event: 'Trip A', amount: 15 }]);
  assert.deepEqual(merged.bySlug.sam, [{ event: 'Trip B', amount: 20 }]);
  assert.equal(merged.imports['Trip A'].sourceFile, 'new.csv');
});

test('merge rejects identity collisions instead of combining two people', () => {
  assert.throws(
    () => mergeEvent(
      { bySlug: { alex: [{ event: 'Old', amount: 1 }] }, people: [{ slug: 'alex', name: 'Alex One' }] },
      'New',
      { generatedAt: 'now', sourceFile: 'new.csv', settledNet: {}, bySlug: { alex: [{ event: 'New', amount: 2 }] }, people: [{ slug: 'alex', name: 'Alex Two' }] },
    ),
    /identity collision/
  );
});

test('closed-world CLI failures leave the destination byte-identical', async (t) => {
  const validCsv = statement([pending()]);
  const cases = [
    ['unknown typo of dry', ['--drry'], /Unknown option --drry/],
    ['missing option value', ['--event'], /--event requires a value/],
    ['dry value', ['--dry=yes'], /--dry does not take a value/],
    ['flip value', ['--flip=false'], /--flip does not take a value/],
    ['extra positional', ['extra.csv'], /extra positional arguments/],
  ];
  for (const [name, args, pattern] of cases) {
    await t.test(name, (t) => {
      assertFailedWithoutWrite(runCli(t, validCsv, { args }), pattern);
    });
  }
});

test('malformed relevant input fails without touching the destination', async (t) => {
  const cases = [
    ['amount', statement([pending({ amount: '$12oops' })]), /Invalid Venmo amount/],
    ['quoted CSV', 'ID,Datetime,Type,Status,From,To,Amount (total)\ntxn-1,"unterminated', /quoted field/],
    ['required column', 'ID,Datetime,Type,Status,From,Amount (total)\ntxn-1,now,Charge,Pending,Alex,$1.00\n', /missing the to column/],
  ];
  for (const [name, csv, pattern] of cases) {
    await t.test(name, (t) => {
      assertFailedWithoutWrite(runCli(t, csv), pattern);
    });
  }
});

test('malformed money on an irrelevant row is ignored', (t) => {
  const csv = statement([
    pending({ id: 'irrelevant', from: 'Other Person', to: 'Someone Else', amount: '$bad' }),
    pending({ id: 'irrelevant-blank', from: 'Other Person', to: 'Someone Else', amount: '' }),
    pending({ id: 'irrelevant-zero', from: 'Other Person', to: 'Someone Else', amount: '$0.00' }),
    pending(),
  ]);
  const fixture = runCli(t, csv, { args: ['--dry'] });
  assert.equal(fixture.result.status, 0, fixture.result.stderr);
  assert.deepEqual(fixture.after, fixture.before);
});

test('blank and zero relevant amounts fail identically in dry and write modes', async (t) => {
  const cases = [
    ['pending blank', pending({ amount: '' }), /CSV row 2: Invalid Venmo amount: value is missing or blank/],
    ['completed blank', completed({ amount: '   ' }), /CSV row 2: Invalid Venmo amount: value is missing or blank/],
    ['pending zero', pending({ amount: '$0.00' }), /CSV row 2: relevant Venmo amount must be non-zero/],
    ['completed signed zero', completed({ amount: '- $0.00' }), /CSV row 2: relevant Venmo amount must be non-zero/],
  ];
  for (const [name, row, pattern] of cases) {
    await t.test(name, (t) => {
      const csv = statement([row]);
      const write = runCli(t, csv);
      const dry = runCli(t, csv, { args: ['--dry'] });
      assertFailedWithoutWrite(write, pattern);
      assertFailedWithoutWrite(dry, pattern);
      assert.equal(dry.result.status, write.result.status);
      assert.equal(dry.result.stderr, write.result.stderr);
      assert.equal(dry.result.stdout, write.result.stdout);
    });
  }
});

test('transaction IDs reject exact duplicates and conflicting rows without writing', async (t) => {
  const duplicate = pending();
  const cases = [
    ['duplicate', statement([duplicate, { ...duplicate }]), /Duplicate Venmo transaction ID/],
    ['conflict', statement([duplicate, { ...duplicate, amount: '$13.34' }]), /Conflicting Venmo rows/],
    ['missing ID', statement([pending({ id: '' })]), /missing a transaction ID/],
  ];
  for (const [name, csv, pattern] of cases) {
    await t.test(name, (t) => {
      assertFailedWithoutWrite(runCli(t, csv), pattern);
    });
  }
});

test('an ID-less export rejects ambiguous exact duplicate relevant rows', (t) => {
  const row = pending();
  const fixture = runCli(t, statement([row, { ...row }], { withId: false }));
  assertFailedWithoutWrite(fixture, /Ambiguous duplicate relevant Venmo row/);
});

test('distinct transaction IDs disambiguate otherwise identical relevant rows', (t) => {
  const fixture = runCli(t, statement([
    pending({ id: 'txn-1' }),
    pending({ id: 'txn-2' }),
  ]));
  assert.equal(fixture.result.status, 0, fixture.result.stderr);
  const output = JSON.parse(fixture.after.toString('utf8'));
  assert.deepEqual(output.bySlug.alex, [{ event: 'Venmo', amount: 24.68 }]);
  assert.deepEqual(output.bySlug.sam, [{ event: 'Old', amount: 4.56 }]);
});

test('--dry guarantees no output or last-good write', (t) => {
  const fixture = runCli(t, statement([pending()]), { args: ['--dry'] });
  assert.equal(fixture.result.status, 0, fixture.result.stderr);
  assert.deepEqual(fixture.after, fixture.before);
  assert.equal(fs.existsSync(`${fixture.output}.last-good`), false);
});

test('malformed existing sidecars fail closed before atomic replacement', async (t) => {
  const cases = [
    ['invalid JSON', '{broken\n', /Could not load existing Venmo sidecar/],
    ['invalid schema', '{"schemaVersion":2,"bySlug":[]}\n', /Existing Venmo sidecar is invalid/],
    ['invalid nested amount', '{"schemaVersion":2,"bySlug":{"alex":[{"event":"Old","amount":"4.56"}]}}\n', /amount must be a positive finite number/],
  ];
  for (const [name, initial, pattern] of cases) {
    await t.test(name, (t) => {
      assertFailedWithoutWrite(runCli(t, statement([pending()]), { initial }), pattern);
    });
  }
});

test('the merged next sidecar is validated before replacement', (t) => {
  const fixture = runCli(t, statement([pending()]), { args: ['--event', '__proto__'] });
  assertFailedWithoutWrite(fixture, /Next Venmo sidecar is invalid/);
});

test('sidecar validation accepts the generated schema and rejects future versions', () => {
  assert.doesNotThrow(() => validateSidecar(JSON.parse(VALID_SIDECAR)));
  assert.throws(
    () => validateSidecar({ schemaVersion: 3, bySlug: {} }),
    /schemaVersion must be 2/,
  );
});
