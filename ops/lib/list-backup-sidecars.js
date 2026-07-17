#!/usr/bin/env node
'use strict';

const { sidecarFilenames } = require('./backup-bundle-inventory');

for (const filename of sidecarFilenames()) {
  process.stdout.write(`${filename}\n`);
}
