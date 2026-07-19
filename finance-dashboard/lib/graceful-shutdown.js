'use strict';

const {
  closeHttpServerWithTimeout,
  forceCloseHttpConnections,
  getRedactedHttpDiagnostics,
} = require('./http-server-drain');
const { abortInFlightHttpReads } = require('./process-shutdown-abort');

const DEFAULT_TOTAL_TIMEOUT_MS = 15_000;
const DEFAULT_MUTATION_DRAIN_TIMEOUT_MS = 10_000;

function resolveTimeoutMs(envValue, fallback) {
  const parsed = parseInt(envValue, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function createBudget(totalMs) {
  const deadline = Date.now() + totalMs;
  return {
    remaining() {
      return Math.max(0, deadline - Date.now());
    },
    expired() {
      return Date.now() >= deadline;
    },
  };
}

function defaultLogPhase(phase, extra) {
  const suffix = extra ? ` ${JSON.stringify(extra)}` : '';
  console.error(`[graceful-shutdown] phase=${phase}${suffix}`);
}

/**
 * Graceful shutdown ordering (PR-14 / PR-30 / query-scaling):
 * 0. abortInFlightHttpReads() — abort accepted ledger reads at the next bounded fetch boundary.
 * 1. Stop periodic sync timer (no new background sync).
 * 2. requestAdmission.closeAdmission() — reject new HTTP admission waiters/slots.
 * 3. mutationQueue.close() — reject new serial mutation enqueue on keep-alive connections.
 * 4. httpServer.close() + await callback — drain active HTTP handlers (GET + in-flight mutations).
 *    closeIdleConnections() runs when admission stops so idle keep-alive sockets do not block drain.
 * 5. mutationQueue.drain() — finish accepted non-HTTP queue work (e.g. in-flight periodic sync).
 * 6. shutdownApi() — coordinator shutdownHandoff (Actual saga sync + api.shutdown).
 *
 * On timeout or HTTP drain failure: emit redacted diagnostics, force-close remaining sockets,
 * exit nonzero, and do not call shutdownApi().
 */
async function runGracefulShutdown({
  signal = 'UNKNOWN',
  httpServer,
  mutationQueue,
  requestAdmission,
  shutdownApi,
  stopPeriodicSync = () => {},
  totalTimeoutMs = resolveTimeoutMs(process.env.FINANCE_SHUTDOWN_TIMEOUT_MS, DEFAULT_TOTAL_TIMEOUT_MS),
  mutationDrainTimeoutMs = resolveTimeoutMs(
    process.env.FINANCE_MUTATION_DRAIN_TIMEOUT_MS,
    DEFAULT_MUTATION_DRAIN_TIMEOUT_MS,
  ),
  exit = (code) => process.exit(code),
  log = defaultLogPhase,
} = {}) {
  const budget = createBudget(totalTimeoutMs);
  log('signal-received', { signal });

  abortInFlightHttpReads();
  log('in-flight-reads-aborted');

  stopPeriodicSync();
  log('periodic-sync-stopped');

  if (requestAdmission) {
    requestAdmission.closeAdmission();
    log('request-admission-stopped');
  }

  mutationQueue.close();
  log('mutation-admission-stopped');

  try {
    await closeHttpServerWithTimeout(httpServer, budget.remaining(), {
      onDiagnostic: (diag) => log('shutdown-timeout', diag),
    });
    log('http-admission-stopped');
    log('http-drained', getRedactedHttpDiagnostics(httpServer));
  } catch (error) {
    log('shutdown-timeout', {
      step: 'http-drain',
      reason: error?.reason,
      message: String(error?.message || error),
      ...getRedactedHttpDiagnostics(httpServer),
    });
    forceCloseHttpConnections(httpServer);
    exit(1);
    return { ok: false, forced: true, phase: 'http-drain-timeout' };
  }

  if (budget.expired()) {
    log('shutdown-timeout', { step: 'budget-exhausted-after-http' });
    forceCloseHttpConnections(httpServer);
    exit(1);
    return { ok: false, forced: true, phase: 'budget-exhausted' };
  }

  try {
    await mutationQueue.drain(Math.min(budget.remaining(), mutationDrainTimeoutMs));
    log('mutation-queue-drained');
  } catch (error) {
    log('shutdown-failed', { step: 'mutation-drain', message: String(error?.message || error) });
    forceCloseHttpConnections(httpServer);
    exit(1);
    return { ok: false, phase: 'mutation-drain-failed' };
  }

  if (budget.expired()) {
    log('shutdown-timeout', { step: 'budget-exhausted-before-actual' });
    forceCloseHttpConnections(httpServer);
    exit(1);
    return { ok: false, forced: true, phase: 'budget-exhausted' };
  }

  try {
    await shutdownApi();
    log('actual-shutdown-complete');
    exit(0);
    return { ok: true };
  } catch (error) {
    log('shutdown-failed', { step: 'actual-shutdown', message: String(error?.message || error) });
    exit(1);
    return { ok: false, phase: 'actual-shutdown-failed' };
  }
}

function bindGracefulShutdownSignals(handlers) {
  let shutdownPromise = null;
  let hardCapTimer = null;

  const startShutdown = (signal) => {
    if (shutdownPromise) return shutdownPromise;

    const totalTimeoutMs = resolveTimeoutMs(
      process.env.FINANCE_SHUTDOWN_TIMEOUT_MS,
      DEFAULT_TOTAL_TIMEOUT_MS,
    );
    const log = handlers.log || defaultLogPhase;
    const exit = handlers.exit || ((code) => process.exit(code));

    shutdownPromise = runGracefulShutdown({ signal, ...handlers, log, exit }).finally(() => {
      if (hardCapTimer) clearTimeout(hardCapTimer);
    });

    hardCapTimer = setTimeout(() => {
      log('shutdown-timeout', { step: 'hard-cap', ...getRedactedHttpDiagnostics(handlers.httpServer) });
      forceCloseHttpConnections(handlers.httpServer);
      exit(1);
    }, totalTimeoutMs);

    return shutdownPromise;
  };

  process.on('SIGTERM', () => { void startShutdown('SIGTERM'); });
  process.on('SIGINT', () => { void startShutdown('SIGINT'); });

  return { startShutdown, getShutdownPromise: () => shutdownPromise };
}

module.exports = {
  DEFAULT_MUTATION_DRAIN_TIMEOUT_MS,
  DEFAULT_TOTAL_TIMEOUT_MS,
  bindGracefulShutdownSignals,
  runGracefulShutdown,
};
