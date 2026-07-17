#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const toolsRoot = path.resolve(__dirname, '..');
const vendorPath = path.join(toolsRoot, 'vendor', 'classification.js');
const digestPath = path.join(toolsRoot, 'vendor', 'classification.digest.json');

function fail(message) {
  console.error(`verify-classifier: ${message}`);
  process.exit(1);
}

if (!fs.existsSync(vendorPath)) fail('vendor/classification.js missing');
if (!fs.existsSync(digestPath)) fail('vendor/classification.digest.json missing');

const digest = JSON.parse(fs.readFileSync(digestPath, 'utf8'));
const vendorRaw = fs.readFileSync(vendorPath, 'utf8');
const vendorBody = vendorRaw.replace(/^[\s\S]*?\*\/\n/, '');
if (!vendorBody.trim()) fail('vendor/classification.js body is empty');
const canonicalSource = `'use strict';\n${vendorBody}`;
const current = crypto.createHash('sha256').update(canonicalSource).digest('hex');
if (current !== digest.sha256) {
  fail(`vendor classifier drift (expected ${digest.sha256}, current ${current}). Run npm run sync:classifier`);
}
console.log(`verify-classifier: ok (${current.slice(0, 12)}…)`);
