const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  ASSET_PATH,
  MANIFEST_PATH,
  pinChartJsAsset,
  readRootLockEntry,
  verifyChartJsAsset,
} = require('../scripts/chart-js-vendor');

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chart-js-vendor-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function committedVendorSnapshot() {
  return {
    asset: fs.readFileSync(ASSET_PATH),
    manifest: fs.readFileSync(MANIFEST_PATH),
  };
}

function assertCommittedVendorUnchanged(before) {
  assert.equal(fs.readFileSync(ASSET_PATH).compare(before.asset), 0, 'committed chart.umd.js changed');
  assert.equal(fs.readFileSync(MANIFEST_PATH).compare(before.manifest), 0, 'committed chart-js.manifest.json changed');
}

function copyFixtureTree(tempRoot) {
  const dashboardRoot = path.join(tempRoot, 'finance-dashboard');
  const repoRoot = tempRoot;
  fs.mkdirSync(path.join(dashboardRoot, 'public', 'vendor'), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, 'node_modules', 'chart.js', 'dist'), { recursive: true });
  fs.copyFileSync(ASSET_PATH, path.join(dashboardRoot, 'public', 'vendor', 'chart.umd.js'));
  fs.copyFileSync(MANIFEST_PATH, path.join(dashboardRoot, 'public', 'vendor', 'chart-js.manifest.json'));
  fs.copyFileSync(
    path.resolve(__dirname, '..', '..', 'package-lock.json'),
    path.join(repoRoot, 'package-lock.json'),
  );
  fs.copyFileSync(ASSET_PATH, path.join(repoRoot, 'node_modules', 'chart.js', 'dist', 'chart.umd.js'));
  fs.writeFileSync(
    path.join(repoRoot, 'node_modules', 'chart.js', 'package.json'),
    JSON.stringify({ name: 'chart.js', version: '4.4.0' }),
  );
  return { dashboardRoot, repoRoot };
}

test('verifyChartJsAsset accepts the committed vendor asset and lockfile provenance', () => {
  const manifest = verifyChartJsAsset();
  const lockEntry = readRootLockEntry();
  assert.equal(manifest.version, lockEntry.version);
  assert.equal(manifest.npmResolved, lockEntry.resolved);
  assert.equal(manifest.npmIntegrity, lockEntry.integrity);
});

test('verifyChartJsAsset rejects version drift', () => {
  withTempDir((tempRoot) => {
    const { dashboardRoot, repoRoot } = copyFixtureTree(tempRoot);
    const manifestPath = path.join(dashboardRoot, 'public', 'vendor', 'chart-js.manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.version = '4.4.1';
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    assert.throws(
      () => verifyChartJsAsset({
        manifestPath,
        assetPath: path.join(dashboardRoot, 'public', 'vendor', 'chart.umd.js'),
        lockfilePath: path.join(repoRoot, 'package-lock.json'),
      }),
      /lockfile version .* does not match manifest/,
    );
  });
});

test('verifyChartJsAsset rejects resolved URL drift', () => {
  withTempDir((tempRoot) => {
    const { dashboardRoot, repoRoot } = copyFixtureTree(tempRoot);
    const manifestPath = path.join(dashboardRoot, 'public', 'vendor', 'chart-js.manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.npmResolved = 'https://registry.npmjs.org/chart.js/-/chart.js-4.4.1.tgz';
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    assert.throws(
      () => verifyChartJsAsset({
        manifestPath,
        assetPath: path.join(dashboardRoot, 'public', 'vendor', 'chart.umd.js'),
        lockfilePath: path.join(repoRoot, 'package-lock.json'),
      }),
      /lockfile resolved URL does not match manifest npmResolved/,
    );
  });
});

test('verifyChartJsAsset rejects integrity drift', () => {
  withTempDir((tempRoot) => {
    const { dashboardRoot, repoRoot } = copyFixtureTree(tempRoot);
    const manifestPath = path.join(dashboardRoot, 'public', 'vendor', 'chart-js.manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.npmIntegrity = 'sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    assert.throws(
      () => verifyChartJsAsset({
        manifestPath,
        assetPath: path.join(dashboardRoot, 'public', 'vendor', 'chart.umd.js'),
        lockfilePath: path.join(repoRoot, 'package-lock.json'),
      }),
      /lockfile integrity does not match manifest npmIntegrity/,
    );
  });
});

test('verifyChartJsAsset rejects sha256 drift', () => {
  withTempDir((tempRoot) => {
    const { dashboardRoot, repoRoot } = copyFixtureTree(tempRoot);
    const manifestPath = path.join(dashboardRoot, 'public', 'vendor', 'chart-js.manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.sha256 = '0'.repeat(64);
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    assert.throws(
      () => verifyChartJsAsset({
        manifestPath,
        assetPath: path.join(dashboardRoot, 'public', 'vendor', 'chart.umd.js'),
        lockfilePath: path.join(repoRoot, 'package-lock.json'),
      }),
      /committed chart.js asset digest does not match manifest sha256/,
    );
  });
});

test('verifyChartJsAsset rejects byte-size drift', () => {
  withTempDir((tempRoot) => {
    const { dashboardRoot, repoRoot } = copyFixtureTree(tempRoot);
    const manifestPath = path.join(dashboardRoot, 'public', 'vendor', 'chart-js.manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.size += 1;
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    assert.throws(
      () => verifyChartJsAsset({
        manifestPath,
        assetPath: path.join(dashboardRoot, 'public', 'vendor', 'chart.umd.js'),
        lockfilePath: path.join(repoRoot, 'package-lock.json'),
      }),
      /committed chart.js asset size .* does not match manifest/,
    );
  });
});

test('verifyChartJsAsset fails on corrupted committed asset without repairing it', () => {
  const committed = committedVendorSnapshot();
  withTempDir((tempRoot) => {
    const { dashboardRoot, repoRoot } = copyFixtureTree(tempRoot);
    const manifestPath = path.join(dashboardRoot, 'public', 'vendor', 'chart-js.manifest.json');
    const assetPath = path.join(dashboardRoot, 'public', 'vendor', 'chart.umd.js');
    fs.appendFileSync(assetPath, '\n');
    assert.throws(
      () => verifyChartJsAsset({
        manifestPath,
        assetPath,
        lockfilePath: path.join(repoRoot, 'package-lock.json'),
      }),
      /committed chart.js asset (digest|size)/,
    );
  });
  assertCommittedVendorUnchanged(committed);
});

test('verifyChartJsAsset rejects dangling source map references', () => {
  const committed = committedVendorSnapshot();
  withTempDir((tempRoot) => {
    const { dashboardRoot, repoRoot } = copyFixtureTree(tempRoot);
    const manifestPath = path.join(dashboardRoot, 'public', 'vendor', 'chart-js.manifest.json');
    const assetPath = path.join(dashboardRoot, 'public', 'vendor', 'chart.umd.js');
    const original = fs.readFileSync(assetPath, 'utf8');
    assert.doesNotMatch(original, /sourceMappingURL/);
    fs.writeFileSync(assetPath, `${original}\n//# sourceMappingURL=chart.umd.js.map\n`);
    assert.throws(
      () => verifyChartJsAsset({
        manifestPath,
        assetPath,
        lockfilePath: path.join(repoRoot, 'package-lock.json'),
      }),
      /dangling source map/,
    );
  });
  assertCommittedVendorUnchanged(committed);
});

test('pinChartJsAsset rewrites manifest, notice, and asset from the installed package', () => {
  withTempDir((tempRoot) => {
    const { dashboardRoot, repoRoot } = copyFixtureTree(tempRoot);
    const manifestPath = path.join(dashboardRoot, 'public', 'vendor', 'chart-js.manifest.json');
    const assetPath = path.join(dashboardRoot, 'public', 'vendor', 'chart.umd.js');
    const noticePath = path.join(dashboardRoot, 'public', 'vendor', 'THIRD-PARTY-NOTICES.txt');
    fs.rmSync(manifestPath);
    fs.rmSync(assetPath);
    const manifest = pinChartJsAsset({
      manifestPath,
      assetPath,
      noticePath,
      lockfilePath: path.join(repoRoot, 'package-lock.json'),
      sourcePath: path.join(repoRoot, 'node_modules', 'chart.js', 'dist', 'chart.umd.js'),
      dashboardRoot,
      repoRoot,
    });
    assert.equal(fs.existsSync(noticePath), true);
    assert.match(fs.readFileSync(noticePath, 'utf8'), /chart\.js 4\.4\.0 \(MIT\)/);
    verifyChartJsAsset({
      manifestPath,
      assetPath,
      lockfilePath: path.join(repoRoot, 'package-lock.json'),
      requireInstalledPackage: true,
      sourcePath: path.join(repoRoot, 'node_modules', 'chart.js', 'dist', 'chart.umd.js'),
      dashboardRoot,
      repoRoot,
    });
    assert.equal(manifest.npmIntegrity, readRootLockEntry(path.join(repoRoot, 'package-lock.json')).integrity);
  });
});
