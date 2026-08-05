'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { controlLayoutForDestination } = require('./restore-control-layout');
const { isProcessAlive } = require('./restore-instance-lock');
const { lockPathForLayout } = require('./restore-instance-lock');
const {
  hashFileIncrementally,
  updateHashFromFile,
} = require('./backup-verify');
const {
  enumerateWriters,
  loadWriterInventory,
  writersForPhase,
} = require('./writer-inventory');
const { interpretCrontabListResult } = require('./ops-command-runners');

const DEFAULT_STOP_DEADLINE_MS = 60_000;
const DEFAULT_VERIFY_POLL_MS = 500;
const UNKNOWN_STATE = 'unknown';
const ACTUAL_GENERATION_LEGACY_VERSION = 1;
const ACTUAL_GENERATION_VERSION = 2;
const ACTUAL_GENERATION_PREFIX = 'actual-v2-sha256:';
const EMPTY_CONTENT_SHA256 = crypto.createHash('sha256').digest('hex');

function normalizeState(state) {
  const value = String(state || '').trim().toLowerCase();
  if (!value) return UNKNOWN_STATE;
  if (value === 'not-found' || value === 'could not be found') return 'not-present';
  return value;
}

function captureWriterState(writer, context) {
  const { runners, env, dashboardDir } = context;
  const snapshot = {
    id: writer.id,
    type: writer.type,
    active: false,
    enabled: false,
    running: false,
    state: UNKNOWN_STATE,
    originallyActive: false,
    originallyEnabled: false,
    originallyRunning: false,
    stopIssued: false,
    restartAttempted: false,
    restartOk: null,
    verifyOk: null,
    error: null,
  };

  try {
    if (writer.type === 'systemd-timer' || writer.type === 'systemd-service') {
      if (!runners.commandExists('systemctl')) {
        if (writer.optional === true) {
          snapshot.state = 'not-present';
          return snapshot;
        }
        throw new Error('systemctl unavailable');
      }
      const active = runners.systemctlIsActive(writer.scope, writer.unit);
      const enabled = runners.systemctlIsEnabled(writer.scope, writer.unit);
      snapshot.state = normalizeState(active.state);
      snapshot.active = ['active', 'activating', 'running'].includes(snapshot.state);
      snapshot.running = snapshot.active;
      const enabledState = normalizeState(enabled.state);
      // linked/static appear in snapshot.enabled for diagnostics; only enabled/enabled-runtime
      // are startup-enabled. originallyActive still drives restart for active linked units.
      snapshot.enabled = ['enabled', 'enabled-runtime', 'static', 'linked'].includes(enabledState);
      snapshot.originallyActive = snapshot.active;
      snapshot.originallyEnabled = ['enabled', 'enabled-runtime'].includes(enabledState);
      snapshot.originallyRunning = snapshot.running;
      return snapshot;
    }

    if (writer.type === 'docker-container') {
      if (!runners.commandExists('docker')) {
        if (writer.requireWhenEnv && env[writer.requireWhenEnv] === '1') {
          throw new Error('docker unavailable while actual container backup required');
        }
        snapshot.state = 'not-present';
        return snapshot;
      }
      const inspect = runners.dockerInspect(writer.containerName);
      const state = normalizeState((inspect.stdout || inspect.stderr || '').trim());
      snapshot.state = inspect.status === 0 ? state : 'not-present';
      snapshot.active = snapshot.state === 'running';
      snapshot.running = snapshot.active;
      snapshot.originallyActive = snapshot.active;
      snapshot.originallyRunning = snapshot.running;
      if (typeof runners.dockerInspectRestartPolicy === 'function') {
        snapshot.restartPolicy = runners.dockerInspectRestartPolicy(writer.containerName);
      } else {
        snapshot.restartPolicy = null;
      }
      return snapshot;
    }

    if (writer.type === 'restore-lock') {
      const destination = env.FINANCE_DASHBOARD_DIR || dashboardDir;
      if (!destination) {
        snapshot.state = 'absent';
        return snapshot;
      }
      try {
        const layout = controlLayoutForDestination(destination);
        const lockPath = lockPathForLayout(layout);
        if (!fs.existsSync(lockPath)) {
          snapshot.state = 'absent';
          return snapshot;
        }
        const payload = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        if (isProcessAlive(payload.pid)) {
          if (payload.pid === process.pid && context.allowOwnRestoreLock === true) {
            snapshot.state = 'absent';
            snapshot.active = false;
          } else {
            snapshot.state = 'held';
            snapshot.active = true;
            snapshot.running = true;
          }
        } else {
          snapshot.state = 'stale';
          snapshot.active = false;
        }
      } catch (error) {
        if (String(error.message).includes('symbolic link')) {
          snapshot.state = 'absent';
          return snapshot;
        }
        throw error;
      }
      snapshot.originallyActive = snapshot.active;
      snapshot.originallyRunning = snapshot.running;
      return snapshot;
    }

    throw new Error(`unsupported writer type: ${writer.type}`);
  } catch (error) {
    snapshot.state = UNKNOWN_STATE;
    snapshot.error = error.message;
    return snapshot;
  }
}

function discoverWriters(context) {
  const inventory = context.inventory || loadWriterInventory();
  const writers = enumerateWriters(inventory, context.env);
  const snapshots = writers.map((writer) => captureWriterState(writer, context));
  if (context.preview !== true) {
    for (const snapshot of snapshots) {
      if (snapshot.state === UNKNOWN_STATE) {
        throw new Error(`writer ${snapshot.id} has unknown state${snapshot.error ? `: ${snapshot.error}` : ''}`);
      }
    }
  }
  return { inventory, writers, snapshots };
}

function previewWritersForRestore(context, {
  label = 'restore dry-run',
  failOnActive = false,
} = {}) {
  const discovery = discoverWriters({ ...context, preview: true });
  const warnings = [];
  let quiescent = true;
  for (const writer of discovery.writers) {
    const snapshot = discovery.snapshots.find((entry) => entry.id === writer.id);
    if (!snapshot) continue;
    if (snapshot.state === UNKNOWN_STATE) {
      warnings.push(`${label}: writer ${writer.id} state unknown${snapshot.error ? `: ${snapshot.error}` : ''}`);
      quiescent = false;
      continue;
    }
    if (!isWriterQuiescent(writer, snapshot)) {
      warnings.push(`${label}: writer ${writer.id} not quiescent (state=${snapshot.state})`);
      quiescent = false;
    }
  }
  if (failOnActive && !quiescent) {
    throw new Error(`${label} writer preview failed: ${warnings.join('; ')}`);
  }
  return {
    quiescent,
    warnings,
    writers: discovery.snapshots,
  };
}

function isWriterQuiescent(writer, snapshot) {
  const allowed = new Set(writer.quiescentStates.map((entry) => normalizeState(entry)));
  return allowed.has(normalizeState(snapshot.state));
}

function preserveOriginalFlags(snapshot, fresh) {
  const preserved = {
    originallyActive: snapshot.originallyActive,
    originallyEnabled: snapshot.originallyEnabled,
    originallyRunning: snapshot.originallyRunning,
    restartPolicy: snapshot.restartPolicy,
  };
  Object.assign(snapshot, fresh, preserved);
}

async function waitForWriterQuiescence(writer, snapshot, context, deadlineMs) {
  const started = Date.now();
  while (Date.now() - started < deadlineMs) {
    if (typeof context.shouldInterrupt === 'function' && context.shouldInterrupt()) {
      throw new Error('interrupted during quiescence');
    }
    const fresh = captureWriterState(writer, context);
    preserveOriginalFlags(snapshot, fresh);
    if (isWriterQuiescent(writer, snapshot)) return true;
    if (writer.gracefulDrain && snapshot.state === 'deactivating') {
      await context.runners.sleep(context.pollMs || DEFAULT_VERIFY_POLL_MS);
      continue;
    }
    if (['activating', 'active', 'running', 'held', 'stale'].includes(snapshot.state)) {
      await context.runners.sleep(context.pollMs || DEFAULT_VERIFY_POLL_MS);
      continue;
    }
    if (snapshot.state === UNKNOWN_STATE) break;
    await context.runners.sleep(context.pollMs || DEFAULT_VERIFY_POLL_MS);
  }
  return isWriterQuiescent(writer, snapshot);
}

async function stopWriter(writer, snapshot, context) {
  const { runners, env } = context;
  if (typeof context.shouldInterrupt === 'function' && context.shouldInterrupt()) {
    throw new Error('interrupted during quiescence');
  }
  if (!snapshot.originallyActive && !snapshot.originallyRunning) {
    return { ok: true, skipped: true };
  }
  if (writer.type === 'systemd-timer' || writer.type === 'systemd-service') {
    const result = runners.systemctlStop(writer.scope, writer.unit);
    snapshot.stopIssued = true;
    if (result.status !== 0 && result.status !== 5) {
      return { ok: false, error: `systemctl stop ${writer.unit} failed` };
    }
    const quiesced = await waitForWriterQuiescence(writer, snapshot, context, context.stopDeadlineMs || DEFAULT_STOP_DEADLINE_MS);
    return quiesced
      ? { ok: true }
      : { ok: false, error: `${writer.id} did not quiesce (state=${snapshot.state})` };
  }
  if (writer.type === 'docker-container') {
    const composeFile = env[writer.composeFileEnv || 'ACTUAL_COMPOSE_FILE']
      || path.join(env.HOME || '', 'actual', 'compose.yml');
    if (snapshot.restartPolicy && typeof runners.dockerUpdateRestartPolicy === 'function') {
      runners.dockerUpdateRestartPolicy(writer.containerName, 'no');
    }
    const result = runners.dockerComposeStop(composeFile, writer.containerName);
    snapshot.stopIssued = true;
    if (result.status !== 0) {
      return { ok: false, error: `docker compose stop ${writer.containerName} failed` };
    }
    const quiesced = await waitForWriterQuiescence(writer, snapshot, context, context.stopDeadlineMs || DEFAULT_STOP_DEADLINE_MS);
    return quiesced
      ? { ok: true }
      : { ok: false, error: `${writer.id} container still running` };
  }
  if (writer.type === 'restore-lock') {
    if (snapshot.state === 'held') {
      return { ok: false, error: 'restore already in progress' };
    }
    return { ok: true, skipped: true };
  }
  return { ok: false, error: `cannot stop writer type ${writer.type}` };
}

async function stopWritersByPhase(context, snapshotsById, phase) {
  const inventory = context.inventory || loadWriterInventory();
  const writers = writersForPhase(context.writers || enumerateWriters(inventory, context.env), 'stopPhase', phase);
  const results = [];
  for (const writer of writers) {
    const snapshot = snapshotsById.get(writer.id);
    if (!snapshot) continue;
    const result = await stopWriter(writer, snapshot, context);
    results.push({ id: writer.id, ...result });
    if (!result.ok) return { ok: false, results, failedId: writer.id, error: result.error };
  }
  return { ok: true, results };
}

async function verifyAllQuiescent(context, snapshotsById) {
  const inventory = context.inventory || loadWriterInventory();
  const writers = context.writers || enumerateWriters(inventory, context.env);
  const failures = [];
  for (const writer of writers) {
    const snapshot = snapshotsById.get(writer.id);
    if (!snapshot) {
      failures.push({ id: writer.id, reason: 'missing snapshot' });
      continue;
    }
    const fresh = captureWriterState(writer, context);
    preserveOriginalFlags(snapshot, fresh);
    if (!isWriterQuiescent(writer, snapshot)) {
      failures.push({ id: writer.id, reason: `state=${snapshot.state}` });
    } else {
      snapshot.verifyOk = true;
    }
  }
  return failures.length === 0
    ? { ok: true }
    : { ok: false, failures };
}

async function restartWriter(writer, snapshot, context) {
  const { runners, env } = context;
  if (writer.type === 'systemd-service') {
    if (!snapshot.originallyActive && !snapshot.originallyRunning) {
      snapshot.restartAttempted = false;
      snapshot.restartOk = true;
      return { ok: true, skipped: true, reason: 'service was not active' };
    }
  } else if (writer.type === 'systemd-timer') {
    if (!snapshot.originallyEnabled && !snapshot.originallyActive) {
      snapshot.restartAttempted = false;
      snapshot.restartOk = true;
      return { ok: true, skipped: true, reason: 'timer was not enabled or active' };
    }
  } else if (!snapshot.originallyActive && !snapshot.originallyEnabled && !snapshot.originallyRunning) {
    snapshot.restartAttempted = false;
    snapshot.restartOk = true;
    return { ok: true, skipped: true, reason: 'originally inactive' };
  }
  snapshot.restartAttempted = true;
  try {
    if (writer.type === 'systemd-timer' || writer.type === 'systemd-service') {
      const result = runners.systemctlStart(writer.scope, writer.unit);
      if (result.status !== 0) {
        snapshot.restartOk = false;
        return { ok: false, error: `systemctl start ${writer.unit} failed` };
      }
      snapshot.restartOk = true;
      return { ok: true };
    }
    if (writer.type === 'docker-container') {
      if (!snapshot.originallyRunning) {
        snapshot.restartOk = true;
        return { ok: true, skipped: true, reason: 'container was not running' };
      }
      const composeFile = env[writer.composeFileEnv || 'ACTUAL_COMPOSE_FILE']
        || path.join(env.HOME || '', 'actual', 'compose.yml');
      const result = runners.dockerComposeStart(composeFile, writer.containerName);
      if (result.status !== 0) {
        snapshot.restartOk = false;
        return { ok: false, error: `docker compose start ${writer.containerName} failed` };
      }
      if (snapshot.restartPolicy && typeof runners.dockerUpdateRestartPolicy === 'function') {
        runners.dockerUpdateRestartPolicy(writer.containerName, snapshot.restartPolicy);
      }
      snapshot.restartOk = true;
      return { ok: true };
    }
    if (writer.type === 'restore-lock') {
      snapshot.restartOk = true;
      return { ok: true, skipped: true };
    }
    snapshot.restartOk = false;
    return { ok: false, error: `unsupported restart for ${writer.type}` };
  } catch (error) {
    snapshot.restartOk = false;
    return { ok: false, error: error.message };
  }
}

async function restartWritersByPhase(context, snapshotsById, phase) {
  const inventory = context.inventory || loadWriterInventory();
  const writers = writersForPhase(context.writers || enumerateWriters(inventory, context.env), 'restartPhase', phase);
  const results = [];
  for (const writer of writers) {
    const snapshot = snapshotsById.get(writer.id);
    if (!snapshot) continue;
    const result = await restartWriter(writer, snapshot, context);
    results.push({ id: writer.id, ...result });
  }
  return results;
}

function admissionStateFromSnapshot(snapshot) {
  if (!snapshot) return null;
  if (['inactive', 'dead', 'failed', 'stopped', 'exited', 'absent', 'not-present'].includes(snapshot.state)) {
    return snapshot.state === 'not-present' ? 'not-present' : 'stopped';
  }
  if (!snapshot.originallyActive && !snapshot.originallyRunning) {
    return 'inactive';
  }
  return null;
}

function writerStatesForAdmission(snapshotsById) {
  const states = {};
  for (const [id, snapshot] of snapshotsById.entries()) {
    const state = admissionStateFromSnapshot(snapshot);
    if (!state) {
      throw new Error(`writer ${id} is not quiescent (state=${snapshot.state}); cannot mint restore authority`);
    }
    states[id] = state;
  }
  return states;
}

function assertAllWritersQuiescentForAdmission(context, tokenWriters = null) {
  const inventory = context.inventory || loadWriterInventory();
  const writers = context.writers || enumerateWriters(inventory, context.env || process.env);
  const snapshotsById = context.snapshotsById || new Map();
  for (const writer of writers) {
    const snapshot = snapshotsById.get(writer.id);
    const fresh = captureWriterState(writer, context);
    if (snapshot) preserveOriginalFlags(snapshot, fresh);
    const subject = snapshot || fresh;
    if (!isWriterQuiescent(writer, subject)) {
      throw new Error(`writer ${writer.id} is not live-quiescent (state=${subject.state})`);
    }
    if (snapshot) Object.assign(snapshot, fresh, {
      originallyActive: snapshot.originallyActive,
      originallyEnabled: snapshot.originallyEnabled,
      originallyRunning: snapshot.originallyRunning,
    });
  }
  if (tokenWriters) {
    for (const [id, expected] of Object.entries(tokenWriters)) {
      const snapshot = snapshotsById.get(id);
      const state = admissionStateFromSnapshot(snapshot || { state: 'missing' });
      if (!state || state !== expected) {
        throw new Error(`admission writer claim ${id}=${expected} does not match live quiescence`);
      }
    }
  }
}

async function verifySnapshotBoundary(context, snapshotsById, label = 'snapshot boundary') {
  const verify = await verifyAllQuiescent(context, snapshotsById);
  if (!verify.ok) {
    const detail = verify.failures.map((entry) => `${entry.id}:${entry.reason}`).join(', ');
    throw new Error(`${label} quiescence verification failed: ${detail}`);
  }
  return verify;
}

async function ensureQuiescentForSnapshot(context, snapshotsById, {
  stopIfNeeded = true,
  label = 'snapshot boundary',
} = {}) {
  if (stopIfNeeded) {
    const inventory = context.inventory || loadWriterInventory();
    for (const phase of inventory.stopPhases) {
      const stopResult = await stopWritersByPhase(context, snapshotsById, phase);
      if (!stopResult.ok) throw new Error(stopResult.error || `stop failed at ${phase} (${label})`);
    }
  }
  return verifySnapshotBoundary(context, snapshotsById, label);
}

async function previewQuiescenceForRestore(context, snapshotsById, {
  label = 'restore preview',
  failOnActive = false,
} = {}) {
  const verify = await verifyAllQuiescent(context, snapshotsById);
  const warnings = (verify.failures || []).map((entry) => (
    `${label}: writer ${entry.id} not quiescent (${entry.reason})`
  ));
  if (failOnActive && !verify.ok) {
    throw new Error(`${label} quiescence preview failed: ${warnings.join('; ')}`);
  }
  return {
    quiescent: verify.ok,
    warnings,
    failures: verify.failures,
    writers: [...snapshotsById.values()],
  };
}

function auditLegacyOwesSnapshotCron(context) {
  const { env, runners } = context;
  if (env.FINANCE_EVENT_SYNC_CONFIGURED !== '1') return;

  if (!runners.commandExists('crontab')) {
    throw new Error('crontab command unavailable for deployment audit while FINANCE_EVENT_SYNC_CONFIGURED=1');
  }
  if (typeof runners.crontabList !== 'function' && typeof runners.readUserCrontabListing !== 'function') {
    throw new Error('crontab inspection unavailable for deployment audit while FINANCE_EVENT_SYNC_CONFIGURED=1');
  }

  let listing;
  try {
    if (typeof runners.readUserCrontabListing === 'function') {
      ({ listing } = runners.readUserCrontabListing());
    } else {
      ({ listing } = interpretCrontabListResult(runners.crontabList()));
    }
  } catch (error) {
    throw new Error(`legacy owes-snapshot cron audit failed: ${error.message}`);
  }

  const activeLines = findActiveLegacyOwesSnapshotCronLines(listing);
  if (activeLines.length > 0) {
    throw new Error(
      'legacy owes-snapshot.js cron entry must be removed before coordinated operations when FINANCE_EVENT_SYNC_CONFIGURED=1',
    );
  }
}

function isCrontabCommentOrEmpty(line) {
  const trimmed = String(line || '').trim();
  return !trimmed || trimmed.startsWith('#');
}

function findActiveLegacyOwesSnapshotCronLines(listing) {
  return String(listing || '')
    .split(/\r?\n/)
    .filter((line) => !isCrontabCommentOrEmpty(line))
    .filter((line) => /\bowes-snapshot\.js\b/.test(line));
}

function readUserCrontabListing(runners) {
  if (!runners.commandExists('crontab')) {
    throw new Error('crontab command unavailable');
  }
  if (typeof runners.readUserCrontabListing === 'function') {
    return runners.readUserCrontabListing();
  }
  if (typeof runners.crontabList !== 'function') {
    throw new Error('crontab inspection unavailable');
  }
  return interpretCrontabListResult(runners.crontabList());
}

function auditDeploymentDiscovery(context) {
  auditLegacyOwesSnapshotCron(context);
  const inventory = context.inventory || loadWriterInventory();
  const { runners, env } = context;
  const issues = [];
  const inventoriedUnits = new Set(
    inventory.writers
      .filter((entry) => entry.type === 'systemd-timer' || entry.type === 'systemd-service')
      .map((entry) => entry.unit),
  );
  if (runners.commandExists('systemctl') && typeof runners.listActiveSystemdUnits === 'function') {
    for (const unit of runners.listActiveSystemdUnits()) {
      if (!inventoriedUnits.has(unit) && /finance|actual|darkfinances/.test(unit)) {
        issues.push(`active systemd unit not inventoried: ${unit}`);
      }
    }
  }
  for (const writer of inventory.writers) {
    if (writer.configEnv && env[writer.configEnv] !== '1') {
      if (!writer.optional && !writer.requireWhenEnv) continue;
      if (writer.optional && typeof runners.systemctlIsActive === 'function' && writer.unit) {
        const active = runners.systemctlIsActive(writer.scope, writer.unit);
        if (['active', 'activating'].includes(normalizeState(active.state))) {
          issues.push(`optional writer ${writer.id} is active despite ${writer.configEnv} unset`);
        }
      }
    }
  }
  if (issues.length > 0) {
    throw new Error(`writer inventory deployment audit failed: ${issues.join('; ')}`);
  }
}

function assertActualGenerationStable(actualDataDir, expectedGeneration, label = 'actual generation') {
  const version = actualGenerationVersion(expectedGeneration);
  const current = computeActualDataGeneration(actualDataDir, { version });
  if (current !== expectedGeneration) {
    throw new Error(`${label} drift detected (${expectedGeneration} -> ${current})`);
  }
  return current;
}

function actualGenerationVersion(generation) {
  if (typeof generation !== 'string' || !generation) {
    throw new Error('actual data generation must be a non-empty string');
  }
  if (/^[a-f0-9]{64}$/.test(generation)) return ACTUAL_GENERATION_LEGACY_VERSION;
  if (new RegExp(`^${ACTUAL_GENERATION_PREFIX}[a-f0-9]{64}$`).test(generation)) {
    return ACTUAL_GENERATION_VERSION;
  }
  throw new Error('unsupported actual data generation format');
}

function resolveActualGenerationVersion(options) {
  const requested = typeof options === 'object' && options !== null
    ? options.version
    : options;
  if (requested == null || requested === ACTUAL_GENERATION_VERSION || requested === 'v2') {
    return ACTUAL_GENERATION_VERSION;
  }
  if (
    requested === ACTUAL_GENERATION_LEGACY_VERSION
    || requested === 'v1'
    || requested === 'legacy'
  ) {
    return ACTUAL_GENERATION_LEGACY_VERSION;
  }
  throw new Error(`unsupported Actual generation version: ${requested}`);
}

function normalizedActualPath(components) {
  if (!Array.isArray(components)) throw new Error('actual data path components must be an array');
  if (components.length === 0) return '.';
  return components.map((component) => {
    if (typeof component !== 'string' || !component || component.includes('\0') || component.includes('/')) {
      throw new Error('actual data tree contains an invalid path component');
    }
    const normalized = component.normalize('NFC');
    if (!normalized || normalized === '.' || normalized === '..' || normalized.includes('/')) {
      throw new Error(`actual data tree contains an unsafe normalized path component: ${component}`);
    }
    return normalized;
  }).join('/');
}

function compareCanonicalPath(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function lengthPrefix(buffer) {
  const prefix = Buffer.alloc(8);
  prefix.writeBigUInt64BE(BigInt(buffer.length));
  return Buffer.concat([prefix, buffer]);
}

function canonicalActualRecord({ path: relativePath, type, mode, size, contentDigest }) {
  const fields = [relativePath, type, String(mode), String(size), contentDigest];
  const body = Buffer.concat(fields.map((field) => lengthPrefix(Buffer.from(field, 'utf8'))));
  return lengthPrefix(body);
}

function actualMetadataFieldsEqual(left, right) {
  return [
    'dev',
    'ino',
    'mode',
    'nlink',
    'uid',
    'gid',
    'size',
    'mtimeMs',
    'ctimeMs',
  ].every((field) => left[field] === right[field]);
}

function assertActualMetadataStable(before, after, relativePath) {
  if (!actualMetadataFieldsEqual(before, after)) {
    throw new Error(`actual data entry changed while hashing: ${relativePath}`);
  }
}

function actualTreeDependencies(options) {
  const dependencies = typeof options === 'object' && options !== null
    ? (options.dependencies || {})
    : {};
  return {
    ...dependencies,
    lstatSync: dependencies.lstatSync || fs.lstatSync,
    realpathSync: dependencies.realpathSync || fs.realpathSync,
    readdirSync: dependencies.readdirSync || fs.readdirSync,
    hashFileIncrementally: dependencies.hashFileIncrementally || hashFileIncrementally,
    updateHashFromFile: dependencies.updateHashFromFile || updateHashFromFile,
  };
}

function assertActualDirectory(stat, relativePath) {
  if (stat.isSymbolicLink()) {
    throw new Error(`actual data tree contains symlink: ${relativePath}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`actual data entry has unsupported type: ${relativePath}`);
  }
}

function computeLegacyActualDataGeneration(realRoot, dependencies) {
  const hash = crypto.createHash('sha256');
  const stack = [{ raw: [], relative: '' }];
  while (stack.length > 0) {
    const { raw, relative } = stack.pop();
    const absolute = path.join(realRoot, ...raw);
    const directoryBefore = dependencies.lstatSync(absolute);
    assertActualDirectory(directoryBefore, relative || '.');
    const names = dependencies.readdirSync(absolute).sort();
    for (const name of names) {
      const childRaw = [...raw, name];
      const childRelative = relative ? `${relative}/${name}` : name;
      const childAbsolute = path.join(realRoot, ...childRaw);
      const childStat = dependencies.lstatSync(childAbsolute);
      if (childStat.isSymbolicLink()) {
        throw new Error(`actual data tree contains symlink: ${childRelative}`);
      }
      hash.update(childRelative);
      if (childStat.isDirectory()) {
        stack.push({ raw: childRaw, relative: childRelative });
      } else if (childStat.isFile()) {
        const { stat: hashedStat } = dependencies.updateHashFromFile(childAbsolute, hash, dependencies);
        assertActualMetadataStable(childStat, hashedStat, childRelative);
      } else {
        throw new Error(`actual data entry has unsupported type: ${childRelative}`);
      }
    }
    const directoryAfter = dependencies.lstatSync(absolute);
    assertActualDirectory(directoryAfter, relative || '.');
    assertActualMetadataStable(directoryBefore, directoryAfter, relative || '.');
  }
  return hash.digest('hex');
}

function computeCanonicalActualDataGeneration(realRoot, dependencies) {
  const records = [];
  const canonicalPaths = new Map();

  const visit = (rawComponents, normalizedComponents) => {
    const absolute = path.join(realRoot, ...rawComponents);
    const relativePath = normalizedActualPath(normalizedComponents);
    const before = dependencies.lstatSync(absolute);
    if (before.isSymbolicLink()) {
      throw new Error(`actual data tree contains symlink: ${relativePath}`);
    }

    const priorRawPath = canonicalPaths.get(relativePath);
    const rawPath = rawComponents.join('/');
    if (priorRawPath !== undefined && priorRawPath !== rawPath) {
      throw new Error(`actual data tree has normalized path collision: ${relativePath}`);
    }
    canonicalPaths.set(relativePath, rawPath);

    if (before.isFile()) {
      const hashed = dependencies.hashFileIncrementally(absolute, dependencies);
      assertActualMetadataStable(before, hashed.stat, relativePath);
      records.push({
        path: relativePath,
        type: 'file',
        mode: hashed.stat.mode & 0o7777,
        size: hashed.stat.size,
        contentDigest: hashed.sha256,
      });
      return;
    }

    if (!before.isDirectory()) {
      throw new Error(`actual data entry has unsupported type: ${relativePath}`);
    }

    records.push({
      path: relativePath,
      type: 'directory',
      mode: before.mode & 0o7777,
      size: 0,
      contentDigest: EMPTY_CONTENT_SHA256,
    });

    const children = dependencies.readdirSync(absolute).map((name) => ({
      name,
      normalized: normalizedActualPath([name]),
    })).sort((left, right) => compareCanonicalPath(left.normalized, right.normalized));
    for (let index = 1; index < children.length; index += 1) {
      if (children[index - 1].normalized === children[index].normalized) {
        throw new Error(
          `actual data tree has normalized path collision: ${normalizedActualPath([
            ...normalizedComponents,
            children[index].normalized,
          ])}`,
        );
      }
    }
    for (const child of children) {
      visit(
        [...rawComponents, child.name],
        [...normalizedComponents, child.normalized],
      );
    }

    const after = dependencies.lstatSync(absolute);
    assertActualDirectory(after, relativePath);
    assertActualMetadataStable(before, after, relativePath);
  };

  visit([], []);
  records.sort((left, right) => compareCanonicalPath(left.path, right.path));
  const hash = crypto.createHash('sha256');
  hash.update(lengthPrefix(Buffer.from('darkfinances-actual-data-generation', 'utf8')));
  hash.update(lengthPrefix(Buffer.from(String(ACTUAL_GENERATION_VERSION), 'utf8')));
  for (const record of records) hash.update(canonicalActualRecord(record));
  return `${ACTUAL_GENERATION_PREFIX}${hash.digest('hex')}`;
}

function computeActualDataGeneration(actualDataDir, options = {}) {
  if (!actualDataDir || !fs.existsSync(actualDataDir)) return null;
  const version = resolveActualGenerationVersion(options);
  const dependencies = actualTreeDependencies(options);
  const stat = dependencies.lstatSync(actualDataDir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error('actual data path must be a real directory');
  }
  const realRoot = dependencies.realpathSync(actualDataDir);
  const realStat = dependencies.lstatSync(realRoot);
  if (!realStat.isDirectory() || realStat.isSymbolicLink()) {
    throw new Error('actual data path must resolve to a real directory');
  }
  if (stat.dev !== realStat.dev || stat.ino !== realStat.ino) {
    throw new Error('actual data path changed before hashing');
  }
  const generation = version === ACTUAL_GENERATION_LEGACY_VERSION
    ? computeLegacyActualDataGeneration(realRoot, dependencies)
    : computeCanonicalActualDataGeneration(realRoot, dependencies);
  const after = dependencies.lstatSync(actualDataDir);
  if (!after.isDirectory() || after.isSymbolicLink() || !actualMetadataFieldsEqual(stat, after)) {
    throw new Error('actual data path changed while hashing');
  }
  return generation;
}

module.exports = {
  DEFAULT_STOP_DEADLINE_MS,
  DEFAULT_VERIFY_POLL_MS,
  UNKNOWN_STATE,
  normalizeState,
  captureWriterState,
  preserveOriginalFlags,
  discoverWriters,
  previewWritersForRestore,
  isWriterQuiescent,
  waitForWriterQuiescence,
  stopWriter,
  stopWritersByPhase,
  verifyAllQuiescent,
  restartWriter,
  restartWritersByPhase,
  writerStatesForAdmission,
  admissionStateFromSnapshot,
  assertAllWritersQuiescentForAdmission,
  verifySnapshotBoundary,
  ensureQuiescentForSnapshot,
  previewQuiescenceForRestore,
  auditDeploymentDiscovery,
  auditLegacyOwesSnapshotCron,
  findActiveLegacyOwesSnapshotCronLines,
  readUserCrontabListing,
  isCrontabCommentOrEmpty,
  assertActualGenerationStable,
  actualGenerationVersion,
  ACTUAL_GENERATION_LEGACY_VERSION,
  ACTUAL_GENERATION_PREFIX,
  ACTUAL_GENERATION_VERSION,
  canonicalActualRecord,
  computeActualDataGeneration,
  normalizedActualPath,
};
