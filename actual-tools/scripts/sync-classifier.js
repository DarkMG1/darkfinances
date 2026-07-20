#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const toolsRoot = path.resolve(__dirname, '..');
const sourcePath = path.resolve(toolsRoot, '..', 'finance-dashboard', 'lib', 'domain', 'classification.js');
const vendorPath = path.join(toolsRoot, 'vendor', 'classification.js');
const digestPath = path.join(toolsRoot, 'vendor', 'classification.digest.json');

function main() {
  const source = fs.readFileSync(sourcePath, 'utf8');
  const digest = crypto.createHash('sha256').update(source).digest('hex');
  fs.mkdirSync(path.dirname(vendorPath), { recursive: true });
  const banner = `'use strict';\n/* Vendored from finance-dashboard/lib/domain/classification.js — do not edit by hand. */\n`;
  fs.writeFileSync(vendorPath, banner + source.replace(/^'use strict';\n?/, ''));
  fs.writeFileSync(digestPath, `${JSON.stringify({
    source: 'finance-dashboard/lib/domain/classification.js',
    sha256: digest,
    syncedAt: new Date().toISOString(),
  }, null, 2)}\n`);
  console.log(`sync-classifier: wrote vendor artifact (${digest.slice(0, 12)}…)`);
}

main();
