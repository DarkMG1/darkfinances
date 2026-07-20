'use strict';

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { createDefaultRunners } = require('./ops-command-runners');
const { canonicalSerialize } = require('../../finance-dashboard/lib/release-schema');

const DEFAULT_HEALTH_TIMEOUT_MS = 30_000;
const DEFAULT_HEALTH_POLL_MS = 500;
const COMMIT_SHORT_PATTERN = /^[0-9a-f]{7,40}$/i;
const LOCK_SHA256_PATTERN = /^[a-f0-9]{64}$/;
const CONTRACT_FINGERPRINT_PATTERN = /^([a-f0-9]{16}|[a-z][a-z0-9-]*)$/i;

function redactDiagnostics(entry) {
  const clone = { ...entry };
  if (clone.url) clone.url = String(clone.url).replace(/token=[^&]+/gi, 'token=[redacted]');
  return clone;
}

function unwrapPingPayload(body) {
  if (body && typeof body === 'object' && !Array.isArray(body) && body.data && typeof body.data === 'object') {
    return body.data;
  }
  return body;
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function assertFinanceApiTokenForLivePing(env = process.env) {
  const token = env.FINANCE_API_TOKEN;
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('FINANCE_API_TOKEN must be a non-empty string for live dashboard release identity capture');
  }
}

function normalizeReleaseIdentity(release) {
  if (release == null || typeof release !== 'object' || Array.isArray(release)) return null;
  if (typeof release.dirty !== 'boolean') return null;

  const commit = nonEmptyString(release.commit);
  const lockSha256 = nonEmptyString(release.lockSha256);
  const contract = nonEmptyString(release.contract);
  const appVersion = nonEmptyString(release.appVersion);
  const builtAt = nonEmptyString(release.builtAt);
  if (!commit || !lockSha256 || !contract || !appVersion || !builtAt) return null;
  if (!COMMIT_SHORT_PATTERN.test(commit)) return null;
  if (!LOCK_SHA256_PATTERN.test(lockSha256)) return null;
  if (!CONTRACT_FINGERPRINT_PATTERN.test(contract)) return null;
  if (!Number.isFinite(Date.parse(builtAt))) return null;

  return {
    commit,
    dirty: release.dirty,
    lockSha256,
    contract,
    appVersion,
    builtAt,
  };
}

function hashDashboardReleaseIdentity(release) {
  const normalized = normalizeReleaseIdentity(release);
  if (!normalized) throw new Error('dashboard release identity is invalid');
  return crypto.createHash('sha256').update(canonicalSerialize(normalized), 'utf8').digest('hex');
}

function dashboardPingUrl(env = process.env) {
  const port = env.FINANCE_DASHBOARD_PORT || '5007';
  return `http://127.0.0.1:${port}/api/v1/ping`;
}

function dashboardReleaseManifestPath(env, dashboardDir) {
  return env.RELEASE_MANIFEST_PATH || path.join(dashboardDir, 'release-manifest.json');
}

function dashboardWriterRunning(snapshotsById) {
  const snapshot = snapshotsById?.get?.('finance-dashboard');
  if (!snapshot) return false;
  const state = String(snapshot.state || '').trim().toLowerCase();
  return snapshot.originallyActive === true && ['active', 'activating', 'running'].includes(state);
}

async function fetchDashboardPingRelease(context) {
  const {
    runners = createDefaultRunners(context.env),
    env = process.env,
    timeoutMs = DEFAULT_HEALTH_TIMEOUT_MS,
    pollMs = DEFAULT_HEALTH_POLL_MS,
  } = context;
  assertFinanceApiTokenForLivePing(env);
  const token = env.FINANCE_API_TOKEN;
  const url = dashboardPingUrl(env);
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const headers = token ? { 'X-Finance-Token': token } : {};
      const response = await runners.httpGet(url, headers, Math.min(5000, timeoutMs));
      const body = await response.json();
      const payload = unwrapPingPayload(body);
      if (response.status === 200 && payload?.ok === true) {
        return payload.release ?? null;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error.message;
    }
    await runners.sleep(pollMs);
  }
  throw new Error(lastError || 'dashboard ping timeout while reading release identity');
}

function readDashboardReleaseIdentityFromManifest(env, dashboardDir) {
  const manifestPath = dashboardReleaseManifestPath(env, dashboardDir);
  let readReleaseIdentity;
  try {
    ({ readReleaseIdentity } = require('../../finance-dashboard/lib/release-identity'));
  } catch (error) {
    throw new Error(`dashboard release identity tooling unavailable: ${error.message}`);
  }
  return normalizeReleaseIdentity(readReleaseIdentity(manifestPath, dashboardDir));
}

async function captureDashboardReleaseIdentity({
  env = process.env,
  runners = createDefaultRunners(env),
  dashboardDir,
  preQuiesced = false,
  snapshotsById = null,
  timeoutMs = DEFAULT_HEALTH_TIMEOUT_MS,
  pollMs = DEFAULT_HEALTH_POLL_MS,
}) {
  if (!dashboardDir) throw new Error('dashboard directory is required to capture release identity');
  let identity = null;
  const usePing = !preQuiesced && dashboardWriterRunning(snapshotsById);
  if (usePing) {
    assertFinanceApiTokenForLivePing(env);
    identity = normalizeReleaseIdentity(await fetchDashboardPingRelease({
      env,
      runners,
      timeoutMs,
      pollMs,
    }));
  } else {
    identity = normalizeReleaseIdentity(readDashboardReleaseIdentityFromManifest(env, dashboardDir));
  }
  if (!identity) {
    throw new Error('dashboard release identity unavailable before quiescence');
  }
  return hashDashboardReleaseIdentity(identity);
}

async function checkDashboardHealth(context) {
  const {
    runners = createDefaultRunners(context.env),
    env = process.env,
    timeoutMs = DEFAULT_HEALTH_TIMEOUT_MS,
    pollMs = DEFAULT_HEALTH_POLL_MS,
    expectedGeneration = null,
  } = context;
  if (!expectedGeneration) {
    return {
      ok: false,
      component: 'finance-dashboard',
      error: 'expected dashboard release identity digest is required for post-restart health',
    };
  }
  const url = dashboardPingUrl(env);
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const token = env.FINANCE_API_TOKEN;
      const headers = token ? { 'X-Finance-Token': token } : {};
      const response = await runners.httpGet(url, headers, Math.min(5000, timeoutMs));
      const body = await response.json();
      const payload = unwrapPingPayload(body);
      if (response.status === 200 && payload?.ok === true) {
        if (payload.release == null) {
          return {
            ok: false,
            component: 'finance-dashboard',
            error: 'dashboard release identity missing from ping',
          };
        }
        let currentDigest;
        try {
          currentDigest = hashDashboardReleaseIdentity(payload.release);
        } catch {
          return {
            ok: false,
            component: 'finance-dashboard',
            error: 'dashboard release identity missing from ping',
          };
        }
        if (currentDigest !== expectedGeneration) {
          return {
            ok: false,
            component: 'finance-dashboard',
            error: 'dashboard release identity mismatch',
            diagnostics: redactDiagnostics({ status: response.status, release: currentDigest }),
          };
        }
        return {
          ok: true,
          component: 'finance-dashboard',
          diagnostics: redactDiagnostics({
            status: response.status,
            actualReady: payload.actual?.ready ?? null,
          }),
        };
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error.message;
    }
    await runners.sleep(pollMs);
  }
  return {
    ok: false,
    component: 'finance-dashboard',
    error: lastError || 'dashboard health timeout',
    diagnostics: redactDiagnostics({ url }),
  };
}

async function checkActualContainerHealth(context) {
  const {
    runners = createDefaultRunners(context.env),
    env = process.env,
    expectedGeneration = null,
  } = context;
  if (env.BACKUP_INCLUDE_ACTUAL_DATA !== '1') {
    return { ok: true, component: 'actual-container', skipped: true };
  }
  if (!runners.commandExists('docker')) {
    return { ok: false, component: 'actual-container', error: 'docker unavailable' };
  }
  const inspect = runners.dockerInspect('actual');
  const state = (inspect.stdout || '').trim();
  if (inspect.status !== 0 || state !== 'running') {
    return {
      ok: false,
      component: 'actual-container',
      error: `container state=${state || 'unknown'}`,
    };
  }
  if (expectedGeneration) {
    const actualDataDir = env.ACTUAL_DATA_DIR || `${env.HOME || ''}/actual/data`;
    const { computeActualDataGeneration } = require('./writer-quiescence');
    const current = computeActualDataGeneration(actualDataDir);
    if (current !== expectedGeneration) {
      return {
        ok: false,
        component: 'actual-container',
        error: 'actual data generation mismatch after restart',
      };
    }
  }
  return { ok: true, component: 'actual-container', diagnostics: { state } };
}

async function checkSystemdUnitHealth(writer, context) {
  const { runners = createDefaultRunners(context.env) } = context;
  if (!writer.originallyActive && !writer.originallyEnabled) {
    return { ok: true, component: writer.id, skipped: true };
  }
  if (!writer.originallyActive && writer.type === 'systemd-service') {
    return { ok: true, component: writer.id, skipped: true };
  }
  if (!runners.commandExists('systemctl')) {
    return { ok: false, component: writer.id, error: 'systemctl unavailable' };
  }
  const active = runners.systemctlIsActive(writer.scope, writer.unit);
  const expected = writer.type === 'systemd-timer'
    ? ['active', 'waiting']
    : ['inactive', 'dead', 'failed'];
  const normalized = String(active.state || '').trim().toLowerCase();
  if (writer.originallyEnabled && writer.type === 'systemd-timer') {
    if (!['active', 'waiting'].includes(normalized)) {
      return { ok: false, component: writer.id, error: `timer state=${normalized}` };
    }
    return { ok: true, component: writer.id, diagnostics: { state: normalized } };
  }
  if (writer.originallyActive && !['active', 'activating'].includes(normalized)) {
    return { ok: false, component: writer.id, error: `service state=${normalized}` };
  }
  if (!writer.originallyActive && !expected.includes(normalized) && normalized !== 'inactive') {
    return { ok: false, component: writer.id, error: `unexpected state=${normalized}` };
  }
  return { ok: true, component: writer.id, diagnostics: { state: normalized } };
}

async function runPostRestartHealthChecks({
  writers,
  snapshotsById,
  env = process.env,
  runners = createDefaultRunners(env),
  expectedActualGeneration = null,
  expectedReleaseGeneration = null,
  timeoutMs = DEFAULT_HEALTH_TIMEOUT_MS,
  pollMs = DEFAULT_HEALTH_POLL_MS,
}) {
  const results = [];
  const context = {
    env,
    runners,
    timeoutMs,
    pollMs,
    expectedGeneration: expectedReleaseGeneration,
  };

  const actual = await checkActualContainerHealth({
    ...context,
    expectedGeneration: expectedActualGeneration,
  });
  results.push(actual);

  const dashboard = await checkDashboardHealth(context);
  results.push(dashboard);

  for (const writer of writers) {
    const snapshot = snapshotsById.get(writer.id);
    if (!snapshot) continue;
    if (writer.type !== 'systemd-timer' && writer.type !== 'systemd-service') continue;
    if (!snapshot.originallyEnabled && !snapshot.originallyActive) continue;
    const result = await checkSystemdUnitHealth({ ...writer, originallyEnabled: snapshot.originallyEnabled, originallyActive: snapshot.originallyActive }, context);
    results.push(result);
  }

  const aggregateOk = results.every((entry) => entry.ok || entry.skipped);
  return {
    ok: aggregateOk,
    results: results.map(redactDiagnostics),
  };
}

module.exports = {
  DEFAULT_HEALTH_TIMEOUT_MS,
  DEFAULT_HEALTH_POLL_MS,
  unwrapPingPayload,
  normalizeReleaseIdentity,
  hashDashboardReleaseIdentity,
  captureDashboardReleaseIdentity,
  assertFinanceApiTokenForLivePing,
  checkDashboardHealth,
  checkActualContainerHealth,
  checkSystemdUnitHealth,
  runPostRestartHealthChecks,
  redactDiagnostics,
};
