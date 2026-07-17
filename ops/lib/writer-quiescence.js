'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { controlLayoutForDestination } = require('./restore-control-layout');
const { isProcessAlive } = require('./restore-instance-lock');
const { lockPathForLayout } = require('./restore-instance-lock');
const {
  enumerateWriters,
  loadWriterInventory,
  writersForPhase,
} = require('./writer-inventory');

const DEFAULT_STOP_DEADLINE_MS = 60_000;
const DEFAULT_VERIFY_POLL_MS = 500;
const UNKNOWN_STATE = 'unknown';

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
      snapshot.enabled = ['enabled', 'enabled-runtime', 'static', 'linked'].includes(normalizeState(enabled.state));
      snapshot.originallyActive = snapshot.active;
      snapshot.originallyEnabled = snapshot.enabled;
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
          snapshot.state = 'held';
          snapshot.active = true;
          snapshot.running = true;
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
  for (const snapshot of snapshots) {
    if (snapshot.state === UNKNOWN_STATE) {
      throw new Error(`writer ${snapshot.id} has unknown state${snapshot.error ? `: ${snapshot.error}` : ''}`);
    }
  }
  return { inventory, writers, snapshots };
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
  if (!snapshot.originallyActive && !snapshot.originallyEnabled && !snapshot.originallyRunning) {
    snapshot.restartAttempted = false;
    snapshot.restartOk = true;
    return { ok: true, skipped: true, reason: 'originally inactive' };
  }
  snapshot.restartAttempted = true;
  try {
    if (writer.type === 'systemd-timer' || writer.type === 'systemd-service') {
      if (!snapshot.originallyEnabled && writer.type === 'systemd-timer') {
        snapshot.restartOk = true;
        return { ok: true, skipped: true, reason: 'timer was not enabled' };
      }
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

function writerStatesForAdmission(snapshotsById) {
  const states = {};
  for (const [id, snapshot] of snapshotsById.entries()) {
    if (['inactive', 'dead', 'failed', 'stopped', 'absent', 'not-present'].includes(snapshot.state)) {
      states[id] = snapshot.state === 'not-present' ? 'not-present' : 'stopped';
    } else if (!snapshot.originallyActive && !snapshot.originallyRunning) {
      states[id] = 'inactive';
    } else {
      states[id] = 'stopped';
    }
  }
  return states;
}

function computeActualDataGeneration(actualDataDir) {
  if (!actualDataDir || !fs.existsSync(actualDataDir)) return null;
  const stat = fs.lstatSync(actualDataDir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error('actual data path must be a real directory');
  }
  const realRoot = fs.realpathSync(actualDataDir);
  const hash = crypto.createHash('sha256');
  const stack = [''];
  while (stack.length > 0) {
    const relative = stack.pop();
    const absolute = relative ? path.join(realRoot, relative) : realRoot;
    for (const name of fs.readdirSync(absolute).sort()) {
      const childRelative = relative ? `${relative}/${name}` : name;
      const childAbsolute = path.join(realRoot, childRelative);
      const childStat = fs.lstatSync(childAbsolute);
      if (childStat.isSymbolicLink()) {
        throw new Error(`actual data tree contains symlink: ${childRelative}`);
      }
      hash.update(childRelative);
      if (childStat.isDirectory()) {
        stack.push(childRelative);
      } else if (childStat.isFile()) {
        hash.update(fs.readFileSync(childAbsolute));
      }
    }
  }
  return hash.digest('hex');
}

module.exports = {
  DEFAULT_STOP_DEADLINE_MS,
  DEFAULT_VERIFY_POLL_MS,
  UNKNOWN_STATE,
  normalizeState,
  captureWriterState,
  preserveOriginalFlags,
  discoverWriters,
  isWriterQuiescent,
  waitForWriterQuiescence,
  stopWriter,
  stopWritersByPhase,
  verifyAllQuiescent,
  restartWriter,
  restartWritersByPhase,
  writerStatesForAdmission,
  computeActualDataGeneration,
};
