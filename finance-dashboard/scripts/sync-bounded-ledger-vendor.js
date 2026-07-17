#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('node:path');

const sourcePath = path.join(__dirname, '../lib/bounded-ledger-access.js');
const targetPath = path.join(__dirname, '../../actual-tools/lib/bounded-ledger-access.js');
const source = fs.readFileSync(sourcePath, 'utf8');
const digest = crypto.createHash('sha256').update(source).digest('hex');

const STUB_LOAD_LEDGER = `async function loadLedgerReadContext(api, {
  accountFilter,
  includeClosed = true,
} = {}) {
  const accountsRaw = await api.getAccounts();
  let accounts = accountsRaw;
  if (typeof accountFilter === 'function') accounts = accounts.filter(accountFilter);
  else if (!includeClosed) accounts = accounts.filter((a) => !a.closed);
  return { accounts, accountsRaw };
}`;

function replaceBetween(text, startMarker, endMarker, replacement) {
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker, start);
  if (start < 0 || end < 0) {
    throw new Error(`sync-bounded-ledger-vendor: markers not found (${startMarker} -> ${endMarker})`);
  }
  return `${text.slice(0, start)}${replacement}\n\n${text.slice(end)}`;
}

let body = source
  .replace(/^'use strict';\n/, '')
  .replace("require('./errors')", "require('./query-errors')")
  .replace(/\nconst \{ buildCategoryInfo \} = require\('\.\/domain\/classification'\);\n/, '\n')
  .replace(/\nconst DEFAULT_CLASSIFICATION_PATTERNS = Object\.freeze\([\s\S]*?\);\n\n/, '\n');

body = replaceBetween(
  body,
  'async function loadLedgerReadContext',
  'function normalizePayeeKey',
  STUB_LOAD_LEDGER,
);

body = body.replace(/\n {2}DEFAULT_CLASSIFICATION_PATTERNS,\n/, '\n');

const header = `'use strict';
/* VENDORED from finance-dashboard/lib/bounded-ledger-access.js
 * Regenerate: node finance-dashboard/scripts/sync-bounded-ledger-vendor.js
 * Source sha256: ${digest}
 * Standalone for actual-tools — must not require finance-dashboard at runtime.
 */
`;

fs.mkdirSync(path.dirname(targetPath), { recursive: true });
fs.writeFileSync(targetPath, header + body);
console.log(`bounded-ledger-vendor: wrote ${targetPath} (${digest.slice(0, 12)}…)`);
