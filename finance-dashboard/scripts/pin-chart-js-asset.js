#!/usr/bin/env node
const { pinChartJsAsset } = require('./chart-js-vendor');

function main() {
  try {
    const manifest = pinChartJsAsset();
    console.log(
      `chart-js-pin: wrote ${manifest.assetPath} (${manifest.version}, ${manifest.sha256.slice(0, 12)}…)`,
    );
  } catch (error) {
    console.error(`chart-js-pin: ${error.message}`);
    process.exit(1);
  }
}

if (require.main === module) main();
