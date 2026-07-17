'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SAFE_UNIT_PATTERN = /^[A-Za-z0-9@._-]+$/;
const SAFE_CONTAINER_PATTERN = /^[A-Za-z0-9_.-]+$/;
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const MAX_CAPTURE_BYTES = 64 * 1024;

function assertSafeUnit(unit) {
  if (typeof unit !== 'string' || !SAFE_UNIT_PATTERN.test(unit)) {
    throw new Error(`unsafe systemd unit name: ${unit}`);
  }
}

function assertSafeContainer(name) {
  if (typeof name !== 'string' || !SAFE_CONTAINER_PATTERN.test(name)) {
    throw new Error(`unsafe container name: ${name}`);
  }
}

function assertSafeComposeFile(filePath) {
  const resolved = path.resolve(filePath);
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink()) throw new Error(`compose file must not be a symbolic link: ${resolved}`);
  if (!stat.isFile()) throw new Error(`compose file must be a regular file: ${resolved}`);
  return resolved;
}

function boundedOutput(text) {
  const value = String(text || '');
  if (value.length <= MAX_CAPTURE_BYTES) return value;
  return `${value.slice(0, MAX_CAPTURE_BYTES)}…[truncated]`;
}

function spawnBounded(command, args, options = {}) {
  const timeoutMs = options.timeoutMs || DEFAULT_COMMAND_TIMEOUT_MS;
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: options.env,
    cwd: options.cwd,
    timeout: timeoutMs,
    maxBuffer: MAX_CAPTURE_BYTES,
    killSignal: 'SIGTERM',
  });
  if (result.error && result.error.code === 'ETIMEDOUT') {
    return { status: 124, stdout: '', stderr: `${command} timed out after ${timeoutMs}ms` };
  }
  return {
    status: result.status ?? 1,
    stdout: boundedOutput(result.stdout),
    stderr: boundedOutput(result.stderr),
  };
}

function createDefaultRunners(env = process.env, options = {}) {
  const systemctlScopeFlag = (scope) => (scope === 'system' ? '--system' : '--user');
  const timeoutMs = options.commandTimeoutMs || Number(env.COORDINATED_COMMAND_TIMEOUT_MS) || DEFAULT_COMMAND_TIMEOUT_MS;

  return {
    commandTimeoutMs: timeoutMs,
    commandExists(name) {
      const result = spawnBounded('command', ['-v', name], { env, timeoutMs: 5000 });
      return result.status === 0;
    },

    systemctl(args, runOptions = {}) {
      return spawnBounded('systemctl', args, { env: runOptions.env || env, timeoutMs });
    },

    systemctlShow(scope, unit, properties) {
      assertSafeUnit(unit);
      return this.systemctl([
        systemctlScopeFlag(scope),
        'show',
        unit,
        ...properties.flatMap((prop) => ['--property', prop]),
        '--value',
      ]);
    },

    systemctlIsActive(scope, unit) {
      assertSafeUnit(unit);
      const result = this.systemctl([systemctlScopeFlag(scope), 'is-active', unit]);
      const state = (result.stdout || result.stderr || '').trim();
      return { status: result.status, state: state || 'unknown' };
    },

    systemctlIsEnabled(scope, unit) {
      assertSafeUnit(unit);
      const result = this.systemctl([systemctlScopeFlag(scope), 'is-enabled', unit]);
      const state = (result.stdout || result.stderr || '').trim();
      return { status: result.status, state: state || 'unknown' };
    },

    systemctlStop(scope, unit) {
      assertSafeUnit(unit);
      return this.systemctl([systemctlScopeFlag(scope), 'stop', unit]);
    },

    systemctlStart(scope, unit) {
      assertSafeUnit(unit);
      return this.systemctl([systemctlScopeFlag(scope), 'start', unit]);
    },

    listActiveSystemdUnits(scope = 'user') {
      const result = this.systemctl([systemctlScopeFlag(scope), 'list-units', '--type=service,timer', '--state=active', '--no-legend', '--no-pager']);
      if (result.status !== 0) return [];
      return result.stdout.split('\n').map((line) => line.trim().split(/\s+/)[0]).filter(Boolean);
    },

    docker(args, runOptions = {}) {
      return spawnBounded('docker', args, { env: runOptions.env || env, timeoutMs });
    },

    dockerInspect(containerName) {
      assertSafeContainer(containerName);
      return this.docker(['inspect', '--format', '{{.State.Status}}', containerName]);
    },

    dockerInspectRestartPolicy(containerName) {
      assertSafeContainer(containerName);
      const result = this.docker(['inspect', '--format', '{{.HostConfig.RestartPolicy.Name}}', containerName]);
      if (result.status !== 0) return null;
      return (result.stdout || '').trim() || 'no';
    },

    dockerUpdateRestartPolicy(containerName, policy) {
      assertSafeContainer(containerName);
      const safePolicy = String(policy || 'no');
      if (!/^[A-Za-z0-9-]+$/.test(safePolicy)) throw new Error('unsafe docker restart policy');
      return this.docker(['update', `--restart=${safePolicy}`, containerName]);
    },

    dockerComposeStop(composeFile, serviceName) {
      const resolved = assertSafeComposeFile(composeFile);
      assertSafeContainer(serviceName);
      return spawnBounded('docker', ['compose', '-f', resolved, 'stop', serviceName], { env, timeoutMs });
    },

    dockerComposeStart(composeFile, serviceName) {
      const resolved = assertSafeComposeFile(composeFile);
      assertSafeContainer(serviceName);
      return spawnBounded('docker', ['compose', '-f', resolved, 'start', serviceName], { env, timeoutMs });
    },

    nodeScript(scriptPath, args = [], runOptions = {}) {
      return spawnBounded(process.execPath, [scriptPath, ...args], {
        env: runOptions.env || env,
        cwd: runOptions.cwd,
        timeoutMs: runOptions.timeoutMs || timeoutMs,
      });
    },

    tar(args, runOptions = {}) {
      return spawnBounded('tar', args, { env: runOptions.env || env, timeoutMs: runOptions.timeoutMs || timeoutMs });
    },

    httpGet(url, headers = {}, requestTimeoutMs = 5000) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
      return fetch(url, {
        method: 'GET',
        headers,
        signal: controller.signal,
      }).finally(() => clearTimeout(timer));
    },

    sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    },
  };
}

module.exports = {
  SAFE_UNIT_PATTERN,
  SAFE_CONTAINER_PATTERN,
  DEFAULT_COMMAND_TIMEOUT_MS,
  MAX_CAPTURE_BYTES,
  createDefaultRunners,
  assertSafeUnit,
  assertSafeContainer,
  assertSafeComposeFile,
  spawnBounded,
  boundedOutput,
};
