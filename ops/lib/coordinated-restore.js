'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { sha256File } = require('./backup-verify');
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
  previewQuiescenceForRestore,
  restartWritersByPhase,
  auditDeploymentDiscovery,
} = require('./writer-quiescence');
const {
  captureDashboardReleaseIdentity,
  runPostRestartHealthChecks,
} = require('./coordinated-backup-health');
const { loadWriterInventory } = require('./writer-inventory');
const { runStagedRestore } = require('./staged-restore');
const { revokeAdmissionToken } = require('./restore-quiescence-admission');

function createRunId() {
  return crypto.randomUUID();
}

function preQuiescedRestoreMode(env = process.env) {
  return env.RESTORE_PRE_QUIESCED === '1';
}

function needsRestoreQuiescence(journal) {
  if (!journal) return true;
  return journal.phase === PHASE.INIT || journal.phase === PHASE.WRITERS_CAPTURED;
}

function needsStagedRestore(journal) {
  if (!journal) return true;
  return journal.phase === PHASE.INIT
    || journal.phase === PHASE.WRITERS_CAPTURED
    || journal.phase === PHASE.QUIESCENCE_VERIFIED;
}

function loadDashboardReleaseIdentityFromJournal(journal) {
  const digest = journal?.generationBindings?.dashboardReleaseIdentityDigest ?? null;
  if (!digest) {
    throw new Error('coordinated restore journal missing dashboard release identity digest');
  }
  return digest;
}

function persistRestoreGenerationBindings(journal, {
  dashboardReleaseIdentityDigest,
  releaseManifestDigest = null,
}) {
  journal.generationBindings = {
    ...(journal.generationBindings || {}),
    dashboardReleaseIdentityDigest,
    ...(releaseManifestDigest ? { releaseManifestDigest } : {}),
  };
  return journal;
}

async function restartAll(context, snapshotsById) {
  const results = [];
  for (const phase of context.inventory.restartPhases) {
    results.push(...await restartWritersByPhase(context, snapshotsById, phase));
  }
  return results;
}

async function runCoordinatedRestore(options = {}) {
  const env = options.env || process.env;
  const dryRun = options.dryRun === true;
  const archivePath = path.resolve(options.archivePath);
  const dashboardDir = path.resolve(options.destinationRoot || options.dashboardDir || env.FINANCE_DASHBOARD_DIR || path.join(env.HOME || '', 'finance-dashboard'));
  const coordinatorRoot = path.resolve(options.coordinatorRoot || env.DARKFINANCES_BACKUP_DIR || path.join(env.HOME || '', 'darkfinances-backups'));
  const layout = coordinatedLayoutForRoot(coordinatorRoot);
  const inventory = options.inventory || loadWriterInventory();
  const runners = options.runners || createDefaultRunners(env, options);
  let runId = options.runId || createRunId();
  let lock = null;
  let journal = options.resumeJournal || null;
  let snapshotsById = new Map();
  let context = null;
  let primaryError = null;
  let interrupted = false;
  const releaseManifestDigest = options.releaseManifestDigest || null;
  let boundDashboardReleaseIdentity = options.dashboardReleaseIdentityDigest || null;
  let outstandingAdmission = null;
  let admissionConsumed = false;
  const preQuiesced = options.preQuiesced === true || preQuiescedRestoreMode(env);

  const revokeOutstandingAdmission = (reasonCode) => {
    if (admissionConsumed || !outstandingAdmission) return;
    try {
      revokeAdmissionToken(layout, outstandingAdmission, reasonCode);
    } catch {
      // idempotent best-effort
    }
  };

  const onSignal = (signal) => {
    interrupted = true;
    revokeOutstandingAdmission(`signal_${signal.toLowerCase()}`);
    if (journal && !dryRun) {
      journal.phase = PHASE.RECOVERY_REQUIRED;
      appendJournalError(journal, `interrupted by ${signal}`);
      writeRunJournal(layout.journalPath, journal);
    }
  };

  if (!dryRun && options.registerSignalHandlers !== false) {
    process.once('SIGINT', () => onSignal('SIGINT'));
    process.once('SIGTERM', () => onSignal('SIGTERM'));
  }

  let restoreResult = null;
  let result = null;

  try {
    if (!dryRun) {
      fs.mkdirSync(layout.canonicalRoot, { recursive: true, mode: 0o700 });
      ensureCoordinatedControlRoot(layout);
      fs.mkdirSync(layout.workRoot, { recursive: true, mode: 0o700 });
    }

    if (!journal && !dryRun) {
      const existing = readRunJournal(layout.journalPath);
      if (existing && existing.operation === 'restore' && !isTerminalPhase(existing.phase)) journal = existing;
    }

    lock = acquireCoordinatedLock({ layout, operation: 'restore', dryRun, env });
    const discovery = discoverWriters({ inventory, env, runners, dashboardDir, preview: dryRun });
    auditDeploymentDiscovery({ inventory, env, runners, dashboardDir });
    for (const snapshot of discovery.snapshots) snapshotsById.set(snapshot.id, snapshot);
    context = {
      inventory,
      env,
      runners,
      dashboardDir,
      writers: discovery.writers,
      stopDeadlineMs: options.stopDeadlineMs || 60_000,
      pollMs: options.pollMs || 500,
      shouldInterrupt: options.shouldInterrupt || (() => interrupted),
    };

    if (dryRun) {
      const preview = await previewQuiescenceForRestore(context, snapshotsById, {
        label: 'restore dry-run boundary',
        failOnActive: env.RESTORE_DRY_RUN_STRICT === '1',
      });
      return {
        ok: preview.quiescent,
        dryRun: true,
        plan: {
          archivePath,
          archiveSha256: sha256File(archivePath),
          dashboardDir,
          writers: preview.writers,
          warnings: preview.warnings,
          quiescent: preview.quiescent,
        },
      };
    }

    if (!journal) {
      journal = createRunJournal({
        runId,
        operation: 'restore',
        layout,
        writerInventory: inventory,
        preRunWriters: discovery.snapshots,
        options: { includeActualData: false, preQuiesced, dashboardDir },
      });
      journal.phase = PHASE.WRITERS_CAPTURED;
      writeRunJournal(layout.journalPath, journal);
    } else {
      assertJournalBinding(journal, {
        layout,
        inventory,
        options: { dashboardDir, includeActualData: false, preQuiesced },
      });
      runId = journal.runId;
      for (const prior of journal.preRunWriters || []) {
        const current = snapshotsById.get(prior.id);
        if (current) {
          current.originallyActive = prior.originallyActive;
          current.originallyEnabled = prior.originallyEnabled;
          current.originallyRunning = prior.originallyRunning;
          current.restartPolicy = prior.restartPolicy ?? current.restartPolicy ?? null;
        }
      }
      journal.preRunWriters = [...snapshotsById.values()];
    }

    const quiescenceNeeded = needsRestoreQuiescence(journal);
    const stagedRestoreNeeded = needsStagedRestore(journal);

    if (!boundDashboardReleaseIdentity) {
      if (journal?.generationBindings?.dashboardReleaseIdentityDigest) {
        boundDashboardReleaseIdentity = journal.generationBindings.dashboardReleaseIdentityDigest;
      } else if (quiescenceNeeded || stagedRestoreNeeded) {
        boundDashboardReleaseIdentity = await captureDashboardReleaseIdentity({
          env,
          runners,
          dashboardDir,
          preQuiesced,
          snapshotsById,
          timeoutMs: options.healthTimeoutMs,
          pollMs: options.healthPollMs,
        });
        persistRestoreGenerationBindings(journal, {
          dashboardReleaseIdentityDigest: boundDashboardReleaseIdentity,
          releaseManifestDigest,
        });
        writeRunJournal(layout.journalPath, journal);
      } else {
        boundDashboardReleaseIdentity = loadDashboardReleaseIdentityFromJournal(journal);
      }
    }

    if (quiescenceNeeded) {
      await ensureQuiescentForSnapshot(context, snapshotsById, {
        stopIfNeeded: !preQuiesced,
        label: 'restore pre-staged boundary',
      });
      journal.phase = PHASE.QUIESCENCE_VERIFIED;
      writeRunJournal(layout.journalPath, journal);
    }

    let stagedRestoreResult = journal.restoreResult || null;
    if (stagedRestoreNeeded) {
      stagedRestoreResult = (options.runStagedRestore || runStagedRestore)({
        archivePath,
        destinationRoot: dashboardDir,
        confirm: true,
        dryRun: false,
        env: {
          ...env,
          COORDINATED_VERIFY_KEY_PATH: env.COORDINATED_VERIFY_KEY_PATH,
        },
        coordinatorRoot,
        layout,
        runners,
        releaseManifestDigest,
        actualDataGeneration: options.actualDataGeneration,
        coordinatedManifestDigest: options.coordinatedManifestDigest,
        writerInventoryDigest: journal.inventory.writerInventoryDigest,
        coordinatedSession: {
          layout,
          runId,
          journalId: journal.journalId,
          snapshotsById,
          context,
          privateKey: options.privateKey,
          writerInventoryDigest: journal.inventory.writerInventoryDigest,
          onAdmissionIssued: (token) => {
            outstandingAdmission = token;
          },
          onAdmissionConsumed: () => {
            admissionConsumed = true;
            outstandingAdmission = null;
          },
        },
      });

      journal.phase = PHASE.RESTORE_STAGED;
      journal.restoreResult = stagedRestoreResult;
      writeRunJournal(layout.journalPath, journal);
      admissionConsumed = true;
      outstandingAdmission = null;
    }

    restoreResult = stagedRestoreResult;
    result = {
      ok: true,
      restoreResult,
      journal,
      admissionConsumed: stagedRestoreNeeded ? true : admissionConsumed,
    };
  } catch (error) {
    primaryError = error;
    revokeOutstandingAdmission('restore_failed');
    if (journal && !dryRun) {
      appendJournalError(journal, error.message);
      journal.phase = interrupted ? PHASE.RECOVERY_REQUIRED : PHASE.FAILED;
      writeRunJournal(layout.journalPath, journal);
    }
  } finally {
    if (!dryRun && context && snapshotsById.size > 0) {
      revokeOutstandingAdmission('restart_without_consume');
      const restartResults = await restartAll(context, snapshotsById);
      if (journal) {
        journal.restartResults = restartResults;
        if (journal.phase !== PHASE.FAILED && journal.phase !== PHASE.RECOVERY_REQUIRED) {
          journal.phase = PHASE.RESTART_COMPLETE;
        }
        writeRunJournal(layout.journalPath, journal);
      }
      const health = await runPostRestartHealthChecks({
        writers: context.writers,
        snapshotsById,
        env,
        runners,
        expectedReleaseGeneration: boundDashboardReleaseIdentity,
        timeoutMs: options.healthTimeoutMs,
        pollMs: options.healthPollMs,
      });
      if (journal) {
        journal.healthResults = health.results;
        if (!primaryError && health.ok) {
          journal.phase = PHASE.HEALTH_VERIFIED;
          writeRunJournal(layout.journalPath, journal);
          journal.phase = PHASE.COMPLETE;
        } else if (!health.ok) {
          appendJournalError(journal, 'post-restart health verification failed');
          journal.phase = PHASE.RECOVERY_REQUIRED;
        }
        writeRunJournal(layout.journalPath, journal);
      }
      if (!primaryError && !health.ok) primaryError = new Error('post-restart health verification failed');
      const restartFailures = restartResults.filter((entry) => entry.ok === false);
      if (restartFailures.length > 0 && !primaryError) {
        primaryError = new Error(`restart failures: ${restartFailures.map((entry) => entry.id).join(', ')}`);
      }
    }
    if (lock) lock.release();
  }

  if (primaryError) throw primaryError;
  return result || { ok: true, journal };
}

module.exports = {
  runCoordinatedRestore,
  createRunId,
  preQuiescedRestoreMode,
  needsRestoreQuiescence,
  needsStagedRestore,
  loadDashboardReleaseIdentityFromJournal,
  persistRestoreGenerationBindings,
};
