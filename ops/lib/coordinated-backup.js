'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { buildBackupBundle } = require('./build-backup-bundle');
const { verifyBackupBundleArchive } = require('./backup-bundle-verify');
const { sha256File } = require('./backup-verify');
const { loadBackupStateInventory } = require('./backup-bundle-inventory');
const { scanActiveRestoreSubjects } = require('./restore-generation-binding');
const { buildAdmissionTokenForRestore } = require('./restore-quiescence-admission');
const {
  coordinatedLayoutForRoot,
  ensureCoordinatedControlRoot,
} = require('./coordinated-operation-layout');
const { acquireCoordinatedLock } = require('./coordinated-operation-lock');
const {
  PHASE,
  createRunJournal,
  readRunJournal,
  writeRunJournal,
  appendJournalError,
  isTerminalPhase,
} = require('./coordinated-run-journal');
const { createDefaultRunners } = require('./ops-command-runners');
const {
  discoverWriters,
  stopWritersByPhase,
  verifyAllQuiescent,
  restartWritersByPhase,
  writerStatesForAdmission,
  computeActualDataGeneration,
} = require('./writer-quiescence');
const { runPostRestartHealthChecks } = require('./coordinated-backup-health');
const { loadWriterInventory } = require('./writer-inventory');
const { writeFileAtomic } = require('./restore-durable-io');

const COORDINATED_MANIFEST_KIND = 'darkfinances-coordinated-backup-manifest';
const COORDINATED_MANIFEST_SCHEMA_VERSION = 1;

function createRunId() {
  return crypto.randomUUID();
}

function cleanupRunOwnedArtifacts(stagingPaths = []) {
  for (const target of stagingPaths) {
    if (!target) continue;
    try {
      if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}

function buildCoordinatedManifest({
  journal,
  bundleManifest,
  bundleManifestPath,
  releaseManifestPath,
  actualArchivePath = null,
  actualDataGeneration = null,
}) {
  const releaseDigest = releaseManifestPath && fs.existsSync(releaseManifestPath)
    ? sha256File(releaseManifestPath)
    : null;
  return {
    kind: COORDINATED_MANIFEST_KIND,
    schemaVersion: COORDINATED_MANIFEST_SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    runId: journal.runId,
    journalId: journal.journalId,
    generation: {
      bundleArtifactId: bundleManifest.artifact.id,
      bundleManifestDigest: sha256File(bundleManifestPath),
      runtimeInventoryDigest: bundleManifest.runtimeState.inventoryDigest,
      releaseManifestDigest: releaseDigest,
      actualDataGeneration,
      sourceCommit: bundleManifest.provenance.sourceCommit ?? null,
    },
    artifacts: {
      bundleArchive: path.basename(journal.artifacts.bundleArchive),
      bundleManifest: path.basename(journal.artifacts.bundleManifest),
      releaseManifest: journal.artifacts.releaseManifest
        ? path.basename(journal.artifacts.releaseManifest)
        : null,
      actualArchive: actualArchivePath ? path.basename(actualArchivePath) : null,
      admissionToken: journal.artifacts.admissionToken
        ? path.basename(journal.artifacts.admissionToken)
        : null,
    },
    bindingsAcceptedBy: ['darkfinances-staged-restore', 'darkfinances-restore-quiescence-admission'],
  };
}

function assertNoActiveSagaGenerationMismatch(dashboardDir, actualDataGeneration, includeActual) {
  const inventory = loadBackupStateInventory();
  const activeSubjects = scanActiveRestoreSubjects(dashboardDir, { inventory });
  if (activeSubjects.length === 0) return;
  if (includeActual && !actualDataGeneration) {
    throw new Error('active saga stores present but Actual data generation is unavailable');
  }
  if (activeSubjects.length > 0 && !includeActual) {
    throw new Error(`refusing backup with ${activeSubjects.length} active saga/journal subjects without Actual snapshot`);
  }
}

function publishAtomic(finalPath, stagingPath, mode = 0o600) {
  fs.renameSync(stagingPath, finalPath);
  fs.chmodSync(finalPath, mode);
}

function writeChecksumSidecar(archivePath) {
  const checksum = crypto.createHash('sha256').update(fs.readFileSync(archivePath)).digest('hex');
  fs.writeFileSync(`${archivePath}.sha256`, `${checksum}  ${path.basename(archivePath)}\n`, { mode: 0o600 });
  return checksum;
}

function buildContext(options, inventory, env, runners, dashboardDir, shouldInterrupt = () => false) {
  return {
    inventory,
    env,
    runners,
    dashboardDir,
    stopDeadlineMs: options.stopDeadlineMs || 60_000,
    pollMs: options.pollMs || 500,
    shouldInterrupt,
  };
}

async function restartAll(context, snapshotsById) {
  const results = [];
  for (const phase of context.inventory.restartPhases) {
    results.push(...await restartWritersByPhase(context, snapshotsById, phase));
  }
  return results;
}

async function runCoordinatedBackup(options = {}) {
  const env = options.env || process.env;
  const dryRun = options.dryRun === true;
  const quiesce = options.quiesce !== false;
  const includeActual = options.includeActual === true || env.BACKUP_INCLUDE_ACTUAL_DATA === '1';
  const dashboardDir = path.resolve(options.dashboardDir || env.FINANCE_DASHBOARD_DIR || path.join(env.HOME || '', 'finance-dashboard'));
  const destination = path.resolve(options.destination || env.DARKFINANCES_BACKUP_DIR || path.join(env.HOME || '', 'darkfinances-backups'));
  const actualDataDir = path.resolve(options.actualDataDir || env.ACTUAL_DATA_DIR || path.join(env.HOME || '', 'actual', 'data'));
  const repoRoot = path.resolve(options.repoRoot || env.DARKFINANCES_REPO_ROOT || path.join(__dirname, '..', '..'));
  const runners = options.runners || createDefaultRunners(env);
  const inventory = options.inventory || loadWriterInventory();
  const layout = coordinatedLayoutForRoot(destination);
  const runId = options.runId || createRunId();
  const runOwnedArtifacts = [];
  let lock = null;
  let journal = options.resumeJournal || null;
  const snapshotsById = new Map();
  let primaryError = null;
  let interrupted = false;
  let result = null;
  let context = null;
  let actualDataGeneration = null;
  let boundReleaseGeneration = null;

  const onSignal = (signal) => {
    interrupted = true;
    if (journal && !dryRun) {
      journal.phase = PHASE.RECOVERY_REQUIRED;
      appendJournalError(journal, `interrupted by ${signal}`);
      try {
        writeRunJournal(layout.journalPath, journal);
      } catch {
        // best-effort
      }
    }
  };

  if (!dryRun && options.registerSignalHandlers !== false) {
    process.once('SIGINT', () => onSignal('SIGINT'));
    process.once('SIGTERM', () => onSignal('SIGTERM'));
  }

  try {
    if (!dryRun) {
      fs.mkdirSync(layout.canonicalRoot, { recursive: true, mode: 0o700 });
      ensureCoordinatedControlRoot(layout);
      fs.mkdirSync(layout.workRoot, { recursive: true, mode: 0o700 });
    }

    if (!journal && !dryRun) {
      const existing = readRunJournal(layout.journalPath);
      if (existing && !isTerminalPhase(existing.phase)) journal = existing;
    }

    lock = acquireCoordinatedLock({ layout, operation: 'backup', dryRun, env });
    context = buildContext(
      options,
      inventory,
      env,
      runners,
      dashboardDir,
      options.shouldInterrupt || (() => interrupted),
    );

    const discovery = discoverWriters(context);
    context.writers = discovery.writers;
    for (const snapshot of discovery.snapshots) snapshotsById.set(snapshot.id, snapshot);

    if (!journal) {
      journal = createRunJournal({
        runId,
        operation: 'backup',
        layout,
        writerInventory: inventory,
        preRunWriters: discovery.snapshots,
        options: { includeActualData: includeActual, quiesce, dashboardDir },
      });
      journal.phase = PHASE.WRITERS_CAPTURED;
      if (!dryRun) writeRunJournal(layout.journalPath, journal);
    } else {
      for (const snapshot of journal.preRunWriters || []) {
        snapshotsById.set(snapshot.id, { ...snapshot });
      }
      context.writers = inventory.writers.filter((writer) => snapshotsById.has(writer.id));
    }

    if (dryRun) {
      return {
        ok: true,
        dryRun: true,
        plan: {
          stopPhases: inventory.stopPhases,
          restartPhases: inventory.restartPhases,
          writers: discovery.snapshots,
          includeActual,
          quiesce,
        },
        journal,
      };
    }

    if (quiesce) {
      for (const phase of inventory.stopPhases) {
        if (interrupted) throw new Error('interrupted during quiescence');
        const stopResult = await stopWritersByPhase(context, snapshotsById, phase);
        if (!stopResult.ok) throw new Error(stopResult.error || `stop failed at ${phase}`);
      }
      const verify = await verifyAllQuiescent(context, snapshotsById);
      if (!verify.ok) {
        const detail = verify.failures.map((entry) => `${entry.id}:${entry.reason}`).join(', ');
        throw new Error(`quiescence verification failed: ${detail}`);
      }
      journal.phase = PHASE.QUIESCENCE_VERIFIED;
      writeRunJournal(layout.journalPath, journal);
    }

    actualDataGeneration = includeActual ? computeActualDataGeneration(actualDataDir) : null;
    assertNoActiveSagaGenerationMismatch(dashboardDir, actualDataGeneration, includeActual);

    const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, 'Z');
    const stagingDir = fs.mkdtempSync(path.join(layout.workRoot, 'backup-'));
    runOwnedArtifacts.push(stagingDir);

    const bundleArchiveStaging = path.join(stagingDir, `dashboard-runtime-backup-bundle-${timestamp}.tgz`);
    const bundleManifest = (options.buildBackupBundle || buildBackupBundle)({
      dashboardDir,
      archivePath: bundleArchiveStaging,
      provenance: { actualDataGeneration },
    });
    verifyBackupBundleArchive({ archivePath: bundleArchiveStaging });

    const bundleArchiveFinal = path.join(destination, path.basename(bundleArchiveStaging));
    const bundleManifestFinal = `${bundleArchiveFinal}.manifest.json`;
    publishAtomic(bundleArchiveFinal, bundleArchiveStaging);
    fs.copyFileSync(`${bundleArchiveStaging}.manifest.json`, bundleManifestFinal);
    fs.chmodSync(bundleManifestFinal, 0o600);
    writeChecksumSidecar(bundleArchiveFinal);
    journal.artifacts.bundleArchive = bundleArchiveFinal;
    journal.artifacts.bundleManifest = bundleManifestFinal;

    let actualArchiveFinal = null;
    const additionalBackupArgs = [];
    if (includeActual) {
      const actualStaging = path.join(stagingDir, `actual-data-${timestamp}.tgz`);
      const tar = spawnSync('tar', [
        '-C', path.dirname(actualDataDir),
        '-czf', actualStaging,
        path.basename(actualDataDir),
      ], { encoding: 'utf8' });
      if (tar.status !== 0) throw new Error(tar.stderr || 'actual data tar failed');
      fs.chmodSync(actualStaging, 0o600);
      actualArchiveFinal = path.join(destination, path.basename(actualStaging));
      publishAtomic(actualArchiveFinal, actualStaging);
      writeChecksumSidecar(actualArchiveFinal);
      additionalBackupArgs.push(`--backup-additional-archive=${actualArchiveFinal}`);
      journal.artifacts.actualArchive = actualArchiveFinal;
    }

    const releaseManifestFinal = path.join(destination, `coordinated-release-${path.basename(bundleArchiveFinal, '.tgz')}.json`);
    if (typeof options.writeReleaseManifest === 'function') {
      options.writeReleaseManifest({
        releaseManifestPath: releaseManifestFinal,
        bundleManifestFinal,
        bundleArchiveFinal,
        additionalBackupArgs,
      });
    } else {
      const release = spawnSync(process.execPath, [
        path.join(repoRoot, 'scripts/release-manifest.js'),
        '--mode=backup',
        `--backup-manifest=${bundleManifestFinal}`,
        `--backup-archive=${bundleArchiveFinal}`,
        ...additionalBackupArgs,
        releaseManifestFinal,
      ], { encoding: 'utf8', cwd: repoRoot });
      if (release.status !== 0) throw new Error(release.stderr || release.stdout || 'release manifest failed');
    }
    fs.chmodSync(releaseManifestFinal, 0o600);
    journal.artifacts.releaseManifest = releaseManifestFinal;

    const coordinatedManifest = buildCoordinatedManifest({
      journal,
      bundleManifest,
      bundleManifestPath: bundleManifestFinal,
      releaseManifestPath: releaseManifestFinal,
      actualArchivePath: actualArchiveFinal,
      actualDataGeneration,
    });
    boundReleaseGeneration = coordinatedManifest.generation.releaseManifestDigest;
    const coordinatedManifestFinal = path.join(destination, `coordinated-backup-${runId}.json`);
    writeFileAtomic(coordinatedManifestFinal, `${JSON.stringify(coordinatedManifest, null, 2)}\n`, 0o600);
    journal.artifacts.coordinatedManifest = coordinatedManifestFinal;

    const admissionToken = buildAdmissionTokenForRestore({
      archiveSha256: sha256File(bundleArchiveFinal),
      destinationRoot: dashboardDir,
      manifestArtifactId: bundleManifest.artifact.id,
      releaseManifestDigest: coordinatedManifest.generation.releaseManifestDigest,
      actualDataGeneration,
      writers: writerStatesForAdmission(snapshotsById),
      ttlMs: options.admissionTtlMs,
    });
    const admissionPath = path.join(destination, `quiescence-admission-${runId}.json`);
    writeFileAtomic(admissionPath, `${JSON.stringify(admissionToken, null, 2)}\n`, 0o600);
    journal.artifacts.admissionToken = admissionPath;
    journal.phase = PHASE.BACKUP_COMPLETE;
    writeRunJournal(layout.journalPath, journal);

    result = {
      ok: true,
      bundleArchive: bundleArchiveFinal,
      actualArchive: actualArchiveFinal,
      releaseManifest: releaseManifestFinal,
      coordinatedManifest: coordinatedManifestFinal,
      admissionTokenPath: admissionPath,
      journal,
      actualDataGeneration,
      bundleArtifactId: bundleManifest.artifact.id,
    };
  } catch (error) {
    primaryError = error;
    cleanupRunOwnedArtifacts(runOwnedArtifacts);
    if (journal && !dryRun) {
      appendJournalError(journal, error.message);
      const recoveryRequired = interrupted
        || String(error.message).includes('interrupted during quiescence');
      journal.phase = recoveryRequired ? PHASE.RECOVERY_REQUIRED : PHASE.FAILED;
      try {
        writeRunJournal(layout.journalPath, journal);
      } catch {
        // best-effort
      }
    }
  } finally {
    if (!dryRun && quiesce && context && snapshotsById.size > 0) {
      const restartResults = await restartAll(context, snapshotsById);
      if (journal) {
        journal.restartResults = restartResults;
        if (journal.phase !== PHASE.FAILED && journal.phase !== PHASE.RECOVERY_REQUIRED) {
          journal.phase = PHASE.RESTART_COMPLETE;
        }
        try {
          writeRunJournal(layout.journalPath, journal);
        } catch {
          // best-effort
        }
      }

      const health = await runPostRestartHealthChecks({
        writers: context.writers || [],
        snapshotsById,
        env,
        runners,
        expectedActualGeneration: actualDataGeneration,
        expectedReleaseGeneration: boundReleaseGeneration,
        timeoutMs: options.healthTimeoutMs || undefined,
        pollMs: options.healthPollMs || undefined,
      });
      if (journal) {
        journal.healthResults = health.results;
        if (!primaryError && health.ok) journal.phase = PHASE.COMPLETE;
        else if (!health.ok) {
          appendJournalError(journal, 'post-restart health verification failed');
          if (journal.phase !== PHASE.FAILED) journal.phase = PHASE.RECOVERY_REQUIRED;
        }
        try {
          writeRunJournal(layout.journalPath, journal);
        } catch {
          // best-effort
        }
      }
      if (primaryError && restartResults.some((entry) => entry.ok === false)) {
        const failed = restartResults.filter((entry) => entry.ok === false).map((entry) => entry.id).join(', ');
        primaryError = new Error(`${primaryError.message}; restart failures: ${failed}`);
      }
    }
    if (lock) lock.release();
  }

  if (primaryError) throw primaryError;
  return result;
}

module.exports = {
  COORDINATED_MANIFEST_KIND,
  COORDINATED_MANIFEST_SCHEMA_VERSION,
  runCoordinatedBackup,
  buildCoordinatedManifest,
  assertNoActiveSagaGenerationMismatch,
  cleanupRunOwnedArtifacts,
  createRunId,
};
