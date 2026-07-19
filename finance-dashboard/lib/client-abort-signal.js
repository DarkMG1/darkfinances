'use strict';

const {
  recordClientAbortListenersAttached,
  recordClientAbortListenersDisposed,
} = require('./query-abort-sentinel');
const { getProcessShutdownAbortSignal } = require('./process-shutdown-abort');

function responseEndedSuccessfully(res) {
  if (!res) return false;
  if (res.writableFinished === true) return true;
  if (res.finished === true && res.headersSent === true) return true;
  return false;
}

function createClientAbortSignal(req, res, { externalSignal = null } = {}) {
  if (externalSignal) {
    return {
      signal: externalSignal,
      ownsListeners: false,
      dispose() {},
    };
  }

  const controller = new AbortController();
  let disposed = false;
  let responseFinished = false;

  const abortIdempotent = () => {
    if (disposed || controller.signal.aborted) return;
    controller.abort();
    try {
      require('./query-abort-sentinel').recordQueryAbort('client disconnect');
    } catch (_) { /* optional test sentinel */ }
  };

  const onReqAborted = () => abortIdempotent();
  const onResFinish = () => { responseFinished = true; };
  const onResClose = () => {
    if (responseFinished || responseEndedSuccessfully(res)) return;
    abortIdempotent();
  };
  const onShutdownAbort = () => {
    if (disposed || controller.signal.aborted) return;
    controller.abort();
    try {
      require('./query-abort-sentinel').recordQueryAbort('graceful shutdown');
    } catch (_) { /* optional test sentinel */ }
  };

  let attached = 0;

  const shutdownSignal = getProcessShutdownAbortSignal();
  if (shutdownSignal.aborted) {
    onShutdownAbort();
  } else if (typeof shutdownSignal.addEventListener === 'function') {
    shutdownSignal.addEventListener('abort', onShutdownAbort, { once: true });
    attached += 1;
  }

  if (req) {
    if (req.aborted === true) {
      abortIdempotent();
    } else if (typeof req.on === 'function') {
      req.on('aborted', onReqAborted);
      attached += 1;
    }
  }

  if (res && typeof res.on === 'function') {
    res.on('finish', onResFinish);
    res.on('close', onResClose);
    attached += 2;
  }

  if (attached > 0) recordClientAbortListenersAttached(attached);

  return {
    signal: controller.signal,
    ownsListeners: true,
    dispose() {
      if (disposed) return;
      disposed = true;
      let removed = 0;
      if (req && typeof req.off === 'function') {
        req.off('aborted', onReqAborted);
        removed += 1;
      }
      if (res && typeof res.off === 'function') {
        res.off('finish', onResFinish);
        res.off('close', onResClose);
        removed += 2;
      }
      if (typeof shutdownSignal.removeEventListener === 'function') {
        shutdownSignal.removeEventListener('abort', onShutdownAbort);
        removed += 1;
      }
      if (removed > 0) recordClientAbortListenersDisposed(removed);
    },
  };
}

module.exports = {
  createClientAbortSignal,
  responseEndedSuccessfully,
};
