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
  readManifestFromArchive,
} = require('./backup-bundle-verify');
const { RUNTIME_PREFIX } = require('./backup-bundle-schema');
const { loadBackupStateInventory, isExcludedRuntimeBasename } = require('./backup-bundle-inventory');
const { sha256File } = require('./backup-verify');
const {
  validateGenerationBindingForRestore,
  readDestinationGenerationEvidence,
  listDestinationRuntimeFiles,
  classifyDestinationExtras,
  managedRuntimeRelativePaths,
} = require('./restore-generation-binding');
const {
  requireQuiescenceAdmission,
  assertAdmissionBindings,
  issueSignedAdmissionToken,
  consumeAdmissionToken,
  revokeAdmissionToken,
} = require('./restore-quiescence-admission');
const { coordinatedLayoutForRoot } = require('./coordinated-operation-layout');
const {
  assertAllWritersQuiescentForAdmission,
  captureWriterState,
  previewWritersForRestore,
} = require('./writer-quiescence');
const { enumerateWriters, loadWriterInventory } = require('./writer-inventory');
const { createDefaultRunners } = require('./ops-command-runners');
const {
  controlLayoutForDestination,
  ensureControlRoot,
  ensurePrivateSubdir,
  assertControlPathsSafe,
  destinationExists,
  resolveCanonicalDestination,
  JOURNAL_FILENAME,
} = require('./restore-control-layout');
const {
  captureSnapshotToDisk,
  readSnapshotManifest,
  applySnapshotRollback,
  stagingTreeDigest,
  snapshotDigest,
} = require('./restore-snapshot');
const { writeFileAtomic, fsyncPath } = require('./restore-durable-io');
const { acquireRestoreLock } = require('./restore-instance-lock');
const { assertCoordinatedLockHeld } = require('./coordinated-operation-lock');

const JOURNAL_KIND = 'darkfinances-staged-restore-journal';
const JOURNAL_SCHEMA_VERSION = 2;
const JOURNAL_MAX_BYTES = 512 * 1024;
const FAILURE_HISTORY_LIMIT = 32;
const FAILURE_MESSAGE_MAX_BYTES = 1024;
const FAILURE_STAGE_MAX_BYTES = 64;

const PHASE = Object.freeze({
  INIT: 'init',
  ARCHIVE_VERIFIED: 'archive_verified',
  STAGED: 'staged',
  BINDING_VALIDATED: 'binding_validated',
  PREFLIGHT_PASSED: 'preflight_passed',
  SNAPSHOT_CAPTURED: 'snapshot_captured',
  SWAPPED: 'swapped',
  POST_VERIFY_PASSED: 'post_verify_passed',
  COMPLETE: 'complete',
  FAILED: 'failed',
  ROLLBACK_IN_PROGRESS: 'rollback_in_progress',
  ROLLBACK_FAILED: 'rollback_failed',
  ROLLED_BACK: 'rolled_back',
});

const TERMINAL_FAILURE_PHASES = new Set([
  PHASE.FAILED,
  PHASE.ROLLBACK_FAILED,
  PHASE.ROLLED_BACK,
]);

const MUTATION_STATUS = Object.freeze({
  NOT_STARTED: 'not_started',
  UNVERIFIED: 'unverified_partial_mutation',
  ROLLBACK_VERIFIED: 'rollback_verified',
  REPLACEMENT_VERIFIED: 'replacement_verified',
});

function redactPath(input) {
  return String(input).replace(/passkey-credentials\.json[^\n]*/gi, 'passkey-credentials.json [redacted]');
}

function safeError(error, restartSafety = null) {
  const redacted = new Error(boundedFailureMessage(error));
  if (restartSafety) redacted.restoreRestartSafety = restartSafety;
  return redacted;
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

function restoreIdForDestination(canonicalDestination) {
  return crypto.createHash('sha256').update(`${canonicalDestination}\n`).digest('hex');
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

function journalPathForDestination(_destinationRoot, layout) {
  return layout?.journalPath || null;
}

function readJournal(journalPath) {
  if (!journalPath || !fs.existsSync(journalPath)) return null;
  const stat = fs.lstatSync(journalPath);
  if (stat.isSymbolicLink()) throw new Error('restore journal must not be a symbolic link');
  if (!stat.isFile()) throw new Error('restore journal must be a regular file');
  if (stat.size > JOURNAL_MAX_BYTES) {
    throw new Error('restore journal exceeds size limit');
  }
  const journal = parseJson('restore journal', fs.readFileSync(journalPath, 'utf8'));
  if (journal.kind !== JOURNAL_KIND) throw new Error('restore journal kind mismatch');
  if (journal.schemaVersion !== JOURNAL_SCHEMA_VERSION) {
    throw new Error(`unsupported restore journal schemaVersion ${journal.schemaVersion}`);
  }
  return journal;
}

function writeJournal(journalPath, journal, persist) {
  if (!persist) return;
  writeFileAtomic(journalPath, `${JSON.stringify(journal, null, 2)}\n`, 0o600);
}

function createJournal({
  restoreId,
  canonicalDestination,
  archivePath,
  archiveSha256,
  layout,
  dryRun,
}) {
  return {
    kind: JOURNAL_KIND,
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    restoreId,
    destinationRoot: canonicalDestination,
    archivePath,
    archiveSha256,
    controlRoot: layout.controlRoot,
    workRoot: layout.workRoot,
    snapshotRoot: layout.snapshotRoot,
    dryRun: dryRun === true,
    phase: PHASE.INIT,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    manifestArtifactId: null,
    generationBindingDigest: null,
    stagedTreeDigest: null,
    snapshotDigest: null,
    completedSwaps: [],
    completedDeletes: [],
    introducedPaths: [],
    rollbackPhase: null,
    mutationStatus: MUTATION_STATUS.NOT_STARTED,
    mutationStartedAt: null,
    mutationVerifiedAt: null,
    failureHistory: [],
    failureHistoryDropped: 0,
    error: null,
    report: null,
  };
}

function updateJournal(journal, patch) {
  Object.assign(journal, patch, { updatedAt: nowIso() });
  return journal;
}

function resetSwapProgress(journal, { clearError = true } = {}) {
  journal.completedSwaps = [];
  journal.completedDeletes = [];
  journal.introducedPaths = [];
  journal.rollbackPhase = null;
  if (clearError) journal.error = null;
  return journal;
}

function truncateUtf8(input, maxBytes) {
  const text = String(input);
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const suffix = ' … [truncated]';
  const budget = maxBytes - Buffer.byteLength(suffix, 'utf8');
  let used = 0;
  let truncated = '';
  for (const character of text) {
    const bytes = Buffer.byteLength(character, 'utf8');
    if (used + bytes > budget) break;
    truncated += character;
    used += bytes;
  }
  return `${truncated}${suffix}`;
}

function boundedSingleLine(input, maxBytes, fallback) {
  const raw = String(input ?? fallback).slice(0, maxBytes * 8);
  const singleLine = redactPath(raw)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '?')
    .replace(/\s+/gu, ' ')
    .trim();
  return truncateUtf8(singleLine || fallback, maxBytes);
}

function boundedFailureMessage(error) {
  const message = error && typeof error === 'object' && 'message' in error
    ? error.message
    : error;
  return boundedSingleLine(message, FAILURE_MESSAGE_MAX_BYTES, 'unknown restore failure');
}

function boundedFailureStage(stage) {
  return boundedSingleLine(stage, FAILURE_STAGE_MAX_BYTES, 'unknown');
}

function normalizeFailureHistoryEntry(entry) {
  return {
    at: boundedSingleLine(entry?.at, FAILURE_STAGE_MAX_BYTES, nowIso()),
    stage: boundedFailureStage(entry?.stage),
    message: boundedFailureMessage(entry?.message),
  };
}

function appendFailureHistory(journal, stage, error) {
  if (!Array.isArray(journal.failureHistory)) journal.failureHistory = [];
  journal.failureHistory = journal.failureHistory.map(normalizeFailureHistoryEntry);
  journal.failureHistory.push({
    at: nowIso(),
    stage: boundedFailureStage(stage),
    message: boundedFailureMessage(error),
  });
  const excess = Math.max(0, journal.failureHistory.length - FAILURE_HISTORY_LIMIT);
  const priorDropped = Number.isSafeInteger(journal.failureHistoryDropped)
    && journal.failureHistoryDropped >= 0
    ? journal.failureHistoryDropped
    : 0;
  if (excess > 0) journal.failureHistory.splice(0, excess);
  journal.failureHistoryDropped = Math.min(Number.MAX_SAFE_INTEGER, priorDropped + excess);
  return journal;
}

function inferMutationStatus(journal) {
  if (!journal) return MUTATION_STATUS.NOT_STARTED;
  if (Object.values(MUTATION_STATUS).includes(journal.mutationStatus)) {
    return journal.mutationStatus;
  }
  if (journal.phase === PHASE.COMPLETE || journal.phase === PHASE.POST_VERIFY_PASSED) {
    return MUTATION_STATUS.REPLACEMENT_VERIFIED;
  }
  if (journal.phase === PHASE.ROLLED_BACK) return MUTATION_STATUS.ROLLBACK_VERIFIED;
  if (
    journal.phase === PHASE.ROLLBACK_FAILED
    || journal.phase === PHASE.ROLLBACK_IN_PROGRESS
    || journal.phase === PHASE.SWAPPED
    || journal.phase === PHASE.FAILED
    || journal.phase === PHASE.SNAPSHOT_CAPTURED
    || (journal.completedSwaps || []).length > 0
    || (journal.completedDeletes || []).length > 0
    || (journal.introducedPaths || []).length > 0
  ) {
    return MUTATION_STATUS.UNVERIFIED;
  }
  return MUTATION_STATUS.NOT_STARTED;
}

function stagedRestoreRestartSafety(journal, journalPath = null) {
  const status = inferMutationStatus(journal);
  const phase = journal?.phase ?? null;
  const hasMutationProgress = (journal?.completedSwaps || []).length > 0
    || (journal?.completedDeletes || []).length > 0
    || (journal?.introducedPaths || []).length > 0;
  let restartAllowed = status === MUTATION_STATUS.NOT_STARTED
    || status === MUTATION_STATUS.ROLLBACK_VERIFIED
    || status === MUTATION_STATUS.REPLACEMENT_VERIFIED;
  let reason;
  if (phase === PHASE.ROLLBACK_FAILED || phase === PHASE.ROLLBACK_IN_PROGRESS) {
    restartAllowed = false;
    reason = `staged restore is ${phase}`;
  } else if (status === MUTATION_STATUS.NOT_STARTED && hasMutationProgress) {
    restartAllowed = false;
    reason = 'staged restore journal has mutation progress without a mutation marker';
  } else if (status === MUTATION_STATUS.UNVERIFIED) {
    reason = 'destination may contain an unverified partial restore';
  } else if (status === MUTATION_STATUS.ROLLBACK_VERIFIED) {
    reason = 'pre-restore snapshot rollback was verified';
  } else if (status === MUTATION_STATUS.REPLACEMENT_VERIFIED) {
    reason = 'replacement generation was verified';
  } else {
    reason = 'no destination mutation started';
  }
  return {
    restartAllowed,
    mutationStatus: status,
    stagedPhase: phase,
    stagedJournalPath: journalPath,
    reason,
  };
}

function publishRestartSafety(session, journal, journalPath) {
  const safety = stagedRestoreRestartSafety(journal, journalPath);
  session?.onRestoreSafety?.(safety);
  return safety;
}

function assertJournalMatchesRequest(journal, { archiveSha256, canonicalDestination }) {
  if (journal.destinationRoot !== canonicalDestination) {
    throw new Error('restore journal destination binding mismatch');
  }
  if (journal.archiveSha256 !== archiveSha256) {
    throw new Error('restore journal archive binding mismatch');
  }
}

function verifyCompleteArchiveBindings(journal, { archivePath, sidecarManifest, canonicalDestination }) {
  if (journal.destinationRoot !== canonicalDestination) {
    throw new Error('restore journal destination binding mismatch');
  }
  const actualArchiveSha = sha256File(archivePath);
  if (actualArchiveSha !== journal.archiveSha256) {
    throw new Error('completed restore archive substitution detected');
  }
  if (journal.manifestArtifactId !== sidecarManifest.artifact.id) {
    throw new Error('completed restore journal manifest artifact mismatch');
  }
}

function verifyCompleteDestination({
  destinationRoot,
  manifest,
  inventory,
  toolingRoot,
  destinationEvidence,
}) {
  try {
    verifyInstalledRuntime({
      destinationRoot,
      manifest,
      inventory,
      toolingRoot,
    });
    validateGenerationBindingForRestore({
      manifest,
      runtimeRoot: destinationRoot,
      inventory,
      destinationEvidence,
    });
  } catch (error) {
    throw new Error(`completed restore destination drift detected: ${error.message}`);
  }
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

function assertDestinationWritableLive(canonicalDestination) {
  if (!destinationExists(canonicalDestination)) {
    throw new Error(`destination does not exist: ${canonicalDestination}`);
  }
  resolveCanonicalDestination(canonicalDestination);
  const probe = path.join(canonicalDestination, `.restore-write-probe-${process.pid}`);
  fs.writeFileSync(probe, 'ok', { mode: 0o600 });
  fs.rmSync(probe, { force: true });
}

function assertDestinationDryRunCapable(destinationRoot) {
  const resolved = path.resolve(destinationRoot);
  if (destinationExists(resolved)) {
    resolveCanonicalDestination(resolved);
    return resolved;
  }
  const parent = path.dirname(resolved);
  if (!fs.existsSync(parent)) {
    throw new Error(`destination parent does not exist: ${parent}`);
  }
  const parentStat = fs.lstatSync(parent);
  if (parentStat.isSymbolicLink()) throw new Error('destination parent must not be a symbolic link');
  try {
    fs.accessSync(parent, fs.constants.W_OK);
  } catch {
    throw new Error(`destination parent is not writable: ${parent}`);
  }
  return resolved;
}

function spaceCheckPath(destinationRoot, snapshotRoot) {
  for (const candidate of [snapshotRoot, destinationRoot]) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return path.dirname(destinationRoot);
}

function assertPreflightSpace({
  destinationRoot,
  stagingRoot,
  stagingFiles,
  destinationFiles,
  snapshotRoot,
  dryRun,
  env = process.env,
}) {
  const needed = treeByteSize(stagingRoot, stagingFiles);
  const rollbackBytes = destinationExists(destinationRoot)
    ? treeByteSize(destinationRoot, destinationFiles)
    : 0;
  const reserve = 4 * 1024 * 1024;
  const required = needed + rollbackBytes + reserve;
  const available = availableBytes(spaceCheckPath(destinationRoot, snapshotRoot));
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
}

function verifyManifestRuntimeChecksums(stagingRoot, manifest) {
  for (const entry of manifest.files) {
    if (!entry.path.startsWith(RUNTIME_PREFIX)) continue;
    const relative = entry.path.slice(RUNTIME_PREFIX.length);
    assertSafeRelativePath(relative, 'runtime path');
    const target = path.join(stagingRoot, relative);
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) throw new Error(`symbolic link forbidden: ${relative}`);
    if (!stat.isFile()) throw new Error(`expected file for ${relative}`);
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

function removePathIfExists(target) {
  if (!fs.existsSync(target)) return;
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) throw new Error(`refusing to remove symbolic link: ${target}`);
  if (stat.isDirectory()) fs.rmSync(target, { recursive: true, force: true });
  else fs.rmSync(target, { force: true });
}

function markDestinationMutationStarted({
  journal,
  journalPath,
  persist,
  onSafetyChange,
}) {
  if (journal.mutationStatus === MUTATION_STATUS.UNVERIFIED) return;
  updateJournal(journal, {
    mutationStatus: MUTATION_STATUS.UNVERIFIED,
    mutationStartedAt: journal.mutationStartedAt || nowIso(),
    mutationVerifiedAt: null,
  });
  writeJournal(journalPath, journal, persist);
  onSafetyChange?.();
}

function swapRuntimeTree({
  destinationRoot,
  stagingRoot,
  snapshotManifest,
  manifestPaths,
  staleDestinationPaths,
  journal,
  journalPath,
  dryRun,
  injectFault,
  persist,
  assertMutationGate,
  onSafetyChange,
}) {
  if (dryRun) return { completedSwaps: [], completedDeletes: [], introducedPaths: [] };

  if (!sameFilesystem(destinationRoot, stagingRoot)) {
    throw new Error('staging and destination must reside on the same filesystem for per-file replacement swap');
  }

  const snapshotPresent = new Set(
    (snapshotManifest?.entries || []).filter((entry) => entry.present).map((entry) => entry.path),
  );

  for (const relative of manifestPaths) {
    if (journal.completedSwaps.includes(relative)) continue;
    injectFault?.('before:swap-file', relative);
    assertMutationGate();
    markDestinationMutationStarted({
      journal,
      journalPath,
      persist,
      onSafetyChange,
    });
    const source = path.join(stagingRoot, relative);
    const destination = path.join(destinationRoot, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    const existed = fs.existsSync(destination);
    if (existed) fs.rmSync(destination, { force: true });
    fs.renameSync(source, destination);
    fsyncPath(path.dirname(destination), true);
    if (!existed && !snapshotPresent.has(relative) && !journal.introducedPaths.includes(relative)) {
      journal.introducedPaths.push(relative);
    }
    journal.completedSwaps.push(relative);
    updateJournal(journal, { phase: PHASE.SWAPPED, completedSwaps: [...journal.completedSwaps], introducedPaths: [...journal.introducedPaths] });
    writeJournal(journalPath, journal, persist);
    injectFault?.('after:swap-file', relative);
  }

  for (const relative of staleDestinationPaths) {
    if (journal.completedDeletes.includes(relative)) continue;
    injectFault?.('before:delete-stale', relative);
    assertMutationGate();
    markDestinationMutationStarted({
      journal,
      journalPath,
      persist,
      onSafetyChange,
    });
    removePathIfExists(path.join(destinationRoot, relative));
    journal.completedDeletes.push(relative);
    updateJournal(journal, { phase: PHASE.SWAPPED, completedDeletes: [...journal.completedDeletes] });
    writeJournal(journalPath, journal, persist);
    injectFault?.('after:delete-stale', relative);
  }

  injectFault?.('after:swap-complete');
  return {
    completedSwaps: journal.completedSwaps,
    completedDeletes: journal.completedDeletes,
    introducedPaths: journal.introducedPaths,
  };
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

function isRestoreControlPath(relativePath) {
  return relativePath === '.darkfinances-restore'
    || relativePath.startsWith('.darkfinances-restore/');
}

function verifyInstalledRuntime({
  destinationRoot,
  manifest,
  inventory,
  toolingRoot,
  driftMessage = 'installed runtime tree does not match manifest closed world',
}) {
  verifyManifestRuntimeChecksums(destinationRoot, manifest);
  const runtimePaths = runtimeRelativePathsFromManifest(manifest);
  const actual = listTreeFiles(destinationRoot).filter((entry) => {
    if (isRestoreControlPath(entry)) return false;
    if (isExcludedRuntimeBasename(path.basename(entry))) return false;
    if (/\.corrupt-/.test(entry)) return false;
    if (entry === '.env' || entry.startsWith('.env.')) return false;
    return true;
  }).sort();
  const expected = runtimePaths.slice().sort();
  if (actual.join('\n') !== expected.join('\n')) {
    throw new Error(driftMessage);
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
      if (next.holdUntilFile) {
        if (next.createReadyFile) {
          fs.writeFileSync(next.createReadyFile, `${process.pid}\n`, { mode: 0o600 });
        }
        const deadline = Date.now() + (next.holdTimeoutMs ?? 30000);
        while (!fs.existsSync(next.holdUntilFile)) {
          if (Date.now() > deadline) {
            throw new Error(`timed out waiting for ${next.holdUntilFile}`);
          }
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
        }
      }
    }
  };
}

function performRollback({
  destinationRoot,
  layout,
  journal,
  journalPath,
  inventory,
  injectFault,
  persist,
  onSafetyChange,
}) {
  const snapshotManifest = readSnapshotManifest(layout.snapshotRoot);
  updateJournal(journal, { phase: PHASE.ROLLBACK_IN_PROGRESS, rollbackPhase: 'start' });
  writeJournal(journalPath, journal, persist);
  onSafetyChange?.();
  try {
    applySnapshotRollback({
      destinationRoot,
      snapshotRoot: layout.snapshotRoot,
      snapshotManifest,
      inventory,
      injectFault,
      onPhase: (phase, detail) => {
        updateJournal(journal, { rollbackPhase: detail ? `${phase}:${detail}` : phase });
        writeJournal(journalPath, journal, persist);
      },
    });
    resetSwapProgress(journal, { clearError: false });
    updateJournal(journal, {
      phase: PHASE.ROLLED_BACK,
      rollbackPhase: 'complete',
      mutationStatus: MUTATION_STATUS.ROLLBACK_VERIFIED,
      mutationVerifiedAt: nowIso(),
    });
    writeJournal(journalPath, journal, persist);
    onSafetyChange?.();
    return snapshotManifest;
  } catch (error) {
    appendFailureHistory(journal, 'rollback', error);
    updateJournal(journal, {
      phase: PHASE.ROLLBACK_FAILED,
      rollbackPhase: 'failed',
      mutationStatus: MUTATION_STATUS.UNVERIFIED,
      error: boundedFailureMessage(error),
    });
    writeJournal(journalPath, journal, persist);
    onSafetyChange?.();
    throw error;
  }
}

function needsRollbackFirst(journal) {
  const status = inferMutationStatus(journal);
  return status === MUTATION_STATUS.UNVERIFIED
    || journal.phase === PHASE.ROLLBACK_IN_PROGRESS
    || journal.phase === PHASE.ROLLBACK_FAILED;
}

function cleanupControlArtifacts(layout, { keepJournal = false } = {}) {
  if (fs.existsSync(layout.workRoot)) fs.rmSync(layout.workRoot, { recursive: true, force: true });
  if (fs.existsSync(layout.snapshotRoot)) fs.rmSync(layout.snapshotRoot, { recursive: true, force: true });
  if (!keepJournal && fs.existsSync(layout.journalPath)) fs.rmSync(layout.journalPath, { force: true });
  if (fs.existsSync(layout.controlRoot)) {
    const remaining = fs.readdirSync(layout.controlRoot);
    if (remaining.length === 0) fs.rmdirSync(layout.controlRoot);
  }
}

function requireArchive(archivePath) {
  if (!archivePath || !fs.existsSync(archivePath)) {
    throw new Error(`archive not found: ${archivePath}`);
  }
  const stat = fs.lstatSync(archivePath);
  if (stat.isSymbolicLink()) throw new Error('archive must not be a symbolic link');
  if (!stat.isFile()) throw new Error('archive must be a regular file');
  return archivePath;
}

function runStagedRestore(options = {}) {
  const coordinatedSession = options.coordinatedSession || null;
  publishRestartSafety(coordinatedSession, null, null);
  const archivePath = path.resolve(requireArchive(options.archivePath));
  const archiveSha256 = sha256File(archivePath);
  const requestedDestination = path.resolve(options.destinationRoot);
  const dryRun = options.dryRun === true || options.confirm !== true;
  const env = options.env || process.env;
  const injectFault = options.injectFault || parseFaultSchedule(env.RESTORE_FAULT_SCHEDULE);
  const persist = !dryRun;

  if (!dryRun) {
    if (!options.coordinatedSession) {
      throw new Error('standalone live restore is refused; use restore-coordinated.sh so writer stops remain held through swap');
    }
    assertCoordinatedLockHeld({
      layout: options.coordinatedSession.layout,
      operation: 'restore',
      env,
    });
  }

  if (!dryRun && !destinationExists(requestedDestination)) {
    fs.mkdirSync(requestedDestination, { recursive: true, mode: 0o700 });
  }
  const layout = controlLayoutForDestination(
    dryRun ? assertDestinationDryRunCapable(requestedDestination) : requestedDestination,
  );
  const canonicalDestination = layout.canonicalDestination;
  const restoreId = restoreIdForDestination(canonicalDestination);

  if (dryRun) {
    const coordinatorRoot = options.coordinatorRoot || env.DARKFINANCES_BACKUP_DIR || null;
    requireQuiescenceAdmission({
      ...options,
      env,
      dryRun: true,
      coordinatorRoot,
      requireBindings: true,
      bindingContext: {
        archiveSha256,
        destinationRoot: canonicalDestination,
      },
      layout: options.layout || (coordinatorRoot ? coordinatedLayoutForRoot(coordinatorRoot) : null),
      verifyLiveWriters: false,
    });
  }

  let journal = null;
  let resumeFromJournal = false;
  let restoreLock = null;
  let admission = null;
  let admissionConsumed = false;
  let coordinatorLayout = null;
  const sidecarManifest = readManifestFromArchive(archivePath);

  if (persist) {
    ensureControlRoot(layout, { create: true });
    assertControlPathsSafe(layout);
    journal = readJournal(layout.journalPath);
    if (journal?.phase === PHASE.COMPLETE) {
      verifyCompleteArchiveBindings(journal, { archivePath, sidecarManifest, canonicalDestination });
    } else if (journal) {
      assertJournalMatchesRequest(journal, { archiveSha256, canonicalDestination });
      resumeFromJournal = journal.phase !== PHASE.INIT;
    }
  } else if (destinationExists(canonicalDestination) && fs.existsSync(layout.journalPath)) {
    journal = readJournal(layout.journalPath);
    if (journal?.phase === PHASE.COMPLETE) {
      verifyCompleteArchiveBindings(journal, { archivePath, sidecarManifest, canonicalDestination });
    } else if (journal) {
      assertJournalMatchesRequest(journal, { archiveSha256, canonicalDestination });
    }
  }
  publishRestartSafety(coordinatedSession, journal, layout.journalPath);

  restoreLock = acquireRestoreLock({ layout, canonicalDestination, dryRun, env });

  if (!journal && persist) {
    journal = createJournal({
      restoreId,
      canonicalDestination,
      archivePath,
      archiveSha256,
      layout,
      dryRun: false,
    });
    writeJournal(layout.journalPath, journal, true);
    publishRestartSafety(coordinatedSession, journal, layout.journalPath);
  } else if (!journal) {
    journal = createJournal({
      restoreId,
      canonicalDestination,
      archivePath,
      archiveSha256,
      layout,
      dryRun: true,
    });
    publishRestartSafety(coordinatedSession, journal, layout.journalPath);
  } else if (TERMINAL_FAILURE_PHASES.has(journal.phase) || needsRollbackFirst(journal)) {
    if (persist && journal.snapshotDigest && fs.existsSync(layout.snapshotRoot)) {
      const inventory = loadBackupStateInventory();
      if (journal.phase === PHASE.ROLLBACK_FAILED || needsRollbackFirst(journal)) {
        try {
          performRollback({
            destinationRoot: canonicalDestination,
            layout,
            journal,
            journalPath: layout.journalPath,
            inventory,
            injectFault,
            persist,
            onSafetyChange: () => publishRestartSafety(
              coordinatedSession,
              journal,
              layout.journalPath,
            ),
          });
        } catch (error) {
          const safety = publishRestartSafety(coordinatedSession, journal, layout.journalPath);
          restoreLock?.release();
          restoreLock = null;
          throw safeError(error, safety);
        }
      }
      resetSwapProgress(journal);
      updateJournal(journal, {
        phase: PHASE.INIT,
        mutationStatus: MUTATION_STATUS.NOT_STARTED,
        mutationStartedAt: null,
        mutationVerifiedAt: null,
        error: null,
      });
      writeJournal(layout.journalPath, journal, persist);
      publishRestartSafety(coordinatedSession, journal, layout.journalPath);
      resumeFromJournal = true;
    } else if (needsRollbackFirst(journal)) {
      const error = new Error('restore journal indicates partial mutation but snapshot is missing');
      appendFailureHistory(journal, 'resume', error);
      updateJournal(journal, {
        phase: PHASE.ROLLBACK_FAILED,
        mutationStatus: MUTATION_STATUS.UNVERIFIED,
        error: boundedFailureMessage(error),
      });
      writeJournal(layout.journalPath, journal, persist);
      const safety = publishRestartSafety(coordinatedSession, journal, layout.journalPath);
      restoreLock?.release();
      restoreLock = null;
      throw safeError(error, safety);
    }
  }

  const workRoot = dryRun
    ? fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-restore-dry-'))
    : ensurePrivateSubdir(layout.controlRoot, 'work');
  const extractRoot = path.join(workRoot, 'bundle');
  const stagingRoot = path.join(workRoot, 'staging');

  try {
    injectFault?.('before:archive-verify');
    const manifest = verifyBackupBundleArchive({
      archivePath,
      publishDir: extractRoot,
      readOnly: true,
    });
    injectFault?.('after:archive-verify');

    if (journal?.phase === PHASE.COMPLETE) {
      if (manifest.artifact.id !== journal.manifestArtifactId) {
        throw new Error('completed restore journal manifest artifact mismatch');
      }
      const replayEvidence = readDestinationGenerationEvidence({
        releaseManifestPath: options.releaseManifestPath,
        actualDataGenerationPath: options.actualDataGenerationPath,
        releaseManifestDigest: options.releaseManifestDigest,
        actualDataGeneration: options.actualDataGeneration,
        env,
      });
      verifyCompleteDestination({
        destinationRoot: canonicalDestination,
        manifest,
        inventory: inventoryFromBundle(extractRoot),
        toolingRoot: path.join(extractRoot, 'tooling'),
        destinationEvidence: replayEvidence,
      });
      return {
        dryRun,
        resumed: true,
        phase: PHASE.COMPLETE,
        manifestArtifactId: journal.manifestArtifactId,
        generationBindingDigest: journal.generationBindingDigest,
        report: journal.report,
      };
    }

    if (persist) {
      updateJournal(journal, {
        phase: PHASE.ARCHIVE_VERIFIED,
        manifestArtifactId: manifest.artifact.id,
      });
      writeJournal(layout.journalPath, journal, true);
    }

    const inventory = inventoryFromBundle(extractRoot);
    const manifestPaths = runtimeRelativePathsFromManifest(manifest);
    if (fs.existsSync(stagingRoot)) fs.rmSync(stagingRoot, { recursive: true, force: true });
    fs.mkdirSync(stagingRoot, { recursive: true, mode: 0o700 });
    const stagingFiles = buildReplacementTree(extractRoot, manifest, stagingRoot);
    verifyManifestRuntimeChecksums(stagingRoot, manifest);
    const stagedDigest = stagingTreeDigest(stagingRoot, stagingFiles);
    if (persist) {
      updateJournal(journal, { phase: PHASE.STAGED, stagedTreeDigest: stagedDigest });
      writeJournal(layout.journalPath, journal, true);
    }
    injectFault?.('after:staging');

    const destinationEvidence = readDestinationGenerationEvidence({
      releaseManifestPath: options.releaseManifestPath,
      actualDataGenerationPath: options.actualDataGenerationPath,
      releaseManifestDigest: options.releaseManifestDigest,
      actualDataGeneration: options.actualDataGeneration,
      env,
    });
    const bindingResult = validateGenerationBindingForRestore({
      manifest,
      runtimeRoot: stagingRoot,
      inventory,
      destinationEvidence,
    });
    if (persist) {
      updateJournal(journal, {
        phase: PHASE.BINDING_VALIDATED,
        generationBindingDigest: bindingResult.expectedBinding.dashboardStateId,
      });
      writeJournal(layout.journalPath, journal, true);
    }
    injectFault?.('after:binding-validate');

    if (!dryRun) {
      assertDestinationWritableLive(canonicalDestination);
    }

    const destinationFiles = destinationExists(canonicalDestination)
      ? listDestinationRuntimeFiles(canonicalDestination, inventory)
      : [];
    const { staleOnly, unknown } = classifyDestinationExtras(destinationFiles, manifestPaths, inventory);
    if (unknown.length > 0) {
      throw new Error(`destination contains unknown runtime files: ${unknown.join(', ')}`);
    }
    assertPreflightSpace({
      destinationRoot: canonicalDestination,
      stagingRoot,
      stagingFiles,
      destinationFiles,
      snapshotRoot: persist ? layout.snapshotRoot : canonicalDestination,
      dryRun,
      env,
    });
    managedRuntimeRelativePaths(inventory, manifestPaths);
    if (persist) {
      updateJournal(journal, { phase: PHASE.PREFLIGHT_PASSED, pendingDeletes: staleOnly });
      writeJournal(layout.journalPath, journal, true);
    }
    injectFault?.('after:preflight');

    if (dryRun) {
      const writerInventory = loadWriterInventory();
      const runnersForPreview = options.runners || createDefaultRunners(env);
      const writerPreview = previewWritersForRestore({
        inventory: writerInventory,
        env,
        runners: runnersForPreview,
        dashboardDir: canonicalDestination,
        allowOwnRestoreLock: true,
      }, {
        label: 'restore dry-run',
        failOnActive: env.RESTORE_DRY_RUN_STRICT === '1',
      });
      const report = {
        manifestArtifactId: manifest.artifact.id,
        generationBindingDigest: bindingResult.expectedBinding.dashboardStateId,
        backupArtifactId: bindingResult.expectedBinding.backupArtifactId,
        releaseManifestDigest: bindingResult.expectedBinding.releaseManifestDigest,
        actualDataGeneration: bindingResult.expectedBinding.actualDataGeneration,
        activeSubjects: bindingResult.activeSubjects.map((entry) => `${entry.store}:${entry.id}`),
        staleRemoved: staleOnly,
        fileCount: manifestPaths.length,
        dryRun: true,
        stagedTreeDigest: stagedDigest,
        archiveSha256,
        writerPreview: {
          quiescent: writerPreview.quiescent,
          writers: writerPreview.writers,
        },
        warnings: writerPreview.warnings,
      };
      return { dryRun: true, resumed: false, phase: PHASE.PREFLIGHT_PASSED, report };
    }

    admission = null;
    admissionConsumed = false;
    coordinatorLayout = options.coordinatedSession.layout;
    const writerInventory = loadWriterInventory();
    const writers = enumerateWriters(writerInventory, env);
    const runnersForLive = options.runners || createDefaultRunners(env);
    const liveSnapshots = new Map();
    for (const writer of writers) {
      liveSnapshots.set(writer.id, captureWriterState(writer, {
        inventory: writerInventory,
        env,
        runners: runnersForLive,
        dashboardDir: canonicalDestination,
        allowOwnRestoreLock: true,
      }));
    }
    const session = options.coordinatedSession;
    for (const [id, prior] of (session.snapshotsById || new Map()).entries()) {
      const current = liveSnapshots.get(id);
      if (current && prior) {
        current.originallyActive = prior.originallyActive;
        current.originallyEnabled = prior.originallyEnabled;
        current.originallyRunning = prior.originallyRunning;
        current.restartPolicy = prior.restartPolicy ?? current.restartPolicy ?? null;
      }
    }
    const writerContext = {
      ...session.context,
      inventory: writerInventory,
      env,
      runners: runnersForLive,
      writers,
      snapshotsById: liveSnapshots,
      dashboardDir: canonicalDestination,
      allowOwnRestoreLock: true,
    };
    assertAllWritersQuiescentForAdmission(writerContext);
    admission = issueSignedAdmissionToken({
      layout: session.layout,
      runId: session.runId,
      journalId: session.journalId,
      snapshotsById: liveSnapshots,
      context: writerContext,
      env,
      privateKey: session.privateKey,
      bindings: {
        archiveSha256,
        destinationRoot: canonicalDestination,
        manifestArtifactId: manifest.artifact.id,
        releaseManifestDigest: bindingResult.expectedBinding.releaseManifestDigest,
        coordinatedManifestDigest: options.coordinatedManifestDigest
          || bindingResult.expectedBinding.dashboardStateId,
        writerInventoryDigest: session.writerInventoryDigest,
        actualDataGeneration: bindingResult.expectedBinding.actualDataGeneration,
      },
    });
    session.onAdmissionIssued?.(admission);
    const tokenPath = path.join(session.layout.workRoot, `restore-admission-${session.runId}.json`);
    writeFileAtomic(tokenPath, `${JSON.stringify(admission, null, 2)}\n`, 0o600);
    env.RESTORE_QUIESCENCE_ADMISSION_PATH = tokenPath;
    assertAdmissionBindings(admission, {
      archiveSha256,
      destinationRoot: canonicalDestination,
      manifestArtifactId: manifest.artifact.id,
      releaseManifestDigest: bindingResult.expectedBinding.releaseManifestDigest,
      actualDataGeneration: bindingResult.expectedBinding.actualDataGeneration,
      coordinatedManifestDigest: options.coordinatedManifestDigest,
      writerInventoryDigest: options.writerInventoryDigest,
    });

    const freshEvidence = readDestinationGenerationEvidence({
      releaseManifestPath: options.releaseManifestPath,
      actualDataGenerationPath: options.actualDataGenerationPath,
      releaseManifestDigest: options.releaseManifestDigest,
      actualDataGeneration: options.actualDataGeneration,
      env,
    });
    validateGenerationBindingForRestore({
      manifest,
      runtimeRoot: stagingRoot,
      inventory,
      destinationEvidence: freshEvidence,
    });

    ensurePrivateSubdir(layout.controlRoot, 'snapshot');
    const snapshotManifest = captureSnapshotToDisk({
      destinationRoot: canonicalDestination,
      snapshotRoot: layout.snapshotRoot,
      inventory,
    });
    updateJournal(journal, {
      phase: PHASE.SNAPSHOT_CAPTURED,
      snapshotDigest: snapshotManifest.digest,
    });
    writeJournal(layout.journalPath, journal, true);
    injectFault?.('after:snapshot-capture');

    const assertMutationGate = () => {
      assertCoordinatedLockHeld({
        layout: session.layout,
        operation: 'restore',
        env,
      });
      assertAllWritersQuiescentForAdmission(writerContext, admission.writers);
    };
    swapRuntimeTree({
      destinationRoot: canonicalDestination,
      stagingRoot,
      snapshotManifest,
      manifestPaths,
      staleDestinationPaths: staleOnly,
      journal,
      journalPath: layout.journalPath,
      dryRun: false,
      injectFault,
      persist: true,
      assertMutationGate,
      onSafetyChange: () => publishRestartSafety(
        coordinatedSession,
        journal,
        layout.journalPath,
      ),
    });
    updateJournal(journal, { phase: PHASE.SWAPPED });
    writeJournal(layout.journalPath, journal, true);
    injectFault?.('after:swap');

    verifyInstalledRuntime({
      destinationRoot: canonicalDestination,
      manifest,
      inventory,
      toolingRoot: path.join(extractRoot, 'tooling'),
    });
    updateJournal(journal, {
      phase: PHASE.POST_VERIFY_PASSED,
      mutationStatus: MUTATION_STATUS.REPLACEMENT_VERIFIED,
      mutationVerifiedAt: nowIso(),
    });
    writeJournal(layout.journalPath, journal, true);
    publishRestartSafety(coordinatedSession, journal, layout.journalPath);
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
      dryRun: false,
      stagedTreeDigest: stagedDigest,
      snapshotDigest: snapshotManifest.digest,
      archiveSha256,
    };
    updateJournal(journal, {
      phase: PHASE.COMPLETE,
      report,
      completedSwaps: [],
      completedDeletes: [],
      introducedPaths: [],
    });
    writeJournal(layout.journalPath, journal, true);
    cleanupControlArtifacts(layout, { keepJournal: true });
    fsyncPath(layout.controlRoot, true);
    if (admission && coordinatorLayout && options.skipAdmissionConsumption !== true) {
      consumeAdmissionToken(coordinatorLayout, admission);
      admissionConsumed = true;
      options.coordinatedSession?.onAdmissionConsumed?.();
    }

    return {
      dryRun: false,
      resumed: resumeFromJournal,
      phase: PHASE.COMPLETE,
      report,
    };
  } catch (error) {
    if (admission && !admissionConsumed && coordinatorLayout) {
      revokeAdmissionToken(coordinatorLayout, admission, 'staged_restore_failed');
    }
    if (persist && journal && journal.phase !== PHASE.COMPLETE) {
      appendFailureHistory(journal, 'restore', error);
      updateJournal(journal, { phase: PHASE.FAILED, error: boundedFailureMessage(error) });
      writeJournal(layout.journalPath, journal, true);
      publishRestartSafety(coordinatedSession, journal, layout.journalPath);
      if (
        needsRollbackFirst(journal)
        && journal.snapshotDigest
        && fs.existsSync(layout.snapshotRoot)
      ) {
        try {
          performRollback({
            destinationRoot: canonicalDestination,
            layout,
            journal,
            journalPath: layout.journalPath,
            inventory: loadBackupStateInventory(),
            injectFault,
            persist: true,
            onSafetyChange: () => publishRestartSafety(
              coordinatedSession,
              journal,
              layout.journalPath,
            ),
          });
        } catch (rollbackError) {
          if (admission && !admissionConsumed && coordinatorLayout) {
            revokeAdmissionToken(coordinatorLayout, admission, 'rollback_failed');
          }
          const combined = new Error(`${error.message}; rollback failed: ${rollbackError.message}`);
          const safety = publishRestartSafety(coordinatedSession, journal, layout.journalPath);
          throw safeError(combined, safety);
        }
      } else if (needsRollbackFirst(journal)) {
        const missingSnapshot = new Error('rollback verification unavailable: pre-restore snapshot is missing');
        appendFailureHistory(journal, 'rollback', missingSnapshot);
        error = new Error(`${error.message}; ${missingSnapshot.message}`);
        updateJournal(journal, {
          phase: PHASE.ROLLBACK_FAILED,
          mutationStatus: MUTATION_STATUS.UNVERIFIED,
          error: boundedFailureMessage(error),
        });
        writeJournal(layout.journalPath, journal, true);
        publishRestartSafety(coordinatedSession, journal, layout.journalPath);
      }
    }
    const safety = publishRestartSafety(coordinatedSession, journal, layout.journalPath);
    throw safeError(error, safety);
  } finally {
    restoreLock?.release();
    if (dryRun && fs.existsSync(workRoot)) fs.rmSync(workRoot, { recursive: true, force: true });
  }
}

module.exports = {
  JOURNAL_KIND,
  JOURNAL_SCHEMA_VERSION,
  JOURNAL_BASENAME: JOURNAL_FILENAME,
  FAILURE_HISTORY_LIMIT,
  FAILURE_MESSAGE_MAX_BYTES,
  PHASE,
  MUTATION_STATUS,
  runStagedRestore,
  readJournal,
  journalPathForDestination,
  listTreeFiles,
  runtimeRelativePathsFromManifest,
  verifyManifestRuntimeChecksums,
  buildReplacementTree,
  swapRuntimeTree,
  parseFaultSchedule,
  restoreIdForDestination,
  cleanupControlArtifacts,
  stagedRestoreRestartSafety,
  performRollback,
  JOURNAL_MAX_BYTES,
};
