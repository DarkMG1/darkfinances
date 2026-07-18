'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  buildVendoredBoundedLedgerAccess,
  verifyVendoredBoundedLedgerAccess,
} = require('../scripts/sync-bounded-ledger-vendor');

test('bounded-ledger vendor check passes when canonical and vendored copies match', () => {
  assert.doesNotThrow(() => verifyVendoredBoundedLedgerAccess());
});

test('bounded-ledger vendor check fails on tamper without auto-repair', () => {
  const targetPath = path.join(__dirname, '../../actual-tools/lib/bounded-ledger-access.js');
  const original = fs.readFileSync(targetPath, 'utf8');
  fs.writeFileSync(targetPath, `${original}\n// tampered`);
  try {
    assert.throws(
      () => verifyVendoredBoundedLedgerAccess(),
      /bounded-ledger-vendor drift/,
    );
    assert.equal(fs.readFileSync(targetPath, 'utf8').includes('// tampered'), true);
  } finally {
    fs.writeFileSync(targetPath, original);
  }
});

test('bounded-ledger vendor builder embeds source digest in header', () => {
  const sourcePath = path.join(__dirname, '../lib/bounded-ledger-access.js');
  const source = fs.readFileSync(sourcePath, 'utf8');
  const { content, digest } = buildVendoredBoundedLedgerAccess(source);
  assert.match(content, new RegExp(`Source sha256: ${digest}`));
  assert.ok(!content.includes("require('../finance-dashboard"));
});
