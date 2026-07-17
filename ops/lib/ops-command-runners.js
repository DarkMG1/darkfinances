'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SAFE_UNIT_PATTERN = /^[A-Za-z0-9@._-]+$/;
const SAFE_CONTAINER_PATTERN = /^[A-Za-z0-9_.-]+$/;

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

function createDefaultRunners(env = process.env) {
  const systemctlScopeFlag = (scope) => (scope === 'system' ? '--system' : '--user');

  return {
    commandExists(name) {
      const result = spawnSync('command', ['-v', name], { encoding: 'utf8' });
      return result.status === 0;
    },

    systemctl(args, options = {}) {
      const argv = ['systemctl', ...args];
      return spawnSync(argv[0], argv.slice(1), {
        encoding: 'utf8',
        env: options.env || env,
      });
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

    docker(args, options = {}) {
      const argv = ['docker', ...args];
      return spawnSync(argv[0], argv.slice(1), {
        encoding: 'utf8',
        env: options.env || env,
      });
    },

    dockerInspect(containerName) {
      assertSafeContainer(containerName);
      return this.docker(['inspect', '--format', '{{.State.Status}}', containerName]);
    },

    dockerComposeStop(composeFile, serviceName) {
      const resolved = assertSafeComposeFile(composeFile);
      assertSafeContainer(serviceName);
      return spawnSync('docker', ['compose', '-f', resolved, 'stop', serviceName], {
        encoding: 'utf8',
        env,
      });
    },

    dockerComposeStart(composeFile, serviceName) {
      const resolved = assertSafeComposeFile(composeFile);
      assertSafeContainer(serviceName);
      return spawnSync('docker', ['compose', '-f', resolved, 'start', serviceName], {
        encoding: 'utf8',
        env,
      });
    },

    httpGet(url, headers = {}, timeoutMs = 5000) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
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
  createDefaultRunners,
  assertSafeUnit,
  assertSafeContainer,
  assertSafeComposeFile,
};
