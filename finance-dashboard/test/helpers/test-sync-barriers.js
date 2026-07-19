'use strict';

const fs = require('fs');
const path = require('path');

function markerPathForDir(dir) {
  return path.join(dir, 'marker.log');
}

function effectMarkerPathForDir(dir) {
  return path.join(dir, 'effects.log');
}

function markerContentHasLine(content, line) {
  return content.includes(`${line}\n`) || content.trimEnd().endsWith(line);
}

function throwIfChildFailed(child, logs, context) {
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
  context = `marker ${line}`,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    throwIfChildFailed(child, logs, context);
    if (fs.existsSync(markerPath)) {
      const content = fs.readFileSync(markerPath, 'utf8');
      if (markerContentHasLine(content, line)) return content;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error([
    `marker line not seen within ${timeoutMs}ms: ${line}`,
    fs.existsSync(markerPath) ? fs.readFileSync(markerPath, 'utf8') : '(marker file missing)',
    child ? `exitCode=${child.exitCode}` : null,
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

function sidecarReleasePrelude() {
  return `
    const waitSidecarRelease = async () => {
      while (!fs.existsSync(process.env.TEST_RELEASE_PATH)) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    };
  `;
}

module.exports = {
  effectMarkerPathForDir,
  markPrelude,
  markerContentHasLine,
  markerPathForDir,
  sidecarReleasePrelude,
  throwIfChildFailed,
  waitForMarkerDir,
  waitForMarkerFile,
};
