#!/usr/bin/env node
const path = require('path');
const { readActualAlignment } = require('./version-alignment');

const root = path.resolve(__dirname, '..');

try {
  const actual = readActualAlignment(root);
  console.log(`version-alignment: ok (server ${actual.serverImage}, api ${actual.dashboardApi})`);
} catch (error) {
  console.error(`version-alignment: ${error.message}`);
  process.exitCode = 1;
}
