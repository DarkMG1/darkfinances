'use strict';

const fs = require('fs');
const path = require('path');

const POLL_DELAYS_MS = [2, 3, 4, 5];
let pollGeneration = 0;

async function pollBackoff() {
  const delay = POLL_DELAYS_MS[pollGeneration % POLL_DELAYS_MS.length];
  pollGeneration += 1;
  await new Promise((resolve) => setTimeout(resolve, delay));
}

function markerPathForDir(dir) {
  return path.join(dir, 'marker.log');
}

function completedMarkerLines(content) {
  if (!content) return [];
  if (!content.endsWith('\n')) {
    const lastNewline = content.lastIndexOf('\n');
    if (lastNewline === -1) return [];
    return content.slice(0, lastNewline).split('\n');
  }
  const lines = content.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function markerContentHasLine(content, line) {
  return completedMarkerLines(content).includes(line);
}

function childWatchContext({ child, logs, childState } = {}) {
  return { child, logs, childState };
}

function throwIfChildFailed(child, logs, context, childState = null) {
  const spawnError = childState?.spawnError ?? null;
  if (spawnError) {
    throw new Error([
      `spawn error during ${context}`,
      spawnError.message,
      logs?.value ? `logs=${logs.value}` : null,
    ].filter(Boolean).join('\n'));
  }
  if (child?.signalCode != null) {
    throw new Error([
      `server terminated during ${context}`,
      `signal=${child.signalCode}`,
      `exitCode=${child.exitCode}`,
      logs?.value ? `logs=${logs.value}` : null,
    ].filter(Boolean).join('\n'));
  }
  if (child?.exitCode != null) {
    throw new Error([
      `server exited during ${context}`,
      `code=${child.exitCode}`,
      `signal=${child.signalCode ?? 'none'}`,
      logs?.value ? `logs=${logs.value}` : null,
    ].filter(Boolean).join('\n'));
  }
}

async function waitForMarkerFile(markerPath, line, {
  timeoutMs = 10_000,
  child = null,
  logs = null,
  childState = null,
  context = `marker ${line}`,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    throwIfChildFailed(child, logs, context, childState);
    if (fs.existsSync(markerPath)) {
      const content = fs.readFileSync(markerPath, 'utf8');
      if (markerContentHasLine(content, line)) return content;
    }
    await pollBackoff();
  }
  throw new Error([
    `marker line not seen within ${timeoutMs}ms: ${line}`,
    fs.existsSync(markerPath) ? fs.readFileSync(markerPath, 'utf8') : '(marker file missing)',
    child ? `exitCode=${child.exitCode}` : null,
    child?.signalCode != null ? `signal=${child.signalCode}` : null,
    logs?.value ? `logs=${logs.value}` : null,
  ].filter(Boolean).join('\n'));
}

async function waitForMarkerDir(dir, line, options = {}) {
  return waitForMarkerFile(markerPathForDir(dir), line, options);
}

function markPrelude() {
  return `
    const mark = (value) => fs.appendFileSync(process.env.TEST_MARKER, value + '\\n');
  `;
}

function sidecarReleasePrelude({ timeoutMs = 30_000 } = {}) {
  return `
    const waitSidecarRelease = async () => {
      const releaseDeadline = Date.now() + ${timeoutMs};
      let waitPoll = 0;
      while (!fs.existsSync(process.env.TEST_RELEASE_PATH)) {
        if (Date.now() >= releaseDeadline) {
          throw new Error('TEST_RELEASE_PATH never appeared within ${timeoutMs}ms: ' + String(process.env.TEST_RELEASE_PATH));
        }
        const delay = [2, 3, 4, 5][waitPoll % 4];
        waitPoll += 1;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    };
  `;
}

function gateWaitPrelude({ timeoutMs = 30_000 } = {}) {
  return `
    const gatePath = (name) => path.join(path.dirname(process.env.TEST_MARKER), name + '.gate');
    const waitGate = async (name) => {
      const gateDeadline = Date.now() + ${timeoutMs};
      let waitPoll = 0;
      while (!fs.existsSync(gatePath(name))) {
        if (Date.now() >= gateDeadline) {
          throw new Error('gate never opened within ${timeoutMs}ms: ' + gatePath(name));
        }
        const delay = [2, 3, 4, 5][waitPoll % 4];
        waitPoll += 1;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    };
  `;
}

module.exports = {
  childWatchContext,
  gateWaitPrelude,
  markPrelude,
  pollBackoff,
  sidecarReleasePrelude,
  waitForMarkerDir,
  waitForMarkerFile,
};
