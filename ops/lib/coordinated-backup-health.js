'use strict';

const { createDefaultRunners } = require('./ops-command-runners');

const DEFAULT_HEALTH_TIMEOUT_MS = 30_000;
const DEFAULT_HEALTH_POLL_MS = 500;

function redactDiagnostics(entry) {
  const clone = { ...entry };
  if (clone.url) clone.url = String(clone.url).replace(/token=[^&]+/gi, 'token=[redacted]');
  return clone;
}

async function checkDashboardHealth(context) {
  const {
    runners = createDefaultRunners(context.env),
    env = process.env,
    timeoutMs = DEFAULT_HEALTH_TIMEOUT_MS,
    pollMs = DEFAULT_HEALTH_POLL_MS,
    expectedGeneration = null,
  } = context;
  const port = env.FINANCE_DASHBOARD_PORT || '5007';
  const token = env.FINANCE_API_TOKEN;
  const url = `http://127.0.0.1:${port}/api/v1/ping`;
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const headers = token ? { 'X-Finance-Token': token } : {};
      const response = await runners.httpGet(url, headers, Math.min(5000, timeoutMs));
      const body = await response.json();
      if (response.status === 200 && body?.ok === true) {
        if (expectedGeneration && body.release?.contentDigest?.value
          && body.release.contentDigest.value !== expectedGeneration) {
          return {
            ok: false,
            component: 'finance-dashboard',
            error: 'dashboard release generation mismatch',
            diagnostics: redactDiagnostics({ status: response.status, release: body.release?.contentDigest?.value }),
          };
        }
        return {
          ok: true,
          component: 'finance-dashboard',
          diagnostics: redactDiagnostics({ status: response.status, actualReady: body.actualReady ?? null }),
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
}) {
  const results = [];
  const context = {
    env,
    runners,
    timeoutMs,
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
  checkDashboardHealth,
  checkActualContainerHealth,
  checkSystemdUnitHealth,
  runPostRestartHealthChecks,
  redactDiagnostics,
};
