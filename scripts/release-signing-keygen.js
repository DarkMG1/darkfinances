#!/usr/bin/env node
'use strict';

const {
  generateSigningMaterial,
  writeKeyMaterialAtomic,
} = require('../finance-dashboard/lib/release-signing');

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
      continue;
    }
    const separator = arg.indexOf('=');
    const flag = arg.slice(2, separator === -1 ? undefined : separator);
    const inlineValue = separator === -1 ? undefined : arg.slice(separator + 1);
    if (flag === 'output-dir') {
      const value = inlineValue ?? argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error('--output-dir requires a value');
      if (inlineValue === undefined) index += 1;
      parsed.outputDir = value;
      continue;
    }
    throw new Error(`unknown option: ${arg}`);
  }
  return parsed;
}

function helpText() {
  return [
    'Usage: release-signing-keygen.js --output-dir=<directory>',
    '',
    'Creates release-signing-key.json and release-keyring.json atomically in a new directory.',
    'Refuses non-empty output directories. Prints the generated keyId to stdout.',
    '',
  ].join('\n');
}

function main(argv = process.argv.slice(2), io = process) {
  try {
    const parsed = parseArgs(argv);
    if (parsed.help) {
      io.stdout.write(helpText());
      return 0;
    }
    if (!parsed.outputDir) throw new Error('--output-dir is required');
    const material = generateSigningMaterial();
    writeKeyMaterialAtomic(parsed.outputDir, material);
    io.stdout.write(`${material.keyId}\n`);
    return 0;
  } catch (error) {
    io.stderr.write(`release-signing-keygen: ${error.message}\n`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main();
module.exports = { main, parseArgs };
