#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('node:path');

const sourcePath = path.join(__dirname, '../lib/bounded-ledger-access.js');
const targetPath = path.join(__dirname, '../../actual-tools/lib/bounded-ledger-access.js');

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

function buildVendoredBoundedLedgerAccess(source = fs.readFileSync(sourcePath, 'utf8')) {
  const digest = crypto.createHash('sha256').update(source).digest('hex');
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

  body = body.replace(
    "const { isProcessShutdownAborted } = require('./process-shutdown-abort');\n",
    'function isProcessShutdownAborted() { return false; }\n',
  );

  const header = `'use strict';
/* VENDORED from finance-dashboard/lib/bounded-ledger-access.js
 * Regenerate: node finance-dashboard/scripts/sync-bounded-ledger-vendor.js
 * Source sha256: ${digest}
 * Standalone for actual-tools — must not require finance-dashboard at runtime.
 */
`;

  return {
    content: header + body,
    digest,
    targetPath,
  };
}

function verifyVendoredBoundedLedgerAccess() {
  const { content, digest, targetPath: target } = buildVendoredBoundedLedgerAccess();
  if (!fs.existsSync(target)) {
    throw new Error(`bounded-ledger-vendor drift: missing ${target}; run node finance-dashboard/scripts/sync-bounded-ledger-vendor.js`);
  }
  const current = fs.readFileSync(target, 'utf8');
  if (current !== content) {
    throw new Error(
      `bounded-ledger-vendor drift: ${target} is out of sync with ${sourcePath} (${digest.slice(0, 12)}…); run node finance-dashboard/scripts/sync-bounded-ledger-vendor.js`,
    );
  }
  return { digest, targetPath: target };
}

function writeVendoredBoundedLedgerAccess() {
  const { content, digest, targetPath: target } = buildVendoredBoundedLedgerAccess();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  console.log(`bounded-ledger-vendor: wrote ${target} (${digest.slice(0, 12)}…)`);
}

if (require.main === module) {
  const checkOnly = process.argv.includes('--check');
  try {
    if (checkOnly) {
      const { digest, targetPath: target } = verifyVendoredBoundedLedgerAccess();
      console.log(`bounded-ledger-vendor: ok ${target} (${digest.slice(0, 12)}…)`);
    } else {
      writeVendoredBoundedLedgerAccess();
    }
  } catch (error) {
    console.error(error.message || error);
    process.exit(1);
  }
}

module.exports = {
  buildVendoredBoundedLedgerAccess,
  verifyVendoredBoundedLedgerAccess,
  writeVendoredBoundedLedgerAccess,
};
