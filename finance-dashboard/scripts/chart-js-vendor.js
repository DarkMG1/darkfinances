const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DASHBOARD_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.join(DASHBOARD_ROOT, '..');
const MANIFEST_PATH = path.join(DASHBOARD_ROOT, 'public', 'vendor', 'chart-js.manifest.json');
const ASSET_PATH = path.join(DASHBOARD_ROOT, 'public', 'vendor', 'chart.umd.js');
const NOTICE_PATH = path.join(DASHBOARD_ROOT, 'public', 'vendor', 'THIRD-PARTY-NOTICES.txt');
const LOCKFILE_PACKAGE = 'node_modules/chart.js';
const SOURCE_RELATIVE = 'dist/chart.umd.js';

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function loadManifest(manifestPath = MANIFEST_PATH) {
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

function readRootLockEntry(lockfilePath = path.join(REPO_ROOT, 'package-lock.json')) {
  const lockfile = JSON.parse(fs.readFileSync(lockfilePath, 'utf8'));
  const entry = lockfile.packages?.[LOCKFILE_PACKAGE];
  if (!entry) {
    throw new Error(`lockfile entry missing for ${LOCKFILE_PACKAGE}`);
  }
  return entry;
}

function resolveInstalledSourcePath() {
  try {
    const entryPath = require.resolve('chart.js', { paths: [DASHBOARD_ROOT, REPO_ROOT] });
    return path.join(path.dirname(entryPath), '..', SOURCE_RELATIVE);
  } catch {
    return null;
  }
}

function assertManifestShape(manifest) {
  for (const key of [
    'package',
    'version',
    'lockfilePath',
    'lockfilePackage',
    'npmResolved',
    'npmIntegrity',
    'sourcePath',
    'assetPath',
    'sha256',
    'size',
    'license',
  ]) {
    if (manifest[key] == null || manifest[key] === '') {
      throw new Error(`chart.js manifest missing ${key}`);
    }
  }
}

function verifyChartJsAsset({
  manifestPath = MANIFEST_PATH,
  assetPath = ASSET_PATH,
  lockfilePath = path.join(REPO_ROOT, 'package-lock.json'),
  requireInstalledPackage = false,
} = {}) {
  const manifest = loadManifest(manifestPath);
  assertManifestShape(manifest);

  const lockEntry = readRootLockEntry(lockfilePath);
  if (lockEntry.version !== manifest.version) {
    throw new Error(`lockfile version ${lockEntry.version} does not match manifest ${manifest.version}`);
  }
  if (lockEntry.resolved !== manifest.npmResolved) {
    throw new Error(`lockfile resolved URL does not match manifest npmResolved`);
  }
  if (lockEntry.integrity !== manifest.npmIntegrity) {
    throw new Error(`lockfile integrity does not match manifest npmIntegrity`);
  }
  if (manifest.lockfilePath !== 'package-lock.json') {
    throw new Error(`manifest lockfilePath must be package-lock.json`);
  }
  if (manifest.lockfilePackage !== LOCKFILE_PACKAGE) {
    throw new Error(`manifest lockfilePackage must be ${LOCKFILE_PACKAGE}`);
  }

  if (!fs.existsSync(assetPath)) {
    throw new Error(`committed chart.js asset missing at ${manifest.assetPath}`);
  }

  const asset = fs.readFileSync(assetPath);
  const assetDigest = sha256Buffer(asset);
  if (asset.length !== manifest.size) {
    throw new Error(`committed chart.js asset size ${asset.length} does not match manifest ${manifest.size}`);
  }
  if (assetDigest !== manifest.sha256) {
    throw new Error(`committed chart.js asset digest does not match manifest sha256`);
  }

  const installedSourcePath = resolveInstalledSourcePath();
  if (installedSourcePath) {
    if (!fs.existsSync(installedSourcePath)) {
      throw new Error(`installed chart.js source missing at ${manifest.sourcePath}`);
    }
    const installedPackageJson = JSON.parse(
      fs.readFileSync(path.join(path.dirname(installedSourcePath), '..', 'package.json'), 'utf8'),
    );
    if (installedPackageJson.version !== manifest.version) {
      throw new Error(
        `installed chart.js version ${installedPackageJson.version} does not match manifest ${manifest.version}`,
      );
    }
    const installedDigest = sha256File(installedSourcePath);
    if (installedDigest !== manifest.sha256) {
      throw new Error('installed chart.js source digest does not match manifest sha256');
    }
    if (fs.statSync(installedSourcePath).size !== manifest.size) {
      throw new Error('installed chart.js source size does not match manifest size');
    }
  } else if (requireInstalledPackage) {
    throw new Error('chart.js package is not installed');
  }

  return manifest;
}

function buildNotice(manifest) {
  return [
    'Third-party browser runtime assets',
    '',
    `${manifest.package} ${manifest.version} (MIT)`,
    `Source tarball: ${manifest.npmResolved}`,
    `Pinned SHA-256: ${manifest.sha256}`,
    '',
    'Copyright (c) 2014-2022 Chart.js Contributors',
    '',
    'Permission is hereby granted, free of charge, to any person obtaining a copy',
    'of this software and associated documentation files (the "Software"), to deal',
    'in the Software without restriction, including without limitation the rights',
    'to use, copy, modify, merge, publish, distribute, sublicense, and/or sell',
    'copies of the Software, and to permit persons to whom the Software is',
    'furnished to do so, subject to the following conditions:',
    '',
    'The above copyright notice and this permission notice shall be included in all',
    'copies or substantial portions of the Software.',
    '',
  ].join('\n');
}

function pinChartJsAsset({
  manifestPath = MANIFEST_PATH,
  assetPath = ASSET_PATH,
  lockfilePath = path.join(REPO_ROOT, 'package-lock.json'),
  noticePath = NOTICE_PATH,
} = {}) {
  const lockEntry = readRootLockEntry(lockfilePath);
  const installedSourcePath = resolveInstalledSourcePath();
  if (!installedSourcePath || !fs.existsSync(installedSourcePath)) {
    throw new Error('chart.js must be installed before pinning the browser asset');
  }

  const packageJson = JSON.parse(
    fs.readFileSync(path.join(path.dirname(installedSourcePath), '..', 'package.json'), 'utf8'),
  );
  if (packageJson.version !== lockEntry.version) {
    throw new Error('installed chart.js version does not match lockfile entry');
  }

  const digest = sha256File(installedSourcePath);
  const size = fs.statSync(installedSourcePath).size;
  const manifest = {
    package: 'chart.js',
    version: lockEntry.version,
    license: 'MIT',
    lockfilePath: 'package-lock.json',
    lockfilePackage: LOCKFILE_PACKAGE,
    npmResolved: lockEntry.resolved,
    npmIntegrity: lockEntry.integrity,
    sourcePath: 'node_modules/chart.js/dist/chart.umd.js',
    assetPath: 'public/vendor/chart.umd.js',
    sha256: digest,
    size,
  };

  fs.mkdirSync(path.dirname(assetPath), { recursive: true });
  fs.copyFileSync(installedSourcePath, assetPath);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(noticePath, `${buildNotice(manifest)}\n`);
  verifyChartJsAsset({ manifestPath, assetPath, lockfilePath, requireInstalledPackage: true });
  return manifest;
}

module.exports = {
  ASSET_PATH,
  DASHBOARD_ROOT,
  LOCKFILE_PACKAGE,
  MANIFEST_PATH,
  NOTICE_PATH,
  REPO_ROOT,
  assertManifestShape,
  buildNotice,
  loadManifest,
  pinChartJsAsset,
  readRootLockEntry,
  resolveInstalledSourcePath,
  sha256Buffer,
  sha256File,
  verifyChartJsAsset,
};
