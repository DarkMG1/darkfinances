const test = require('node:test');
const assert = require('node:assert/strict');
const { reimbursementWindowNet } = require('../src/lib/reimbursement-window-net.js');

test('reimbursementWindowNet is unavailable unless both summary legs are known', () => {
  assert.equal(reimbursementWindowNet(null), null);
  assert.equal(reimbursementWindowNet({ fronted: 10 }), null);
  assert.equal(reimbursementWindowNet({ paidBack: 5 }), null);
  assert.equal(reimbursementWindowNet({ fronted: 10, paidBack: 4 }), -6);
  assert.equal(reimbursementWindowNet({ fronted: 0, paidBack: 0 }), 0);
});

test('reimbursement screen uses window net helper and optional signed formatter', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '../src/app/reimbursement.tsx'), 'utf8');
  assert.match(source, /reimbursementWindowNet\(summary\)/);
  assert.match(source, /formatOptionalSignedMoney\(netValue, fmtSignedMoney\)/);
  assert.doesNotMatch(source, /\(summary\?\.paidBack \?\? 0\) - \(summary\?\.fronted \?\? 0\)/);
});
