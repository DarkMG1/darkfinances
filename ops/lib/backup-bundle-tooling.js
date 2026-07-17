'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

const OPS_TOOLING_FILES = Object.freeze([
  'ops/lib/backup-bundle-schema.js',
  'ops/lib/backup-bundle-inventory.js',
  'ops/lib/backup-bundle-tar-listing.js',
  'ops/lib/backup-bundle-verify.js',
  'ops/lib/build-backup-bundle.js',
  'ops/lib/backup-bundle-manifest.js',
  'ops/lib/backup-state-inventory.json',
  'ops/lib/backup-verify.js',
  'ops/lib/list-backup-sidecars.js',
  'ops/lib/list-backup-runtime-members.js',
  'ops/lib/verify-backup-bundle-standalone.js',
  'ops/lib/generation-binding-artifact.js',
  'ops/lib/restore-instance-lock.js',
  'ops/lib/restore-control-layout.js',
  'ops/lib/restore-durable-io.js',
  'ops/lib/restore-snapshot.js',
  'ops/lib/restore-generation-binding.js',
  'ops/lib/restore-quiescence-admission.js',
  'ops/lib/staged-restore.js',
  'ops/lib/staged-restore-cli.js',
  'ops/lib/writer-inventory.js',
  'ops/lib/writer-inventory.json',
  'ops/lib/coordinated-operation-layout.js',
  'ops/lib/coordinated-operation-lock.js',
  'ops/lib/coordinated-run-journal.js',
  'ops/lib/ops-command-runners.js',
  'ops/lib/writer-quiescence.js',
  'ops/lib/coordinated-backup-health.js',
  'ops/lib/coordinated-backup.js',
  'ops/lib/coordinated-backup-cli.js',
  'ops/lib/coordinated-admission-crypto.js',
  'ops/lib/coordinated-admission-registry.js',
  'ops/lib/coordinated-journal-binding.js',
  'ops/lib/coordinated-restore.js',
  'ops/lib/coordinated-restore-cli.js',
]);

const DASHBOARD_TOOLING_SEED = 'finance-dashboard/lib/runtime-state-store.js';

function resolveRequireTarget(baseFile, request) {
  let target = path.normalize(path.join(path.dirname(baseFile), request));
  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
    target = path.join(target, 'index.js');
  } else if (!fs.existsSync(target) && fs.existsSync(`${target}.js`)) {
    target = `${target}.js`;
  }
  return target;
}

function collectLibClosure(seedAbsPaths) {
  const seen = new Set();
  const queue = [...seedAbsPaths];
  while (queue.length > 0) {
    const abs = queue.shift();
    if (!abs.startsWith(REPO_ROOT) || !fs.existsSync(abs)) continue;
    const rel = path.relative(REPO_ROOT, abs).replace(/\\/g, '/');
    if (seen.has(rel)) continue;
    seen.add(rel);
    const src = fs.readFileSync(abs, 'utf8');
    for (const match of src.matchAll(/require\(['"](\.\.?\/[^'"]+)['"]\)/g)) {
      queue.push(resolveRequireTarget(abs, match[1]));
    }
  }
  return [...seen].sort();
}

function dashboardToolingFiles() {
  const seed = path.join(REPO_ROOT, DASHBOARD_TOOLING_SEED);
  return collectLibClosure([seed]).filter((rel) => rel.startsWith('finance-dashboard/lib/'));
}

function bundleToolingSourcePaths() {
  const opsAbs = OPS_TOOLING_FILES.map((rel) => path.join(REPO_ROOT, rel));
  const opsClosure = collectLibClosure(opsAbs).filter((rel) => (
    rel.startsWith('ops/lib/')
    || rel.startsWith('ops/bin/')
    || OPS_TOOLING_FILES.includes(rel)
  ));
  return [...new Set([...OPS_TOOLING_FILES, ...opsClosure, ...dashboardToolingFiles()])].sort();
}

function bundleDestinationRelative(sourceRelative) {
  if (sourceRelative === 'ops/lib/verify-backup-bundle-standalone.js') {
    return 'tooling/ops/bin/verify-backup-bundle.js';
  }
  if (sourceRelative === 'ops/lib/staged-restore-cli.js') {
    return 'tooling/ops/bin/restore-dashboard-runtime.js';
  }
  if (sourceRelative === 'ops/lib/coordinated-restore-cli.js') {
    return 'tooling/ops/bin/restore-coordinated.js';
  }
  if (sourceRelative === 'ops/lib/coordinated-backup-cli.js') {
    return 'tooling/ops/bin/backup-coordinated.js';
  }
  return path.posix.join('tooling', sourceRelative);
}

function copyBundleTooling({ sourceRoot = REPO_ROOT, destinationRoot }) {
  const copied = [];
  for (const sourceRelative of bundleToolingSourcePaths()) {
    const source = path.join(sourceRoot, sourceRelative);
    const destinationRelative = bundleDestinationRelative(sourceRelative);
    const destination = path.join(destinationRoot, destinationRelative);
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    fs.copyFileSync(source, destination);
    fs.chmodSync(destination, 0o600);
    copied.push(destinationRelative.replace(/\\/g, '/'));
  }
  return copied.sort();
}

module.exports = {
  OPS_TOOLING_FILES,
  DASHBOARD_TOOLING_SEED,
  dashboardToolingFiles,
  bundleToolingSourcePaths,
  bundleDestinationRelative,
  copyBundleTooling,
};
