'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { buildBackupBundle } = require('./build-backup-bundle');
const { verifyBackupBundleArchive } = require('./backup-bundle-verify');
const { sha256File } = require('./backup-verify');
const { loadBackupStateInventory } = require('./backup-bundle-inventory');
const { scanActiveRestoreSubjects } = require('./restore-generation-binding');
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
const { assertJournalBinding } = require('./coordinated-journal-binding');
const { createDefaultRunners } = require('./ops-command-runners');
const {
  discoverWriters,
  ensureQuiescentForSnapshot,
  verifySnapshotBoundary,
  restartWritersByPhase,
  computeActualDataGeneration,
  assertActualGenerationStable,
  auditDeploymentDiscovery,
} = require('./writer-quiescence');
const { runPostRestartHealthChecks } = require('./coordinated-backup-health');
const { loadWriterInventory, writerInventoryDigest } = require('./writer-inventory');
const { writeFileAtomic } = require('./restore-durable-io');

const COORDINATED_MANIFEST_KIND = 'darkfinances-coordinated-backup-manifest';
const COORDINATED_MANIFEST_SCHEMA_VERSION = 2;

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
  if (!releaseDigest) throw new Error('coordinated manifest requires release manifest digest');
  return {
    kind: COORDINATED_MANIFEST_KIND,
    schemaVersion: COORDINATED_MANIFEST_SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    runId: journal.runId,
    journalId: journal.journalId,
    provenanceOnly: true,
    generation: {
      bundleArtifactId: bundleManifest.artifact.id,
      bundleManifestDigest: sha256File(bundleManifestPath),
      runtimeInventoryDigest: bundleManifest.runtimeState.inventoryDigest,
      releaseManifestDigest: releaseDigest,
      actualDataGeneration,
      writerInventoryDigest: journal.inventory.writerInventoryDigest,
    },
    artifacts: {
      bundleArchive: path.basename(journal.artifacts.bundleArchive),
      bundleManifest: path.basename(journal.artifacts.bundleManifest),
      releaseManifest: journal.artifacts.releaseManifest
        ? path.basename(journal.artifacts.releaseManifest)
        : null,
      actualArchive: actualArchivePath ? path.basename(actualArchivePath) : null,
    },
    bindingsAcceptedBy: ['darkfinances-staged-restore-generation-binding'],
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
    shouldInterrupt: options.shouldInterrupt || shouldInterrupt,
  };
}

function preQuiescedMode(env = process.env) {
  if (env.BACKUP_QUIESCE === '0') {
    throw new Error('BACKUP_QUIESCE=0 is forbidden; use BACKUP_PRE_QUIESCED=1 only when writers were stopped out-of-band');
  }
  return env.BACKUP_PRE_QUIESCED === '1';
}

function needsBackupPublish(journal) {
  if (!journal) return true;
  return journal.phase === PHASE.INIT
    || journal.phase === PHASE.WRITERS_CAPTURED
    || journal.phase === PHASE.QUIESCENCE_VERIFIED;
}

function loadGenerationBindingsFromJournal(journal) {
  if (!journal?.artifacts?.coordinatedManifest) {
    throw new Error('coordinated manifest missing during journal resume');
  }
  const manifestPath = journal.artifacts.coordinatedManifest;
  if (!fs.existsSync(manifestPath)) {
    throw new Error('coordinated manifest missing during journal resume');
  }
  const coordinated = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  return {
    actualDataGeneration: coordinated.generation?.actualDataGeneration ?? null,
    boundReleaseGeneration: coordinated.generation?.releaseManifestDigest ?? null,
  };
}

function resultFromJournalArtifacts(journal) {
  return {
    ok: true,
    resumed: true,
    bundleArchive: journal.artifacts.bundleArchive || null,
    actualArchive: journal.artifacts.actualArchive || null,
    releaseManifest: journal.artifacts.releaseManifest || null,
    coordinatedManifest: journal.artifacts.coordinatedManifest || null,
    journal,
    actualDataGeneration: null,
    bundleArtifactId: null,
  };
}

async function restartAll(context, snapshotsById) {
  const results = [];
  for (const phase of context.inventory.restartPhases) {
    results.push(...await restartWritersByPhase(context, snapshotsById, phase));
  }
  return results;
}

async function prepareWriterContext({
  journal,
  inventory,
  env,
  runners,
  dashboardDir,
  layout,
  includeActual,
  preQuiesced,
  runId,
  dryRun,
  coordinatorOptions = {},
}) {
  const snapshotsById = new Map();
  let discoverySnapshots;
  if (journal) {
    assertJournalBinding(journal, {
      layout,
      inventory,
      options: { dashboardDir, includeActualData: includeActual, preQuiesced },
    });
    runId = journal.runId || runId;
    const discovery = discoverWriters({ inventory, env, runners, dashboardDir });
    auditDeploymentDiscovery({ inventory, env, runners, dashboardDir });
    for (const snapshot of discovery.snapshots) snapshotsById.set(snapshot.id, snapshot);
    if (journal.preRunWriters?.length) {
      for (const prior of journal.preRunWriters) {
        const current = snapshotsById.get(prior.id);
        if (current) {
          current.originallyActive = prior.originallyActive;
          current.originallyEnabled = prior.originallyEnabled;
          current.originallyRunning = prior.originallyRunning;
          current.restartPolicy = prior.restartPolicy ?? current.restartPolicy ?? null;
        }
      }
    }
    journal.preRunWriters = [...snapshotsById.values()];
    discoverySnapshots = journal.preRunWriters;
  } else {
    const discovery = discoverWriters({ inventory, env, runners, dashboardDir });
    auditDeploymentDiscovery({ inventory, env, runners, dashboardDir });
    for (const snapshot of discovery.snapshots) snapshotsById.set(snapshot.id, snapshot);
    discoverySnapshots = discovery.snapshots;
  }
  const context = buildContext(
    coordinatorOptions,
    inventory,
    env,
    runners,
    dashboardDir,
    coordinatorOptions.shouldInterrupt,
  );
  context.writers = inventory.writers.filter((writer) => snapshotsById.has(writer.id));
  return { context, snapshotsById, discoverySnapshots, runId };
}

function resolveReleaseManifestInvocation(options, env, repoRoot) {
  const candidates = [
    { script: path.join(repoRoot, 'scripts/release-manifest.js'), cwd: repoRoot },
    { script: path.join(__dirname, '..', '..', 'scripts', 'release-manifest.js'), cwd: path.join(__dirname, '..', '..') },
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate.script)) return candidate;
  }
  if (typeof options.writeReleaseManifest === 'function') {
    return null;
  }
  throw new Error('release manifest tooling unavailable in relocated bundle; cannot stop writers for backup publish');
}

async function runCoordinatedBackup(options = {}) {
  const env = options.env || process.env;
  const dryRun = options.dryRun === true;
  const preQuiesced = options.preQuiesced === true || preQuiescedMode(env);
  const includeActual = options.includeActual === true || env.BACKUP_INCLUDE_ACTUAL_DATA === '1';
  const dashboardDir = path.resolve(options.dashboardDir || env.FINANCE_DASHBOARD_DIR || path.join(env.HOME || '', 'finance-dashboard'));
  const destination = path.resolve(options.destination || env.DARKFINANCES_BACKUP_DIR || path.join(env.HOME || '', 'darkfinances-backups'));
  const actualDataDir = path.resolve(options.actualDataDir || env.ACTUAL_DATA_DIR || path.join(env.HOME || '', 'actual', 'data'));
  const repoRoot = path.resolve(options.repoRoot || env.DARKFINANCES_REPO_ROOT || path.join(__dirname, '..', '..'));
  const runners = options.runners || createDefaultRunners(env, options);
  const inventory = options.inventory || loadWriterInventory();
  const layout = coordinatedLayoutForRoot(destination);
  let runId = options.runId || createRunId();
  const runOwnedArtifacts = [];
  let lock = null;
  let journal = options.resumeJournal || null;
  let snapshotsById = new Map();
  let primaryError = null;
  let interrupted = false;
  let result = null;
  let context = null;
  let actualDataGeneration = null;
  let boundReleaseGeneration = null;
  let discoverySnapshots = [];

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
    ({
      context,
      snapshotsById,
      discoverySnapshots,
      runId,
    } = await prepareWriterContext({
      journal,
      inventory,
      env,
      runners,
      dashboardDir,
      layout,
      includeActual,
      preQuiesced,
      runId,
      dryRun,
      coordinatorOptions: options,
    }));

    if (!journal) {
      journal = createRunJournal({
        runId,
        operation: 'backup',
        layout,
        writerInventory: inventory,
        preRunWriters: [...snapshotsById.values()],
        options: { includeActualData: includeActual, preQuiesced, dashboardDir },
      });
      journal.phase = PHASE.WRITERS_CAPTURED;
      if (!dryRun) writeRunJournal(layout.journalPath, journal);
    } else if (!dryRun) {
      writeRunJournal(layout.journalPath, journal);
    }

    if (dryRun) {
      return {
        ok: true,
        dryRun: true,
        plan: {
          stopPhases: preQuiesced ? [] : inventory.stopPhases,
          restartPhases: inventory.restartPhases,
          writers: discoverySnapshots,
          includeActual,
          preQuiesced,
        },
        journal,
      };
    }

    const publishNeeded = needsBackupPublish(journal);
    if (publishNeeded) {
      resolveReleaseManifestInvocation(options, env, repoRoot);
      await ensureQuiescentForSnapshot(context, snapshotsById, {
        stopIfNeeded: !preQuiesced,
        label: 'initial snapshot boundary',
      });
      journal.phase = PHASE.QUIESCENCE_VERIFIED;
      writeRunJournal(layout.journalPath, journal);
    } else {
      await verifySnapshotBoundary(context, snapshotsById, 'backup-complete-resume');
    }

    if (!publishNeeded) {
      const bindings = loadGenerationBindingsFromJournal(journal);
      actualDataGeneration = bindings.actualDataGeneration;
      boundReleaseGeneration = bindings.boundReleaseGeneration;
      result = resultFromJournalArtifacts(journal);
      result.actualDataGeneration = actualDataGeneration;
    } else {
      await verifySnapshotBoundary(context, snapshotsById, 'pre-dashboard-bundle');

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
      await verifySnapshotBoundary(context, snapshotsById, 'pre-publish-dashboard-bundle');

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
        await verifySnapshotBoundary(context, snapshotsById, 'pre-actual-hash');
        const beforeActualGeneration = computeActualDataGeneration(actualDataDir);
        const actualStaging = path.join(stagingDir, `actual-data-${timestamp}.tgz`);
        const tar = runners.tar([
          '-C', path.dirname(actualDataDir),
          '-czf', actualStaging,
          path.basename(actualDataDir),
        ]);
        if (tar.status !== 0) throw new Error(tar.stderr || 'actual data tar failed');
        assertActualGenerationStable(actualDataDir, beforeActualGeneration, 'actual data tree during tar');
        fs.chmodSync(actualStaging, 0o600);
        actualArchiveFinal = path.join(destination, path.basename(actualStaging));
        await verifySnapshotBoundary(context, snapshotsById, 'pre-publish-actual-archive');
        publishAtomic(actualArchiveFinal, actualStaging);
        writeChecksumSidecar(actualArchiveFinal);
        additionalBackupArgs.push(`--backup-additional-archive=${actualArchiveFinal}`);
        journal.artifacts.actualArchive = actualArchiveFinal;
        actualDataGeneration = beforeActualGeneration;
      }

      await verifySnapshotBoundary(context, snapshotsById, 'pre-release-manifest');
      const releaseManifestFinal = path.join(destination, `coordinated-release-${path.basename(bundleArchiveFinal, '.tgz')}.json`);
      if (typeof options.writeReleaseManifest === 'function') {
        options.writeReleaseManifest({
          releaseManifestPath: releaseManifestFinal,
          bundleManifestFinal,
          bundleArchiveFinal,
          additionalBackupArgs,
        });
      } else {
        const releaseManifest = resolveReleaseManifestInvocation(options, env, repoRoot);
        const release = runners.nodeScript(
          releaseManifest.script,
          [
            '--mode=backup',
            `--backup-manifest=${bundleManifestFinal}`,
            `--backup-archive=${bundleArchiveFinal}`,
            ...additionalBackupArgs,
            releaseManifestFinal,
          ],
          { cwd: releaseManifest.cwd },
        );
        if (release.status !== 0) throw new Error(release.stderr || release.stdout || 'release manifest failed');
      }
      fs.chmodSync(releaseManifestFinal, 0o600);
      journal.artifacts.releaseManifest = releaseManifestFinal;
      boundReleaseGeneration = sha256File(releaseManifestFinal);

      const coordinatedManifest = buildCoordinatedManifest({
        journal,
        bundleManifest,
        bundleManifestPath: bundleManifestFinal,
        releaseManifestPath: releaseManifestFinal,
        actualArchivePath: actualArchiveFinal,
        actualDataGeneration,
      });
      const coordinatedManifestFinal = path.join(destination, `coordinated-backup-${runId}.json`);
      writeFileAtomic(coordinatedManifestFinal, `${JSON.stringify(coordinatedManifest, null, 2)}\n`, 0o600);
      journal.artifacts.coordinatedManifest = coordinatedManifestFinal;
      journal.phase = PHASE.BACKUP_COMPLETE;
      writeRunJournal(layout.journalPath, journal);

      result = {
        ok: true,
        bundleArchive: bundleArchiveFinal,
        actualArchive: actualArchiveFinal,
        releaseManifest: releaseManifestFinal,
        coordinatedManifest: coordinatedManifestFinal,
        journal,
        actualDataGeneration,
        bundleArtifactId: bundleManifest.artifact.id,
      };
    }
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
    const shouldRestart = !dryRun && context && snapshotsById.size > 0
      && (journal?.phase === PHASE.BACKUP_COMPLETE
        || journal?.phase === PHASE.RESTART_COMPLETE
        || journal?.phase === PHASE.COMPLETE
        || journal?.phase === PHASE.RECOVERY_REQUIRED
        || primaryError);
    if (shouldRestart) {
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
        if (!primaryError && health.ok) {
          journal.phase = PHASE.HEALTH_VERIFIED;
          writeRunJournal(layout.journalPath, journal);
          journal.phase = PHASE.COMPLETE;
        } else if (!health.ok) {
          appendJournalError(journal, 'post-restart health verification failed');
          if (journal.phase !== PHASE.FAILED) journal.phase = PHASE.RECOVERY_REQUIRED;
        }
        try {
          writeRunJournal(layout.journalPath, journal);
        } catch {
          // best-effort
        }
      }
      const restartFailures = restartResults.filter((entry) => entry.ok === false);
      if (restartFailures.length > 0) {
        const failed = restartFailures.map((entry) => entry.id).join(', ');
        primaryError = primaryError
          ? new Error(`${primaryError.message}; restart failures: ${failed}`)
          : new Error(`restart failures: ${failed}`);
      } else if (!primaryError && !health.ok) {
        primaryError = new Error('post-restart health verification failed');
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
  preQuiescedMode,
  needsBackupPublish,
  loadGenerationBindingsFromJournal,
  resultFromJournalArtifacts,
};
