#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { buildBrowserManifest, expectedManifestAssetPaths } = require('../lib/browser-static');

const manifestPath = path.resolve(__dirname, '..', 'public', 'browser-manifest.json');

function verifyBrowserManifest({ write = false } = {}) {
  const built = buildBrowserManifest();
  if (!fs.existsSync(manifestPath)) {
    if (!write) throw new Error('public/browser-manifest.json is missing');
    fs.writeFileSync(manifestPath, `${JSON.stringify(built, null, 2)}\n`);
    return built;
  }
  const committed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const same = committed.version === built.version
    && JSON.stringify(committed.modules) === JSON.stringify(built.modules)
    && JSON.stringify(committed.pages) === JSON.stringify(built.pages)
    && JSON.stringify(committed.vendor) === JSON.stringify(built.vendor)
    && JSON.stringify(committed.stylesheets) === JSON.stringify(built.stylesheets)
    && JSON.stringify(committed.meta) === JSON.stringify(built.meta)
    && JSON.stringify(committed.digests) === JSON.stringify(built.digests)
    && JSON.stringify(Object.keys(committed.digests).sort())
      === JSON.stringify(expectedManifestAssetPaths(committed));
  if (!same) {
    if (write) {
      fs.writeFileSync(manifestPath, `${JSON.stringify(built, null, 2)}\n`);
      return built;
    }
    throw new Error('public/browser-manifest.json is stale; regenerate browser assets or update the manifest');
  }
  return committed;
}

function main() {
  try {
    const manifest = verifyBrowserManifest({ write: process.argv.includes('--write') });
    console.log(`browser-manifest: ok (${manifest.modules.length} modules, version ${manifest.version})`);
  } catch (error) {
    console.error(`browser-manifest: ${error.message}`);
    process.exit(1);
  }
}

if (require.main === module) main();
module.exports = { verifyBrowserManifest };
