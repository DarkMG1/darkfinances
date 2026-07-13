#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { contractFingerprint } = require('./contract-fingerprint');

const root = path.resolve(__dirname, '..');
const stampPath = path.join(root, 'finance-app', 'src', 'api', 'generated', '.contract-fingerprint');
const fingerprint = contractFingerprint();

fs.mkdirSync(path.dirname(stampPath), { recursive: true });
fs.writeFileSync(stampPath, `${fingerprint}\n`);
console.log(`contract-fingerprint: updated ${fingerprint}`);
