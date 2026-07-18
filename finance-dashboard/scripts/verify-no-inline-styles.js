#!/usr/bin/env node
const { verifyNoInlineBrowserStyles } = require('../lib/browser-style-policy');

function main() {
  try {
    verifyNoInlineBrowserStyles();
    console.log('browser-style-policy: ok (no inline style attributes or CSSOM assignments)');
  } catch (error) {
    console.error(`browser-style-policy: ${error.message}`);
    process.exit(1);
  }
}

if (require.main === module) main();
module.exports = { verifyNoInlineBrowserStyles };
