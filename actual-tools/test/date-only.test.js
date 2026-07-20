const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const libPath = path.resolve(__dirname, '../lib/date-only.js');

function runInProcessZone(processZone, fn) {
  const script = `
    process.env.TZ = ${JSON.stringify(processZone)};
    process.env.FINANCE_TIME_ZONE = 'America/Los_Angeles';
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
const { resolveFinanceTimeZone, todayYMD } = require('../lib/date-only');

test('Pacific 16:59 and 17:01 stay on the same finance date during DST', () => {
  assert.equal(todayYMD(new Date('2026-07-09T16:59:00-07:00')), '2026-07-09');
  assert.equal(todayYMD(new Date('2026-07-09T17:01:00-07:00')), '2026-07-09');
});

test('Pacific 16:59 and 17:01 stay on the same finance date during standard time', () => {
  assert.equal(todayYMD(new Date('2026-01-15T16:59:00-08:00')), '2026-01-15');
  assert.equal(todayYMD(new Date('2026-01-15T17:01:00-08:00')), '2026-01-15');
});

for (const processZone of ['UTC', 'Asia/Tokyo', 'America/Los_Angeles']) {
  test(`actual-tools finance today ignores process zone ${processZone} at Pacific 16:59/17:01 (DST)`, () => {
    const results = runInProcessZone(processZone, (mod) => ({
      before: mod.todayYMD(new Date('2026-07-09T16:59:00-07:00')),
      after: mod.todayYMD(new Date('2026-07-09T17:01:00-07:00')),
    }));
    assert.deepEqual(results, { before: '2026-07-09', after: '2026-07-09' });
  });

  test(`actual-tools finance today ignores process zone ${processZone} at Pacific 16:59/17:01 (standard)`, () => {
    const results = runInProcessZone(processZone, (mod) => ({
      before: mod.todayYMD(new Date('2026-01-15T16:59:00-08:00')),
      after: mod.todayYMD(new Date('2026-01-15T17:01:00-08:00')),
    }));
    assert.deepEqual(results, { before: '2026-01-15', after: '2026-01-15' });
  });
}

test('resolveFinanceTimeZone rejects invalid zones safely', () => {
  assert.equal(resolveFinanceTimeZone({ financeTimeZone: 'bogus', tz: 'UTC' }), 'UTC');
  assert.equal(resolveFinanceTimeZone({ financeTimeZone: 'bogus', tz: 'also-bogus' }), 'America/Los_Angeles');
});
