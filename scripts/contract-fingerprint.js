const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const defaultRoot = path.resolve(__dirname, '..');

function contractFingerprint(root = defaultRoot) {
  const validation = fs.readFileSync(path.join(root, 'finance-dashboard', 'lib', 'validation.js'), 'utf8');
  const endpoints = fs.readFileSync(path.join(root, 'finance-app', 'src', 'api', 'generated', 'endpoints.ts'), 'utf8');
  const types = fs.readFileSync(path.join(root, 'finance-app', 'src', 'api', 'generated', 'types.ts'), 'utf8');
  const hash = crypto.createHash('sha256');
  hash.update(validation);
  hash.update('\0');
  hash.update(endpoints);
  hash.update('\0');
  hash.update(types);
  return hash.digest('hex').slice(0, 16);
}

module.exports = { contractFingerprint };
