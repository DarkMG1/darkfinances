'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const {
  verifyBackupBundleArchive,
  stageRuntimeFromBundle,
  assertSafeRelativePath,
  inventoryFromBundle,
} = require('./backup-bundle-verify');
const { RUNTIME_PREFIX, EMBEDDED_MANIFEST } = require('./backup-bundle-schema');
const { loadBackupStateInventory, isExcludedRuntimeBasename } = require('./backup-bundle-inventory');
const { sha256File } = require('./backup-verify');
const {
  validateGenerationBindingForRestore,
  readDestinationGenerationEvidence,
  listDestinationRuntimeFiles,
  classifyDestinationExtras,
  managedRuntimeRelativePaths,
} = require('./restore-generation-binding');
const { requireQuiescenceAdmission } = require('./restore-quiescence-admission');

const JOURNAL_KIND = 'darkfinances-staged-restore-journal';
const JOURNAL_SCHEMA_VERSION = 1;
const JOURNAL_BASENAME = '.restore-journal.json';

const PHASE = Object.freeze({
  INIT: 'init',
  ARCHIVE_VERIFIED: 'archive_verified',
  STAGED: 'staged',
  BINDING_VALIDATED: 'binding_validated',
  PREFLIGHT_PASSED: 'preflight_passed',
  ROLLBACK_CAPTURED: 'rollback_captured',
  SWAPPED: 'swapped',
  POST_VERIFY_PASSED: 'post_verify_passed',
  COMPLETE: 'complete',
  FAILED: 'failed',
});

function redactPath(input) {
  return String(input).replace(/passkey-credentials\.json[^\n]*/gi, 'passkey-credentials.json [redacted]');
}

function safeError(error) {
  return new Error(redactPath(error.message));
}

function nowIso() {
  return new Date().toISOString();
}

function parseJson(label, text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function ensurePrivateDir(dir, mode = 0o700) {
  fs.mkdirSync(dir, { recursive: true, mode });
  const stat = fs.statSync(dir);
  if ((stat.mode & 0o777) !== mode) fs.chmodSync(dir, mode);
  if (stat.isSymbolicLink()) throw new Error(`refusing symbolic link directory: ${dir}`);
  return dir;
}

function assertRegularFile(filePath, label = 'file') {
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link: ${filePath}`);
  if (!stat.isFile()) throw new Error(`${label} must be a regular file: ${filePath}`);
  return stat;
}

function listTreeFiles(root, prefix = '') {
  const files = [];
  if (!fs.existsSync(root)) return files;
  for (const name of fs.readdirSync(root).sort()) {
    const relative = prefix ? `${prefix}/${name}` : name;
    const absolute = path.join(root, name);
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error(`symbolic link forbidden: ${relative}`);
    if (stat.isDirectory()) {
      files.push(...listTreeFiles(absolute, relative));
      continue;
    }
    if (stat.isFile()) files.push(relative.replace(/\\/g, '/'));
  }
  return files;
}

function runtimeRelativePathsFromManifest(manifest) {
  return manifest.files
    .filter((entry) => entry.path.startsWith(RUNTIME_PREFIX))
    .map((entry) => entry.path.slice(RUNTIME_PREFIX.length))
    .sort();
}

function journalPathForDestination(destinationRoot, workRoot) {
  return path.join(workRoot || destinationRoot, JOURNAL_BASENAME);
}

function readJournal(journalPath) {
  if (!fs.existsSync(journalPath)) return null;
  const journal = parseJson('restore journal', fs.readFileSync(journalPath, 'utf8'));
  if (journal.kind !== JOURNAL_KIND) throw new Error('restore journal kind mismatch');
  if (journal.schemaVersion !== JOURNAL_SCHEMA_VERSION) {
    throw new Error(`unsupported restore journal schemaVersion ${journal.schemaVersion}`);
  }
  return journal;
}

function writeJournal(journalPath, journal, dryRun) {
  if (dryRun) return;
  ensurePrivateDir(path.dirname(journalPath));
  const payload = `${JSON.stringify(journal, null, 2)}\n`;
  const temp = `${journalPath}.tmp-${process.pid}`;
  fs.writeFileSync(temp, payload, { mode: 0o600 });
  fs.renameSync(temp, journalPath);
}

function createJournal({
  restoreId,
  archivePath,
  destinationRoot,
  workRoot,
  dryRun,
}) {
  return {
    kind: JOURNAL_KIND,
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    restoreId,
    archivePath,
    destinationRoot,
    workRoot,
    dryRun: dryRun === true,
    phase: PHASE.INIT,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    completedSwaps: [],
    pendingDeletes: [],
    rollbackRoot: null,
    stagingRoot: null,
    manifestArtifactId: null,
    generationBindingDigest: null,
    faultPoint: null,
  };
}

function updateJournal(journal, patch) {
  Object.assign(journal, patch, { updatedAt: nowIso() });
  return journal;
}

function sameFilesystem(left, right) {
  return fs.statSync(left).dev === fs.statSync(right).dev;
}

function availableBytes(targetPath) {
  if (typeof fs.statfsSync === 'function') {
    const statfs = fs.statfsSync(targetPath);
    return Number(statfs.bavail) * Number(statfs.bsize);
  }
  return null;
}

function treeByteSize(root, files) {
  let total = 0;
  for (const relative of files) {
    total += fs.statSync(path.join(root, relative)).size;
  }
  return total;
}

function assertDestinationWritable(destinationRoot, dryRun) {
  ensurePrivateDir(destinationRoot);
  if (dryRun) {
    try {
      fs.accessSync(destinationRoot, fs.constants.W_OK);
    } catch {
      throw new Error(`destination is not writable: ${destinationRoot}`);
    }
    return;
  }
  const probe = path.join(destinationRoot, `.restore-write-probe-${process.pid}`);
  fs.writeFileSync(probe, 'ok', { mode: 0o600 });
  fs.rmSync(probe, { force: true });
}

function assertPreflightSpace({
  destinationRoot,
  stagingRoot,
  manifest,
  stagingFiles,
  destinationFiles,
  dryRun,
  env = process.env,
}) {
  const needed = treeByteSize(stagingRoot, stagingFiles);
  const rollbackBytes = treeByteSize(destinationRoot, destinationFiles);
  const reserve = 4 * 1024 * 1024;
  const required = needed + rollbackBytes + reserve;
  const available = availableBytes(destinationRoot);
  if (available != null && available < required) {
    const err = new Error(`insufficient disk space for restore: need ${required}, available ${available}`);
    err.code = 'ENOSPC';
    throw err;
  }
  if (dryRun && env.RESTORE_TEST_ENOSPC === '1') {
    const err = new Error('insufficient disk space for restore (simulated)');
    err.code = 'ENOSPC';
    throw err;
  }
  void manifest;
}

function isRestoreWorkArtifact(relativePath) {
  const normalized = relativePath.replace(/\\/g, '/');
  return normalized === JOURNAL_BASENAME
    || normalized.startsWith('.restore-work-');
}

function verifyManifestRuntimeChecksums(stagingRoot, manifest) {
  for (const entry of manifest.files) {
    if (!entry.path.startsWith(RUNTIME_PREFIX)) continue;
    const relative = entry.path.slice(RUNTIME_PREFIX.length);
    assertSafeRelativePath(relative, 'runtime path');
    const target = path.join(stagingRoot, relative);
    assertRegularFile(target, relative);
    const stat = fs.statSync(target);
    if (stat.size !== entry.bytes) throw new Error(`staging size mismatch for ${relative}`);
    if ((stat.mode & 0o777) !== (entry.mode & 0o777)) {
      throw new Error(`staging mode mismatch for ${relative}`);
    }
    const digest = sha256File(target);
    if (digest !== entry.sha256) throw new Error(`staging checksum mismatch for ${relative}`);
  }
}

function buildReplacementTree(bundleRoot, manifest, destinationLayoutRoot) {
  stageRuntimeFromBundle({
    bundleRoot,
    stagingDir: destinationLayoutRoot,
    manifest,
  });
  return listTreeFiles(destinationLayoutRoot);
}

function copyFilePrivate(source, destination, mode) {
  ensurePrivateDir(path.dirname(destination));
  fs.copyFileSync(source, destination);
  fs.chmodSync(destination, mode & 0o777);
}

function copyTreeForRollback(sourceRoot, destinationRoot, relativeFiles) {
  ensurePrivateDir(destinationRoot);
  for (const relative of relativeFiles) {
    const source = path.join(sourceRoot, relative);
    const destination = path.join(destinationRoot, relative);
    if (!fs.existsSync(source)) continue;
    const stat = fs.statSync(source);
    copyFilePrivate(source, destination, stat.mode);
  }
}

function removePathIfExists(target) {
  if (!fs.existsSync(target)) return;
  const stat = fs.lstatSync(target);
  if (stat.isDirectory()) fs.rmSync(target, { recursive: true, force: true });
  else fs.rmSync(target, { force: true });
}

function swapRuntimeTree({
  destinationRoot,
  stagingRoot,
  rollbackRoot,
  manifestPaths,
  staleDestinationPaths,
  journal,
  journalPath,
  dryRun,
  injectFault,
}) {
  if (dryRun) return { completedSwaps: manifestPaths, pendingDeletes: staleDestinationPaths };

  if (!sameFilesystem(destinationRoot, stagingRoot)) {
    throw new Error('staging and destination must reside on the same filesystem for atomic rename swap');
  }

  const completedSwaps = [...journal.completedSwaps];
  const pendingDeletes = staleDestinationPaths.filter(
    (entry) => !(journal.completedDeletes || []).includes(entry),
  );

  for (const relative of manifestPaths) {
    if (completedSwaps.includes(relative)) continue;
    injectFault?.('before:swap-file', relative);
    const source = path.join(stagingRoot, relative);
    const destination = path.join(destinationRoot, relative);
    ensurePrivateDir(path.dirname(destination));
    if (fs.existsSync(destination)) fs.rmSync(destination, { force: true });
    fs.renameSync(source, destination);
    completedSwaps.push(relative);
    updateJournal(journal, { phase: PHASE.SWAPPED, completedSwaps: [...completedSwaps] });
    writeJournal(journalPath, journal, false);
    injectFault?.('after:swap-file', relative);
  }

  const completedDeletes = [...(journal.completedDeletes || [])];
  for (const relative of staleDestinationPaths) {
    if (completedDeletes.includes(relative)) continue;
    injectFault?.('before:delete-stale', relative);
    removePathIfExists(path.join(destinationRoot, relative));
    completedDeletes.push(relative);
    updateJournal(journal, { pendingDeletes: staleDestinationPaths, completedDeletes: [...completedDeletes] });
    writeJournal(journalPath, journal, false);
    injectFault?.('after:delete-stale', relative);
  }

  injectFault?.('after:swap-complete');
  return { completedSwaps, pendingDeletes: staleDestinationPaths, completedDeletes };
}

function rollbackFromSnapshot({
  destinationRoot,
  rollbackRoot,
  relativeFiles,
  injectFault,
}) {
  if (!rollbackRoot || !fs.existsSync(rollbackRoot)) {
    throw new Error('rollback snapshot missing; destination may be mixed-generation');
  }
  injectFault?.('before:rollback');
  for (const relative of relativeFiles) {
    const source = path.join(rollbackRoot, relative);
    const destination = path.join(destinationRoot, relative);
    if (!fs.existsSync(source)) {
      removePathIfExists(destination);
      continue;
    }
    copyFilePrivate(source, destination, fs.statSync(source).mode);
  }
  injectFault?.('after:rollback');
}

function loadValidateBackupSidecar(toolingRoot) {
  const modulePath = path.join(toolingRoot, 'finance-dashboard/lib/runtime-state-store.js');
  if (!fs.existsSync(modulePath)) {
    throw new Error(`bundled runtime-state-store.js is missing: ${modulePath}`);
  }
  // eslint-disable-next-line import/no-dynamic-require, global-require
  const { validateBackupSidecar } = require(modulePath);
  return validateBackupSidecar;
}

function verifyInstalledRuntime({
  destinationRoot,
  manifest,
  inventory,
  toolingRoot,
}) {
  verifyManifestRuntimeChecksums(destinationRoot, manifest);
  const runtimePaths = runtimeRelativePathsFromManifest(manifest);
  const actual = listTreeFiles(destinationRoot).filter((entry) => {
    if (isRestoreWorkArtifact(entry)) return false;
    if (isExcludedRuntimeBasename(path.basename(entry))) return false;
    if (/\.corrupt-/.test(entry)) return false;
    if (entry === '.env' || entry.startsWith('.env.')) return false;
    return true;
  }).sort();
  const expected = runtimePaths.slice().sort();
  if (actual.join('\n') !== expected.join('\n')) {
    throw new Error('installed runtime tree does not match manifest closed world');
  }
  const validateBackupSidecar = loadValidateBackupSidecar(toolingRoot);
  const { validateSidecar, validateReceiptReferences } = require('./backup-verify');
  for (const store of inventory.stores) {
    const target = path.join(destinationRoot, store.filename);
    if (!fs.existsSync(target)) {
      if (store.optionalMissing) continue;
      throw new Error(`installed runtime missing required store ${store.filename}`);
    }
    const text = fs.readFileSync(target, 'utf8');
    validateSidecar(store.filename, text);
    validateBackupSidecar(store.filename, JSON.parse(text));
  }
  const receiptsPath = path.join(destinationRoot, 'receipts.json');
  if (fs.existsSync(receiptsPath)) {
    validateReceiptReferences(JSON.parse(fs.readFileSync(receiptsPath, 'utf8')), destinationRoot);
  }
}

function parseFaultSchedule(raw) {
  if (!raw) return null;
  const schedule = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!Array.isArray(schedule)) return null;
  let index = 0;
  return (point, detail) => {
    const next = schedule[index];
    if (!next) return;
    if (next.point === point && (next.detail == null || next.detail === detail)) {
      index += 1;
      if (next.throwError) {
        const error = new Error(next.throwError);
        if (next.code) error.code = next.code;
        throw error;
      }
      if (next.code === 'EACCES') {
        const error = new Error(`permission denied at ${point}`);
        error.code = 'EACCES';
        throw error;
      }
    }
  };
}

function resolveWorkRoot(destinationRoot, options) {
  if (options.workRoot) return ensurePrivateDir(options.workRoot);
  const preferred = path.join(destinationRoot, `.restore-work-${options.restoreId}`);
  try {
    return ensurePrivateDir(preferred);
  } catch {
    return ensurePrivateDir(path.join(os.tmpdir(), `darkfinances-restore-${options.restoreId}`));
  }
}

function runStagedRestore(options = {}) {
  const archivePath = path.resolve(requireArchive(options.archivePath));
  const destinationRoot = path.resolve(options.destinationRoot);
  const dryRun = options.dryRun === true || options.confirm !== true;
  const env = options.env || process.env;
  const restoreId = options.restoreId || crypto.randomUUID();
  const injectFault = options.injectFault || parseFaultSchedule(env.RESTORE_FAULT_SCHEDULE);

  requireQuiescenceAdmission({ ...options, env });

  const workRoot = dryRun
    ? ensurePrivateDir(path.join(os.tmpdir(), `darkfinances-restore-${restoreId}`))
    : resolveWorkRoot(destinationRoot, { ...options, restoreId });
  const journalPath = journalPathForDestination(destinationRoot, workRoot);
  let journal = readJournal(journalPath);
  const resumeFromJournal = !!(journal
    && journal.phase !== PHASE.INIT
    && journal.phase !== PHASE.COMPLETE);
  if (journal && journal.phase === PHASE.COMPLETE && journal.archivePath === archivePath
    && journal.destinationRoot === destinationRoot && !dryRun) {
    return {
      dryRun,
      resumed: true,
      phase: PHASE.COMPLETE,
      manifestArtifactId: journal.manifestArtifactId,
      generationBindingDigest: journal.generationBindingDigest,
      report: journal.report,
    };
  }
  if (journal && (journal.archivePath !== archivePath || journal.destinationRoot !== destinationRoot)) {
    throw new Error('existing restore journal belongs to a different archive or destination');
  }
  if (!journal) {
    journal = createJournal({ restoreId, archivePath, destinationRoot, workRoot, dryRun });
    writeJournal(journalPath, journal, dryRun);
  } else if (journal.phase === PHASE.FAILED) {
    updateJournal(journal, { phase: PHASE.INIT, error: null, faultPoint: null });
    writeJournal(journalPath, journal, dryRun);
  }

  const extractRoot = path.join(workRoot, 'bundle');
  const stagingRoot = path.join(workRoot, 'staging');
  const rollbackRoot = path.join(workRoot, 'rollback');

  try {
    injectFault?.('before:archive-verify');
    const manifest = verifyBackupBundleArchive({
      archivePath,
      publishDir: extractRoot,
      readOnly: true,
    });
    updateJournal(journal, {
      phase: PHASE.ARCHIVE_VERIFIED,
      manifestArtifactId: manifest.artifact.id,
    });
    writeJournal(journalPath, journal, dryRun);
    injectFault?.('after:archive-verify');

    const inventory = inventoryFromBundle(extractRoot);
    const manifestPaths = runtimeRelativePathsFromManifest(manifest);
    removePathIfExists(stagingRoot);
    ensurePrivateDir(stagingRoot);
    const stagingFiles = buildReplacementTree(extractRoot, manifest, stagingRoot);
    verifyManifestRuntimeChecksums(stagingRoot, manifest);
    updateJournal(journal, { phase: PHASE.STAGED, stagingRoot });
    writeJournal(journalPath, journal, dryRun);
    injectFault?.('after:staging');

    const destinationEvidence = readDestinationGenerationEvidence({
      releaseManifestPath: options.releaseManifestPath,
      actualDataGenerationPath: options.actualDataGenerationPath,
      releaseManifestDigest: options.releaseManifestDigest,
      actualDataGeneration: options.actualDataGeneration,
    });
    const bindingResult = validateGenerationBindingForRestore({
      manifest,
      runtimeRoot: stagingRoot,
      inventory,
      destinationEvidence,
    });
    updateJournal(journal, {
      phase: PHASE.BINDING_VALIDATED,
      generationBindingDigest: bindingResult.expectedBinding.dashboardStateId,
    });
    writeJournal(journalPath, journal, dryRun);
    injectFault?.('after:binding-validate');

    assertDestinationWritable(destinationRoot, dryRun);
    const destinationFiles = listDestinationRuntimeFiles(destinationRoot, inventory);
    const { staleOnly, unknown } = classifyDestinationExtras(destinationFiles, manifestPaths, inventory);
    if (unknown.length > 0) {
      throw new Error(`destination contains unknown runtime files: ${unknown.join(', ')}`);
    }
    assertPreflightSpace({
      destinationRoot,
      stagingRoot,
      manifest,
      stagingFiles,
      destinationFiles,
      dryRun,
      env,
    });
    managedRuntimeRelativePaths(inventory, manifestPaths);
    updateJournal(journal, { phase: PHASE.PREFLIGHT_PASSED, pendingDeletes: staleOnly });
    writeJournal(journalPath, journal, dryRun);
    injectFault?.('after:preflight');

    if (!dryRun) {
      removePathIfExists(rollbackRoot);
      ensurePrivateDir(rollbackRoot);
      copyTreeForRollback(destinationRoot, rollbackRoot, destinationFiles);
      updateJournal(journal, { phase: PHASE.ROLLBACK_CAPTURED, rollbackRoot });
      writeJournal(journalPath, journal, false);
      injectFault?.('after:rollback-capture');
    }

    swapRuntimeTree({
      destinationRoot,
      stagingRoot,
      rollbackRoot,
      manifestPaths,
      staleDestinationPaths: staleOnly,
      journal,
      journalPath,
      dryRun,
      injectFault,
    });
    if (!dryRun) {
      updateJournal(journal, { phase: PHASE.SWAPPED });
      writeJournal(journalPath, journal, false);
    }
    injectFault?.('after:swap');

    if (!dryRun) {
      verifyInstalledRuntime({
        destinationRoot,
        manifest,
        inventory,
        toolingRoot: path.join(extractRoot, 'tooling'),
      });
      updateJournal(journal, { phase: PHASE.POST_VERIFY_PASSED });
      writeJournal(journalPath, journal, false);
    }
    injectFault?.('after:post-verify');

    const report = {
      manifestArtifactId: manifest.artifact.id,
      generationBindingDigest: bindingResult.expectedBinding.dashboardStateId,
      backupArtifactId: bindingResult.expectedBinding.backupArtifactId,
      releaseManifestDigest: bindingResult.expectedBinding.releaseManifestDigest,
      actualDataGeneration: bindingResult.expectedBinding.actualDataGeneration,
      activeSubjects: bindingResult.activeSubjects.map((entry) => `${entry.store}:${entry.id}`),
      staleRemoved: staleOnly,
      fileCount: manifestPaths.length,
      dryRun,
    };
    updateJournal(journal, { phase: PHASE.COMPLETE, report });
    writeJournal(journalPath, journal, dryRun);

    if (!dryRun && rollbackRoot && fs.existsSync(rollbackRoot)) {
      fs.rmSync(rollbackRoot, { recursive: true, force: true });
    }

    return {
      dryRun,
      resumed: resumeFromJournal,
      phase: PHASE.COMPLETE,
      report,
    };
  } catch (error) {
    updateJournal(journal, { phase: PHASE.FAILED, error: redactPath(error.message) });
    writeJournal(journalPath, journal, dryRun);
    if (!dryRun && journal.completedSwaps?.length > 0 && journal.rollbackRoot) {
      try {
        rollbackFromSnapshot({
          destinationRoot,
          rollbackRoot: journal.rollbackRoot,
          relativeFiles: listDestinationRuntimeFiles(destinationRoot, loadBackupStateInventory()),
          injectFault,
        });
      } catch (rollbackError) {
        throw safeError(new Error(`${error.message}; rollback failed: ${rollbackError.message}`));
      }
    }
    throw safeError(error);
  }
}

function requireArchive(archivePath) {
  if (!archivePath || !fs.existsSync(archivePath)) {
    throw new Error(`archive not found: ${archivePath}`);
  }
  assertRegularFile(archivePath, 'archive');
  return archivePath;
}

module.exports = {
  JOURNAL_KIND,
  JOURNAL_SCHEMA_VERSION,
  JOURNAL_BASENAME,
  PHASE,
  runStagedRestore,
  readJournal,
  journalPathForDestination,
  listTreeFiles,
  runtimeRelativePathsFromManifest,
  verifyManifestRuntimeChecksums,
  buildReplacementTree,
  swapRuntimeTree,
  rollbackFromSnapshot,
  parseFaultSchedule,
};
