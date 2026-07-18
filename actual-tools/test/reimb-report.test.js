'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const script = path.resolve(__dirname, '..', 'reimb-report.js');

test('reimb-report --help exits zero', () => {
  const result = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Exit codes/);
});

test('reimb-report strict incomplete removes partial artifact', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reimb-report-atomic-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const outPath = path.join(dir, 'nested', 'export.json');
  const result = spawnSync(process.execPath, [script, '--json', '--strict', '--output', outPath], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ACTUAL_SERVER_URL: 'http://127.0.0.1:9',
      ACTUAL_PASSWORD: 'invalid',
      ACTUAL_SYNC_ID: 'invalid',
      ACTUAL_DATA_DIR: path.join(dir, 'actual-cache'),
    },
  });
  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(outPath), false);
  assert.equal(fs.existsSync(path.join(dir, 'nested')), false);
});
