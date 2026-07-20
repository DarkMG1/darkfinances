const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const libPath = path.resolve(__dirname, '../src/lib/finance-date-core.js');

function runInProcessZone(processZone, fn) {
  const script = `
    process.env.TZ = ${JSON.stringify(processZone)};
    const dateOnly = require(${JSON.stringify(libPath)});
    dateOnly.configureFinanceTimeZone('America/Los_Angeles');
    const result = (${fn.toString()})(dateOnly);
    if (result !== undefined) console.log(JSON.stringify(result));
  `;
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim() ? JSON.parse(result.stdout.trim()) : undefined;
}

const {
  addDateOnlyDays,
  configureFinanceTimeZone,
  daysUntilDateOnly,
  financeToday,
  isValidIanaTimeZone,
  reimbursementWindow,
  startMonthsAgo,
} = require('../src/lib/finance-date-core.js');

configureFinanceTimeZone('America/Los_Angeles');

test('Pacific 16:59 and 17:01 stay on the same finance date during DST', () => {
  assert.equal(financeToday(new Date('2026-07-09T16:59:00-07:00')), '2026-07-09');
  assert.equal(financeToday(new Date('2026-07-09T17:01:00-07:00')), '2026-07-09');
});

test('Pacific 16:59 and 17:01 stay on the same finance date during standard time', () => {
  assert.equal(financeToday(new Date('2026-01-15T16:59:00-08:00')), '2026-01-15');
  assert.equal(financeToday(new Date('2026-01-15T17:01:00-08:00')), '2026-01-15');
});

for (const processZone of ['UTC', 'Asia/Tokyo', 'America/Los_Angeles']) {
  test(`mobile finance today ignores process zone ${processZone} at Pacific 16:59/17:01 (DST)`, () => {
    const results = runInProcessZone(processZone, (mod) => ({
      before: mod.financeToday(new Date('2026-07-09T16:59:00-07:00')),
      after: mod.financeToday(new Date('2026-07-09T17:01:00-07:00')),
    }));
    assert.deepEqual(results, { before: '2026-07-09', after: '2026-07-09' });
  });

  test(`mobile finance today ignores process zone ${processZone} at Pacific 16:59/17:01 (standard)`, () => {
    const results = runInProcessZone(processZone, (mod) => ({
      before: mod.financeToday(new Date('2026-01-15T16:59:00-08:00')),
      after: mod.financeToday(new Date('2026-01-15T17:01:00-08:00')),
    }));
    assert.deepEqual(results, { before: '2026-01-15', after: '2026-01-15' });
  });
}

test('configureFinanceTimeZone rejects invalid zones', () => {
  assert.equal(configureFinanceTimeZone('Not/AZone'), 'America/Los_Angeles');
  assert.equal(isValidIanaTimeZone('America/Los_Angeles'), true);
});

test('reimbursement and activity windows use finance dates', () => {
  assert.deepEqual(reimbursementWindow('mtd', '2026-07-09'), {
    from: '2026-07-01',
    to: '2026-07-09',
    label: 'This month',
  });
  assert.equal(startMonthsAgo(3, '2026-07-09'), '2026-05-01');
  assert.equal(addDateOnlyDays('2026-07-09', -6), '2026-07-03');
  assert.equal(daysUntilDateOnly('2026-07-11', '2026-07-09'), 2);
});
