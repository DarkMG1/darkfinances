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
const {
  captureDashboardReleaseIdentity,
  runPostRestartHealthChecks,
  resolveActualServerDataDir,
} = require('./coordinated-backup-health');
const { loadWriterInventory, writerInventoryDigest } = require('./writer-inventory');
const { writeFileAtomic, publishFileDurable, publishSidecarFromStaging, writeChecksumSidecarDurable, fsyncPublishedFile } = require('./restore-durable-io');
const {
  createRunPublicationTracker,
  cleanupPartialRunPublication,
  assertArchivePublicationCommitted,
  isArchivePublicationCommitted,
} = require('./backup-publication-contract');
const {
  requireKeyringPath,
  readTrustedManifestFile,
  verifySignedManifestFile,
  resolveSigningPaths,
  signaturePathFor,
} = require('../../finance-dashboard/lib/release-signing');

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
  releaseSignaturePath = null,
  actualArchivePath = null,
  actualDataGeneration = null,
  dashboardReleaseIdentityDigest = null,
}) {
  const releaseDigest = releaseManifestPath && fs.existsSync(releaseManifestPath)
    ? sha256File(releaseManifestPath)
    : null;
  const releaseSignatureDigest = releaseSignaturePath && fs.existsSync(releaseSignaturePath)
    ? sha256File(releaseSignaturePath)
    : null;
  if (!releaseDigest) throw new Error('coordinated manifest requires release manifest digest');
  if (!releaseSignatureDigest) throw new Error('coordinated manifest requires release signature digest');
  if (!dashboardReleaseIdentityDigest) {
    throw new Error('coordinated manifest requires dashboard release identity digest');
  }
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
      releaseSignatureDigest,
      dashboardReleaseIdentityDigest,
      actualDataGeneration,
      writerInventoryDigest: journal.inventory.writerInventoryDigest,
    },
    artifacts: {
      bundleArchive: path.basename(journal.artifacts.bundleArchive),
      bundleManifest: path.basename(journal.artifacts.bundleManifest),
      releaseManifest: journal.artifacts.releaseManifest
        ? path.basename(journal.artifacts.releaseManifest)
        : null,
      releaseSignature: releaseSignaturePath
        ? path.basename(releaseSignaturePath)
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

function publishAtomic(finalPath, stagingPath, mode = 0o600, fault = null) {
  publishFileDurable(finalPath, stagingPath, mode, fault);
}

function writeChecksumSidecar(archivePath, fault = null) {
  return writeChecksumSidecarDurable(archivePath, fault);
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

const LEGACY_IDENTITY_RECOVERY_MESSAGE = 'coordinated backup predates dashboardReleaseIdentityDigest and release identity cannot be recovered from the journal or manifest; clear .darkfinances-coordinated/run-journal.json after verifying release-manifest.json matches the live deployment, then restart backup';

function persistBackupGenerationBindings(journal, bindings) {
  journal.generationBindings = {
    ...(journal.generationBindings || {}),
    ...bindings,
  };
  return journal;
}

function dashboardReleaseIdentityFromJournal(journal) {
  return journal?.generationBindings?.dashboardReleaseIdentityDigest ?? null;
}

function readCoordinatedManifestGeneration(journal) {
  const manifestPath = journal?.artifacts?.coordinatedManifest;
  if (!manifestPath || !fs.existsSync(manifestPath)) return null;
  const { buffer } = readTrustedManifestFile(manifestPath, {
    label: 'coordinated backup manifest',
  });
  const coordinated = JSON.parse(buffer.toString('utf8'));
  return coordinated.generation ?? null;
}

async function resolveDashboardReleaseIdentityDigest({
  journal,
  env,
  runners,
  dashboardDir,
  preQuiesced,
  snapshotsById,
  timeoutMs,
  pollMs,
  allowLegacyRecapture = false,
}) {
  const boundFromJournal = dashboardReleaseIdentityFromJournal(journal);
  if (boundFromJournal) return boundFromJournal;

  const generation = readCoordinatedManifestGeneration(journal);
  if (generation?.dashboardReleaseIdentityDigest) {
    persistBackupGenerationBindings(journal, {
      dashboardReleaseIdentityDigest: generation.dashboardReleaseIdentityDigest,
      identityBindingSource: 'coordinated_manifest',
    });
    return generation.dashboardReleaseIdentityDigest;
  }

  if (!allowLegacyRecapture && generation && !generation.dashboardReleaseIdentityDigest) {
    throw new Error(LEGACY_IDENTITY_RECOVERY_MESSAGE);
  }

  let digest;
  try {
    digest = await captureDashboardReleaseIdentity({
      env,
      runners,
      dashboardDir,
      preQuiesced,
      snapshotsById,
      timeoutMs,
      pollMs,
    });
  } catch (captureError) {
    if (generation && !generation.dashboardReleaseIdentityDigest) {
      throw new Error(LEGACY_IDENTITY_RECOVERY_MESSAGE);
    }
    throw captureError;
  }
  persistBackupGenerationBindings(journal, {
    dashboardReleaseIdentityDigest: digest,
    identityBindingSource: generation && !generation.dashboardReleaseIdentityDigest
      ? 'legacy_manifest_recapture'
      : 'live_capture',
  });
  return digest;
}

function loadGenerationBindingsFromJournal(journal) {
  const boundFromJournal = dashboardReleaseIdentityFromJournal(journal);
  if (boundFromJournal) {
    const generation = readCoordinatedManifestGeneration(journal);
    return {
      actualDataGeneration: generation?.actualDataGeneration
        ?? journal.generationBindings?.actualDataGeneration
        ?? null,
      boundReleaseGeneration: boundFromJournal,
    };
  }
  if (!journal?.artifacts?.coordinatedManifest) {
    throw new Error('coordinated manifest missing during journal resume');
  }
  const manifestPath = journal.artifacts.coordinatedManifest;
  if (!fs.existsSync(manifestPath)) {
    throw new Error('coordinated manifest missing during journal resume');
  }
  const generation = readCoordinatedManifestGeneration(journal);
  if (!generation) {
    throw new Error('coordinated manifest missing generation bindings during journal resume');
  }
  if (generation.dashboardReleaseIdentityDigest) {
    persistBackupGenerationBindings(journal, {
      dashboardReleaseIdentityDigest: generation.dashboardReleaseIdentityDigest,
      identityBindingSource: 'coordinated_manifest',
    });
    return {
      actualDataGeneration: generation.actualDataGeneration ?? null,
      boundReleaseGeneration: generation.dashboardReleaseIdentityDigest,
    };
  }
  throw new Error(LEGACY_IDENTITY_RECOVERY_MESSAGE);
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
    const discovery = discoverWriters({ inventory, env, runners, dashboardDir, preview: dryRun });
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
    const discovery = discoverWriters({ inventory, env, runners, dashboardDir, preview: dryRun });
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
  const injectFault = options.injectFault || null;
  const dashboardDir = path.resolve(options.dashboardDir || env.FINANCE_DASHBOARD_DIR || path.join(env.HOME || '', 'finance-dashboard'));
  const destination = path.resolve(options.destination || env.DARKFINANCES_BACKUP_DIR || path.join(env.HOME || '', 'darkfinances-backups'));
  const actualDataDir = resolveActualServerDataDir(env, options);
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
  let runPublication = null;

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
      boundReleaseGeneration = await resolveDashboardReleaseIdentityDigest({
        journal,
        env,
        runners,
        dashboardDir,
        preQuiesced,
        snapshotsById,
        timeoutMs: options.healthTimeoutMs || undefined,
        pollMs: options.healthPollMs || undefined,
        allowLegacyRecapture: true,
      });
      writeRunJournal(layout.journalPath, journal);
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
      try {
        const bindings = loadGenerationBindingsFromJournal(journal);
        actualDataGeneration = bindings.actualDataGeneration;
        boundReleaseGeneration = bindings.boundReleaseGeneration;
      } catch (error) {
        if (error.message !== LEGACY_IDENTITY_RECOVERY_MESSAGE) throw error;
        boundReleaseGeneration = await resolveDashboardReleaseIdentityDigest({
          journal,
          env,
          runners,
          dashboardDir,
          preQuiesced: true,
          snapshotsById,
          timeoutMs: options.healthTimeoutMs || undefined,
          pollMs: options.healthPollMs || undefined,
          allowLegacyRecapture: true,
        });
        writeRunJournal(layout.journalPath, journal);
        const generation = readCoordinatedManifestGeneration(journal);
        actualDataGeneration = generation?.actualDataGeneration ?? null;
      }
      result = resultFromJournalArtifacts(journal);
      result.actualDataGeneration = actualDataGeneration;
    } else {
      await verifySnapshotBoundary(context, snapshotsById, 'pre-dashboard-bundle');

      actualDataGeneration = includeActual ? computeActualDataGeneration(actualDataDir) : null;
      assertNoActiveSagaGenerationMismatch(dashboardDir, actualDataGeneration, includeActual);

      const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, 'Z');
      const stagingDir = fs.mkdtempSync(path.join(layout.workRoot, 'backup-'));
      runOwnedArtifacts.push(stagingDir);
      runPublication = createRunPublicationTracker();

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
      publishAtomic(bundleArchiveFinal, bundleArchiveStaging, 0o600, injectFault);
      runPublication.bundleArchive = bundleArchiveFinal;
      publishSidecarFromStaging(bundleManifestFinal, `${bundleArchiveStaging}.manifest.json`, 0o600, injectFault);
      runPublication.bundleManifest = bundleManifestFinal;
      writeChecksumSidecar(bundleArchiveFinal, injectFault);
      runPublication.bundleChecksumCommitted = true;
      assertArchivePublicationCommitted(bundleArchiveFinal, 'coordinated bundle archive');
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
        publishAtomic(actualArchiveFinal, actualStaging, 0o600, injectFault);
        writeChecksumSidecar(actualArchiveFinal, injectFault);
        runPublication.actualArchive = actualArchiveFinal;
        runPublication.actualChecksumCommitted = true;
        assertArchivePublicationCommitted(actualArchiveFinal, 'coordinated actual archive');
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
          { cwd: releaseManifest.cwd, env },
        );
        if (release.status !== 0) throw new Error(release.stderr || release.stdout || 'release manifest failed');
      }
      runPublication.releaseManifest = releaseManifestFinal;
      const keyringPath = requireKeyringPath(
        resolveSigningPaths({}, env).keyringPath,
        'coordinated backup release verification',
      );
      const { manifest: releaseManifestBody } = verifySignedManifestFile(
        releaseManifestFinal,
        keyringPath,
        { label: 'coordinated backup release manifest' },
      );
      fs.chmodSync(releaseManifestFinal, 0o600);
      fsyncPublishedFile(releaseManifestFinal, injectFault);
      const releaseSignatureFinal = signaturePathFor(releaseManifestFinal);
      if (!fs.existsSync(releaseSignatureFinal)) {
        throw new Error(`coordinated backup missing release signature: ${releaseSignatureFinal}`);
      }
      fs.chmodSync(releaseSignatureFinal, 0o600);
      fsyncPublishedFile(releaseSignatureFinal, injectFault);
      runPublication.releaseSignature = releaseSignatureFinal;
      runPublication.releaseEvidenceCommitted = true;
      journal.artifacts.releaseManifest = releaseManifestFinal;
      journal.artifacts.releaseSignature = releaseSignatureFinal;

      const coordinatedManifest = buildCoordinatedManifest({
        journal,
        bundleManifest,
        bundleManifestPath: bundleManifestFinal,
        releaseManifestPath: releaseManifestFinal,
        releaseSignaturePath: releaseSignatureFinal,
        actualArchivePath: actualArchiveFinal,
        actualDataGeneration,
        dashboardReleaseIdentityDigest: boundReleaseGeneration,
      });
      const coordinatedManifestFinal = path.join(destination, `coordinated-backup-${runId}.json`);
      writeFileAtomic(coordinatedManifestFinal, `${JSON.stringify(coordinatedManifest, null, 2)}\n`, 0o600, injectFault);
      runPublication.coordinatedManifest = coordinatedManifestFinal;
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
    cleanupPartialRunPublication(runPublication);
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
        const restartFailures = restartResults.filter((entry) => entry.ok === false);
        if (restartFailures.length > 0) {
          const failed = restartFailures.map((entry) => entry.id).join(', ');
          appendJournalError(journal, `restart failures: ${failed}`);
          if (journal.phase !== PHASE.FAILED && journal.phase !== PHASE.RECOVERY_REQUIRED) {
            journal.phase = PHASE.RECOVERY_REQUIRED;
          }
          primaryError = primaryError
            ? new Error(`${primaryError.message}; restart failures: ${failed}`)
            : new Error(`restart failures: ${failed}`);
        } else if (journal.phase !== PHASE.FAILED && journal.phase !== PHASE.RECOVERY_REQUIRED) {
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
        actualServerDataDir: actualDataDir,
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
          if (journal.phase !== PHASE.FAILED && journal.phase !== PHASE.RECOVERY_REQUIRED) {
            journal.phase = PHASE.RECOVERY_REQUIRED;
          }
          if (!primaryError) {
            primaryError = new Error('post-restart health verification failed');
          }
        }
        try {
          writeRunJournal(layout.journalPath, journal);
        } catch {
          // best-effort
        }
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
  persistBackupGenerationBindings,
  resolveDashboardReleaseIdentityDigest,
  loadGenerationBindingsFromJournal,
  readCoordinatedManifestGeneration,
  LEGACY_IDENTITY_RECOVERY_MESSAGE,
  resultFromJournalArtifacts,
  publishAtomic,
  writeChecksumSidecar,
  createRunPublicationTracker,
  cleanupPartialRunPublication,
  isArchivePublicationCommitted,
  assertArchivePublicationCommitted,
};
