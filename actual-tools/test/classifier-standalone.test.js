'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const toolsRoot = path.resolve(__dirname, '..');
const sourcePath = path.resolve(toolsRoot, '..', 'finance-dashboard', 'lib', 'domain', 'classification.js');

test('verify-classifier passes for synced vendor artifact', () => {
  const result = spawnSync(process.execPath, [path.join(toolsRoot, 'scripts', 'verify-classifier.js')], {
    cwd: toolsRoot,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('vendor classifier matches dashboard parity on mutual pair', () => {
  const dashboard = require(sourcePath);
  const vendor = require(path.join(toolsRoot, 'vendor', 'classification'));
  const rows = [
    { transaction: { id: 'a', amount: -50000, transfer_id: 'b' }, accountId: 'checking' },
    { transaction: { id: 'b', amount: 50000, transfer_id: 'a' }, accountId: 'savings' },
  ];
  const patterns = {
    incomeGroup: /^income$/i,
    moneyMovementGroup: /money movement/i,
    moneyMovementCategory: /^transfer$/i,
    reimbursementCategory: /^reimbursement$/i,
  };
  const groups = [
    { name: 'Spending', categories: [{ id: 'food', name: 'Food' }] },
    { name: 'Money Movement', categories: [{ id: 'transfer', name: 'Transfer' }] },
  ];
  const catInfo = dashboard.buildCategoryInfo(groups, patterns);
  const index = dashboard.buildTransferIndex(rows);
  const dash = dashboard.classifyTransactionLeaves(rows[0].transaction, catInfo, { accountId: 'checking', transferIndex: index })[0];
  const vend = vendor.classifyTransactionLeaves(rows[0].transaction, catInfo, { accountId: 'checking', transferIndex: index })[0];
  assert.deepEqual({ kind: dash.kind, reason: dash.reason }, { kind: vend.kind, reason: vend.reason });
});

test('standalone copied-tree executes without finance-dashboard require', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'actual-tools-standalone-'));
  fs.cpSync(toolsRoot, tmp, { recursive: true });
  const copiedLib = fs.readFileSync(path.join(tmp, 'lib', 'transfer-classification.js'), 'utf8');
  assert.doesNotMatch(copiedLib, /finance-dashboard/);
  const result = spawnSync('npm', ['run', 'verify:classifier'], { cwd: tmp, encoding: 'utf8', shell: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const digest = JSON.parse(fs.readFileSync(path.join(tmp, 'vendor', 'classification.digest.json'), 'utf8'));
  const source = fs.readFileSync(sourcePath, 'utf8');
  assert.equal(digest.sha256, crypto.createHash('sha256').update(source).digest('hex'));
  fs.rmSync(tmp, { recursive: true, force: true });
});
