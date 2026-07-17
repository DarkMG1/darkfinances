const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const libPath = path.resolve(__dirname, '../lib/date-only.js');

const DST_BOUNDARY = {
  before: '2026-07-09T16:59:00-07:00',
  after: '2026-07-09T17:01:00-07:00',
  financeDate: '2026-07-09',
};
const STD_BOUNDARY = {
  before: '2026-01-15T16:59:00-08:00',
  after: '2026-01-15T17:01:00-08:00',
  financeDate: '2026-01-15',
};

function runInProcessZone(processZone, fn) {
  const script = `
    process.env.TZ = ${JSON.stringify(processZone)};
    delete require.cache[require.resolve(${JSON.stringify(libPath)})];
    const dateOnly = require(${JSON.stringify(libPath)});
    const result = (${fn.toString()})(dateOnly);
    if (result !== undefined) console.log(JSON.stringify(result));
  `;
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim() ? JSON.parse(result.stdout.trim()) : undefined;
}

process.env.FINANCE_TIME_ZONE = 'America/Los_Angeles';
const dateOnly = require('../lib/date-only');
const {
  addDays,
  addMonths,
  daysBetween,
  daysInMonth,
  daysUntilDateOnly,
  isValidIanaTimeZone,
  monthRange,
  reimbursementWindow,
  resolveFinanceTimeZone,
  startMonthsAgo,
  todayYMD,
} = dateOnly;

test('finance today stays Pacific around UTC midnight', () => {
  assert.equal(todayYMD(new Date('2026-07-10T06:30:00.000Z')), '2026-07-09');
  assert.equal(todayYMD(new Date('2026-07-10T07:30:00.000Z')), '2026-07-10');
});

test('Pacific 16:59 and 17:01 stay on the same finance date during DST', () => {
  assert.equal(todayYMD(new Date(DST_BOUNDARY.before)), DST_BOUNDARY.financeDate);
  assert.equal(todayYMD(new Date(DST_BOUNDARY.after)), DST_BOUNDARY.financeDate);
});

test('Pacific 16:59 and 17:01 stay on the same finance date during standard time', () => {
  assert.equal(todayYMD(new Date(STD_BOUNDARY.before)), STD_BOUNDARY.financeDate);
  assert.equal(todayYMD(new Date(STD_BOUNDARY.after)), STD_BOUNDARY.financeDate);
});

for (const processZone of ['UTC', 'Asia/Tokyo', 'America/Los_Angeles']) {
  test(`finance today ignores process zone ${processZone} at Pacific 16:59/17:01 (DST)`, () => {
    const results = runInProcessZone(processZone, (mod) => ({
      before: mod.todayYMD(new Date('2026-07-09T16:59:00-07:00')),
      after: mod.todayYMD(new Date('2026-07-09T17:01:00-07:00')),
    }));
    assert.deepEqual(results, { before: '2026-07-09', after: '2026-07-09' });
  });

  test(`finance today ignores process zone ${processZone} at Pacific 16:59/17:01 (standard)`, () => {
    const results = runInProcessZone(processZone, (mod) => ({
      before: mod.todayYMD(new Date('2026-01-15T16:59:00-08:00')),
      after: mod.todayYMD(new Date('2026-01-15T17:01:00-08:00')),
    }));
    assert.deepEqual(results, { before: '2026-01-15', after: '2026-01-15' });
  });
}

test('UTC truncation would drift across Pacific late-afternoon boundaries', () => {
  const utcSlice = (iso) => new Date(iso).toISOString().slice(0, 10);
  assert.notEqual(utcSlice(DST_BOUNDARY.after), DST_BOUNDARY.financeDate);
  assert.notEqual(utcSlice(STD_BOUNDARY.before), STD_BOUNDARY.financeDate);
});

test('resolveFinanceTimeZone rejects invalid zones safely', () => {
  assert.equal(resolveFinanceTimeZone({ financeTimeZone: 'Not/AZone', tz: 'UTC' }), 'UTC');
  assert.equal(resolveFinanceTimeZone({ financeTimeZone: 'bogus', tz: 'also-bogus' }), 'America/Los_Angeles');
  assert.equal(isValidIanaTimeZone('America/Los_Angeles'), true);
  assert.equal(isValidIanaTimeZone(''), false);
});

test('date-only arithmetic does not drift across daylight-saving boundaries', () => {
  assert.equal(addDays('2026-03-07', 2), '2026-03-09');
  assert.equal(addDays('2026-11-01', 1), '2026-11-02');
  assert.equal(daysBetween('2026-03-07', '2026-03-09'), 2);
});

test('month ranges and leap days are calendar-correct', () => {
  assert.deepEqual(monthRange(2024, 1), {
    key: '2024-02',
    start: '2024-02-01',
    end: '2024-02-29',
  });
  assert.equal(daysInMonth('2026-02'), 28);
  assert.throws(() => addDays('2026-02-30', 1), /real calendar date/);
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonths('2024-01-31', 1), '2024-02-29');
});

test('finance windows anchor on explicit finance dates', () => {
  assert.deepEqual(reimbursementWindow('7d', '2026-07-09'), {
    from: '2026-07-03',
    to: '2026-07-09',
    label: 'Last 7 days',
  });
  assert.equal(startMonthsAgo(3, '2026-07-09'), '2026-05-01');
  assert.equal(daysUntilDateOnly('2026-07-11', '2026-07-09'), 2);
});
