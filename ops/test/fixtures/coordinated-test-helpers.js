'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const { exportPublicKeyPem, exportPrivateKeyPem } = require('../../lib/coordinated-admission-crypto');
const { buildTestAdmissionToken, registerTestAdmission } = require('./admission-token-fixtures');
const { coordinatedLayoutForRoot } = require('../../lib/coordinated-operation-layout');
const { createMockRunners } = require('./coordinated-backup-fixtures');

function quiescedUnits() {
  return {
    'finance-dashboard.service': { active: 'inactive', enabled: 'enabled' },
    'actual-sync.timer': { active: 'inactive', enabled: 'enabled' },
    'actual-sync.service': { active: 'inactive', enabled: 'enabled' },
  };
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function installFakeSystemctl(root, units = {}) {
  const fakeBin = path.join(root, 'bin');
  fs.mkdirSync(fakeBin, { recursive: true, mode: 0o700 });
  const activeCases = Object.entries(units).map(([unit, entry]) => (
    `      ${shellEscape(unit)}) state=${shellEscape(entry.active || 'inactive')} ;;`
  )).join('\n');
  const enabledCases = Object.entries(units).map(([unit, entry]) => (
    `      ${shellEscape(unit)}) state=${shellEscape(entry.enabled || 'disabled')} ;;`
  )).join('\n');
  fs.writeFileSync(path.join(fakeBin, 'systemctl'), `#!/bin/sh
unit="\${@##* }"
case " $* " in
  *" is-active "*)
    state=inactive
    case "$unit" in
${activeCases}
      *) state=inactive ;;
    esac
    printf '%s' "$state"
    case "$state" in active|activating) exit 0;; *) exit 3;; esac
    ;;
  *" is-enabled "*)
    state=disabled
    case "$unit" in
${enabledCases}
      *) state=disabled ;;
    esac
    printf '%s' "$state"
    exit 0
    ;;
  *" list-units "*|*" stop "*|*" start "*)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`, { mode: 0o755 });
  return fakeBin;
}

function writeTrustedAdmissionToken(layout, token, filename = 'quiescence-admission.json') {
  fs.mkdirSync(layout.workRoot, { recursive: true, mode: 0o700 });
  const tokenPath = path.join(layout.workRoot, filename);
  fs.writeFileSync(tokenPath, `${JSON.stringify(token, null, 2)}\n`, { mode: 0o600 });
  return tokenPath;
}

function isMutatingCommand(cmd) {
  const [bin, ...rest] = cmd;
  if (bin === 'systemctl' && rest.some((arg) => arg === 'stop' || arg === 'start')) return true;
  if (bin === 'docker' && (rest[0] === 'compose' || rest[0] === 'update')) return true;
  if (bin === 'tar') return true;
  return false;
}

function assertPreviewOnlyCommands(commands, message = 'preview must not run mutating commands') {
  for (const cmd of commands) {
    assert.equal(isMutatingCommand(cmd), false, `${message}: ${cmd.join(' ')}`);
  }
}

function installTestCoordinatorKeys(root, keyPair = null) {
  const { generateTestKeyPair } = require('../../lib/coordinated-admission-crypto');
  const pair = keyPair || generateTestKeyPair();
  const configDir = path.join(root, '.config', 'darkfinances');
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const privatePath = path.join(configDir, 'coordinated-sign.pem');
  const publicPath = path.join(configDir, 'coordinated-verify.pem');
  fs.writeFileSync(privatePath, exportPrivateKeyPem(pair.privateKey), { mode: 0o600 });
  fs.writeFileSync(publicPath, exportPublicKeyPem(pair.publicKey), { mode: 0o600 });
  return { pair, privatePath, publicPath };
}

function signedAdmissionEnv(root, {
  destination,
  archivePath,
  coordinatorRoot = path.join(root, 'backups'),
  bindings = {},
  keyPair = null,
  writers = {},
} = {}) {
  const keys = installTestCoordinatorKeys(root, keyPair);
  const layout = coordinatedLayoutForRoot(coordinatorRoot);
  fs.mkdirSync(layout.controlRoot, { recursive: true, mode: 0o700 });
  const { token } = buildTestAdmissionToken({
    keyPair: keys.pair,
    bindings: {
      archiveSha256: require('../../lib/backup-verify').sha256File(archivePath),
      destinationRoot: path.resolve(destination),
      manifestArtifactId: bindings.manifestArtifactId || 'a'.repeat(64),
      releaseManifestDigest: bindings.releaseManifestDigest || 'b'.repeat(64),
      coordinatedManifestDigest: bindings.coordinatedManifestDigest || 'c'.repeat(64),
      writerInventoryDigest: bindings.writerInventoryDigest || 'd'.repeat(64),
      actualDataGeneration: bindings.actualDataGeneration ?? null,
    },
    writers,
  });
  registerTestAdmission(layout, token);
  const tokenPath = writeTrustedAdmissionToken(layout, token);
  const fakeBin = installFakeSystemctl(root, quiescedUnits());
  return {
    env: {
      ...process.env,
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`,
      RESTORE_QUIESCENCE_ADMISSION_PATH: tokenPath,
      COORDINATED_VERIFY_KEY_PATH: keys.publicPath,
      COORDINATED_SIGNING_KEY_PATH: keys.privatePath,
      DARKFINANCES_BACKUP_DIR: coordinatorRoot,
    },
    token,
    layout,
    keys,
  };
}

function restoreDrillContext(root, destination, archivePath, extra = {}) {
  const {
    PATH: _ignoredPath,
    runners: injectedRunners,
    units: unitOverrides,
    keyPair,
    coordinatorRoot: coordinatorOverride,
    ...safeExtra
  } = extra;
  const keys = installTestCoordinatorKeys(root, keyPair);
  const coordinatorRoot = coordinatorOverride || path.join(root, 'backups');
  const layout = coordinatedLayoutForRoot(coordinatorRoot);
  fs.mkdirSync(layout.controlRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(layout.workRoot, { recursive: true, mode: 0o700 });
  const { sha256File } = require('../../lib/backup-verify');
  const { readManifestFromArchive } = require('../../lib/backup-bundle-verify');
  const { loadWriterInventory, writerInventoryDigest } = require('../../lib/writer-inventory');
  const archiveSha256 = sha256File(archivePath);
  const manifest = readManifestFromArchive(archivePath);
  const gen = manifest.generationBinding || {};
  const manifestArtifactId = safeExtra.manifestArtifactId || manifest.artifact.id;
  const releaseManifestDigest = safeExtra.releaseManifestDigest
    ?? gen.releaseManifestDigest
    ?? gen.dashboardStateId;
  const { token } = buildTestAdmissionToken({
    keyPair: keys.pair,
    bindings: {
      archiveSha256,
      destinationRoot: path.resolve(destination),
      manifestArtifactId,
      releaseManifestDigest,
      coordinatedManifestDigest: safeExtra.coordinatedManifestDigest ?? gen.dashboardStateId,
      writerInventoryDigest: safeExtra.writerInventoryDigest ?? writerInventoryDigest(loadWriterInventory()),
      actualDataGeneration: safeExtra.actualDataGeneration ?? gen.actualDataGeneration ?? null,
    },
  });
  registerTestAdmission(layout, token);
  const tokenPath = path.join(layout.workRoot, 'quiescence-admission.json');
  fs.writeFileSync(tokenPath, `${JSON.stringify(token, null, 2)}\n`, { mode: 0o600 });
  const units = unitOverrides || quiescedUnits();
  const fakeBin = installFakeSystemctl(root, units);
  const runners = injectedRunners || createMockRunners({ units });
  const env = {
    ...process.env,
    ...safeExtra,
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`,
    RESTORE_QUIESCENCE_ADMISSION_PATH: tokenPath,
    COORDINATED_VERIFY_KEY_PATH: keys.publicPath,
    COORDINATED_SIGNING_KEY_PATH: keys.privatePath,
    DARKFINANCES_BACKUP_DIR: coordinatorRoot,
  };
  const inventory = loadWriterInventory();
  const writers = require('../../lib/writer-inventory').enumerateWriters(inventory, env);
  const writerContext = {
    inventory,
    env,
    runners,
    writers,
    dashboardDir: destination,
    allowOwnRestoreLock: true,
  };
  const snapshotsById = new Map(writers.map((writer) => [
    writer.id,
    require('../../lib/writer-quiescence').captureWriterState(writer, writerContext),
  ]));
  return {
    env,
    runners,
    coordinatorRoot,
    layout,
    keys,
    token,
    tokenPath,
    coordinatedSession: {
      layout,
      runId: token.runId,
      journalId: token.journalId,
      snapshotsById,
      context: writerContext,
      privateKey: keys.pair.privateKey,
      writerInventoryDigest: writerInventoryDigest(inventory),
    },
  };
}

module.exports = {
  installFakeSystemctl,
  installTestCoordinatorKeys,
  signedAdmissionEnv,
  writeTrustedAdmissionToken,
  isMutatingCommand,
  assertPreviewOnlyCommands,
  quiescedUnits,
  restoreDrillContext,
};
