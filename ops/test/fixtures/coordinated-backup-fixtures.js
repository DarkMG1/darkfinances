'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const RELEASE_MANIFEST_BODY = `${JSON.stringify({ contentDigest: { value: 'c'.repeat(64) } }, null, 2)}\n`;
const RELEASE_MANIFEST_DIGEST = crypto.createHash('sha256').update(RELEASE_MANIFEST_BODY).digest('hex');

function createMockRunners(initial = {}) {
  const units = new Map(Object.entries(initial.units || {}));
  const containers = new Map(Object.entries(initial.containers || {}));
  const restartPolicies = new Map(Object.entries(initial.restartPolicies || {}));
  const commands = [];
  let pingResponse = initial.pingResponse || {
    status: 200,
    body: {
      ok: true,
      release: { contentDigest: { value: RELEASE_MANIFEST_DIGEST } },
    },
  };
  let hungDrain = initial.hungDrain === true;
  let stopFailures = new Set(initial.stopFailures || []);
  let restartFailures = new Set(initial.restartFailures || []);
  let timerFiresDuringStop = initial.timerFiresDuringStop === true;
  let reappearingWriters = new Set(initial.reappearingWriters || []);
  let tarShouldHang = initial.tarShouldHang === true;

  const api = {
    commands,
    units,
    containers,
    restartPolicies,
    setPingResponse(value) { pingResponse = value; },
    setHungDrain(value) { hungDrain = value; },
    commandExists() { return true; },
    listActiveSystemdUnits() {
      return [...units.entries()]
        .filter(([, entry]) => ['active', 'activating'].includes(entry.active))
        .map(([unit]) => unit);
    },
    systemctl(args) {
      commands.push(['systemctl', ...args]);
      const action = args[args.length - 2];
      const unit = args[args.length - 1];
      if (action === 'stop') {
        if (stopFailures.has(unit)) return { status: 1, stderr: 'stop failed' };
        const entry = units.get(unit) || { active: 'inactive', enabled: 'disabled' };
        if (unit.endsWith('.timer') && timerFiresDuringStop) {
          units.set(`${unit.replace('.timer', '')}.service`, { active: 'activating', enabled: 'enabled' });
        }
        entry.active = unit.endsWith('.timer') ? 'inactive' : 'deactivating';
        if (hungDrain && unit === 'finance-dashboard.service') entry.active = 'deactivating';
        else if (!hungDrain || unit !== 'finance-dashboard.service') entry.active = 'inactive';
        units.set(unit, entry);
        return { status: 0, stdout: '' };
      }
      if (action === 'start') {
        if (restartFailures.has(unit)) return { status: 1, stderr: 'start failed' };
        const entry = units.get(unit) || { active: 'inactive', enabled: 'disabled' };
        entry.active = unit.endsWith('.timer') ? 'active' : 'active';
        units.set(unit, entry);
        return { status: 0, stdout: '' };
      }
      return { status: 0, stdout: '' };
    },
    systemctlIsActive(_scope, unit) {
      if (reappearingWriters.has(unit)) {
        return { status: 0, state: 'active' };
      }
      const entry = units.get(unit);
      if (!entry) return { status: 3, state: 'inactive' };
      if (entry.active === 'unknown') return { status: 3, state: 'unknown' };
      return { status: entry.active === 'active' || entry.active === 'activating' ? 0 : 3, state: entry.active };
    },
    systemctlIsEnabled(_scope, unit) {
      const entry = units.get(unit);
      if (!entry) return { status: 1, state: 'disabled' };
      return { status: 0, state: entry.enabled || 'disabled' };
    },
    systemctlStop(_scope, unit) { return api.systemctl(['--user', 'stop', unit]); },
    systemctlStart(_scope, unit) { return api.systemctl(['--user', 'start', unit]); },
    docker(args) {
      commands.push(['docker', ...args]);
      if (args[0] === 'inspect') {
        const name = args[args.length - 1];
        if (args.includes('RestartPolicy.Name')) {
          return { status: 0, stdout: `${restartPolicies.get(name) || 'unless-stopped'}\n` };
        }
        const state = containers.get(name) || 'stopped';
        return { status: state === 'not-present' ? 1 : 0, stdout: `${state}\n` };
      }
      if (args[0] === 'update') return { status: 0, stdout: '' };
      return { status: 0, stdout: '' };
    },
    dockerInspect(containerName) { return api.docker(['inspect', '--format', '{{.State.Status}}', containerName]); },
    dockerInspectRestartPolicy(containerName) {
      const result = api.docker(['inspect', '--format', '{{.HostConfig.RestartPolicy.Name}}', containerName]);
      if (result.status !== 0) return null;
      return (result.stdout || '').trim() || 'no';
    },
    dockerUpdateRestartPolicy(containerName, policy) {
      commands.push(['docker', 'update', `--restart=${policy}`, containerName]);
      restartPolicies.set(containerName, policy);
      return { status: 0, stdout: '' };
    },
    dockerComposeStop(_composeFile, serviceName) {
      commands.push(['docker', 'compose', 'stop', serviceName]);
      if (stopFailures.has(serviceName)) return { status: 1, stderr: 'compose stop failed' };
      containers.set(serviceName, 'stopped');
      return { status: 0, stdout: '' };
    },
    dockerComposeStart(_composeFile, serviceName) {
      commands.push(['docker', 'compose', 'start', serviceName]);
      if (restartFailures.has(serviceName)) return { status: 1, stderr: 'compose start failed' };
      containers.set(serviceName, 'running');
      return { status: 0, stdout: '' };
    },
    tar(args) {
      commands.push(['tar', ...args]);
      if (tarShouldHang) return { status: 124, stderr: 'tar timed out' };
      const outIndex = args.indexOf('-czf');
      if (outIndex >= 0 && args[outIndex + 1]) {
        fs.writeFileSync(args[outIndex + 1], 'tar-output\n');
      }
      return { status: 0, stdout: '' };
    },
    nodeScript() { return { status: 0, stdout: '', stderr: '' }; },
    async httpGet() {
      commands.push(['httpGet']);
      if (pingResponse.error) throw new Error(pingResponse.error);
      return {
        status: pingResponse.status || 200,
        async json() { return pingResponse.body || { ok: true }; },
      };
    },
    sleep(ms) {
      commands.push(['sleep', String(ms)]);
      return Promise.resolve();
    },
  };
  return api;
}

function writeMinimalDashboard(root) {
  fs.mkdirSync(path.join(root, 'receipts'), { recursive: true });
  const stores = [
    'goals.json', 'rules.json', 'review-state.json', 'receipts.json',
    'operation-journal.json', 'transaction-sagas.json', 'transaction-deletion-sagas.json',
    'bulk-operation-sagas.json', 'repayment-confirmation-sagas.json',
    'splitwise-mirror-resolutions.json', 'passkey-credentials.json',
  ];
  for (const file of stores) {
    const payload = file.includes('passkey')
      ? '{"schemaVersion":1,"credentials":[]}\n'
      : file.includes('receipts.json')
        ? '{"schemaVersion":1,"receipts":{}}\n'
        : file.includes('sagas') || file.includes('journal')
          ? '{"schemaVersion":1,"sagas":{},"operations":{}}\n'.replace('"sagas":{},"operations":{}', file.includes('journal') ? '"operations":{}' : '"sagas":{}')
          : file.includes('review-state')
            ? '{"reviews":{}}\n'
            : '[]\n';
    fs.writeFileSync(path.join(root, file), payload, { mode: 0o600 });
  }
}

function defaultActiveUnits() {
  return {
    'actual-sync.timer': { active: 'active', enabled: 'enabled' },
    'actual-sync.service': { active: 'inactive', enabled: 'enabled' },
    'finance-dashboard.service': { active: 'active', enabled: 'enabled' },
  };
}

module.exports = {
  RELEASE_MANIFEST_BODY,
  RELEASE_MANIFEST_DIGEST,
  createMockRunners,
  writeMinimalDashboard,
  defaultActiveUnits,
};
