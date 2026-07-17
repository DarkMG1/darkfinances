#!/usr/bin/env node
const { verifyChartJsAsset } = require('./chart-js-vendor');

function main() {
  try {
    const manifest = verifyChartJsAsset();
    console.log(
      `chart-js-verify: ok (${manifest.version}, ${manifest.sha256.slice(0, 12)}…, read-only)`,
    );
  } catch (error) {
    console.error(`chart-js-verify: ${error.message}`);
    process.exit(1);
  }
}

if (require.main === module) main();
