'use strict';

let shutdownAbortController = null;
let shutdownAborted = false;

function getProcessShutdownAbortSignal() {
  if (!shutdownAbortController) shutdownAbortController = new AbortController();
  return shutdownAbortController.signal;
}

function isProcessShutdownAborted() {
  return shutdownAborted || getProcessShutdownAbortSignal().aborted;
}

function abortInFlightHttpReads() {
  shutdownAborted = true;
  if (!shutdownAbortController) shutdownAbortController = new AbortController();
  if (!shutdownAbortController.signal.aborted) shutdownAbortController.abort();
}

function resetProcessShutdownAbortForTests() {
  shutdownAbortController = null;
  shutdownAborted = false;
}

module.exports = {
  abortInFlightHttpReads,
  getProcessShutdownAbortSignal,
  isProcessShutdownAborted,
  resetProcessShutdownAbortForTests,
};
