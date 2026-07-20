'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  interpretCrontabListResult,
} = require('../lib/ops-command-runners');
const {
  auditLegacyOwesSnapshotCron,
  findActiveLegacyOwesSnapshotCronLines,
  isCrontabCommentOrEmpty,
} = require('../lib/writer-quiescence');
const { createMockRunners } = require('./fixtures/coordinated-backup-fixtures');

test('findActiveLegacyOwesSnapshotCronLines ignores comments and blank lines', () => {
  const listing = [
    'CRON_TZ=America/Los_Angeles',
    '# */30 * * * * bash ~/actual-tools/run.sh owes-snapshot.js',
    '',
    '15 6 * * * bash ~/actual-tools/run.sh event-collect.js',
  ].join('\n');
  assert.deepEqual(findActiveLegacyOwesSnapshotCronLines(listing), []);
  assert.equal(isCrontabCommentOrEmpty('  # legacy'), true);
});

test('findActiveLegacyOwesSnapshotCronLines detects active owes-snapshot.js entries', () => {
  const listing = '*/30 * * * * bash /home/dark/actual-tools/run.sh owes-snapshot.js\n';
  assert.deepEqual(findActiveLegacyOwesSnapshotCronLines(listing), [listing.trim()]);
});

test('interpretCrontabListResult accepts no crontab for user', () => {
  const parsed = interpretCrontabListResult({
    status: 1,
    stdout: '',
    stderr: 'no crontab for user\n',
  });
  assert.equal(parsed.empty, true);
  assert.equal(parsed.listing, '');
});

test('interpretCrontabListResult fails closed on ambiguous crontab errors', () => {
  assert.throws(
    () => interpretCrontabListResult({ status: 2, stdout: '', stderr: 'permission denied' }),
    /crontab -l failed: permission denied/,
  );
});

test('auditLegacyOwesSnapshotCron rejects active legacy cron when event sync is configured', () => {
  const runners = createMockRunners({
    crontabListing: '*/30 * * * * bash /home/dark/actual-tools/run.sh owes-snapshot.js\n',
  });
  assert.throws(
    () => auditLegacyOwesSnapshotCron({
      env: { FINANCE_EVENT_SYNC_CONFIGURED: '1' },
      runners,
    }),
    /legacy owes-snapshot\.js cron entry must be removed/,
  );
  assert.ok(runners.commands.some((entry) => entry[0] === 'crontab' && entry[1] === '-l'));
});

test('auditLegacyOwesSnapshotCron accepts commented legacy cron and empty crontab', () => {
  const commented = createMockRunners({
    crontabListing: '# */30 * * * * bash run.sh owes-snapshot.js\n',
  });
  auditLegacyOwesSnapshotCron({
    env: { FINANCE_EVENT_SYNC_CONFIGURED: '1' },
    runners: commented,
  });

  const empty = createMockRunners({ crontabListing: null });
  auditLegacyOwesSnapshotCron({
    env: { FINANCE_EVENT_SYNC_CONFIGURED: '1' },
    runners: empty,
  });
});

test('auditLegacyOwesSnapshotCron is skipped when FINANCE_EVENT_SYNC_CONFIGURED is unset', () => {
  const runners = createMockRunners({
    crontabListing: '*/30 * * * * bash run.sh owes-snapshot.js\n',
  });
  auditLegacyOwesSnapshotCron({ env: {}, runners });
  assert.equal(runners.commands.some((entry) => entry[0] === 'crontab'), false);
});
