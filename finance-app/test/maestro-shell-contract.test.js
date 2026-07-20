const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const scripts = [
  'scripts/ios-sim-biometrics.sh',
  'scripts/run-maestro-ios.sh',
  'scripts/privacy-animation-check.sh',
];

for (const script of scripts) {
  test(`${script} passes bash syntax check`, () => {
    execFileSync('bash', ['-n', path.join(root, script)], { stdio: 'pipe' });
  });
}

test('run-maestro-ios resolves MAESTRO_APP_ID and ties matcher lifetime to maestro pid', () => {
  const source = fs.readFileSync(path.join(root, 'scripts/run-maestro-ios.sh'), 'utf8');
  assert.match(source, /resolve-maestro-app-id\.js/);
  assert.match(source, /MAESTRO_APP_ID=/);
  assert.match(source, /start-match-loop/);
  assert.match(source, /trap cleanup_matcher EXIT INT TERM/);
  assert.match(source, /DEVICE="\$\{DEVICE:-booted\}"/);
  assert.doesNotMatch(source, /seq 1 360|120\)/);
});

test('ios-sim-biometrics posts match notifications until parent pid exits', () => {
  const source = fs.readFileSync(path.join(root, 'scripts/ios-sim-biometrics.sh'), 'utf8');
  assert.match(source, /BiometricKit_Sim\.fingerTouch\.match/);
  assert.match(source, /kill -0 "\$parent_pid"/);
  assert.match(source, /stop_match_loop/);
});

test('Maestro flows stay at .maestro root so directory runs do not pick up helper YAML', () => {
  const maestroDir = path.join(root, '.maestro');
  const rootFlows = fs.readdirSync(maestroDir).filter((name) => name.endsWith('.yaml'));
  assert.ok(rootFlows.length >= 20, 'expected top-level Maestro flows');
  for (const entry of fs.readdirSync(maestroDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const nested = fs.readdirSync(path.join(maestroDir, entry.name)).filter((name) => name.endsWith('.yaml'));
      assert.equal(nested.length, 0, `.maestro/${entry.name} must not contain discoverable flow YAML`);
    }
  }
});

test('mutation validation banner flow filename matches client-validation intent', () => {
  assert.ok(fs.existsSync(path.join(root, '.maestro/mutation-validation-banner-dismiss.yaml')));
  assert.ok(fs.existsSync(path.join(root, '.maestro/mutation-validation-draft-preservation.yaml')));
  assert.ok(!fs.existsSync(path.join(root, '.maestro/mutation-retry-dismiss.yaml')));
  assert.ok(!fs.existsSync(path.join(root, '.maestro/mutation-offline-retry.yaml')));
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  assert.match(readme, /mutation-validation-banner-dismiss\.yaml/);
  assert.match(readme, /mutation-validation-draft-preservation\.yaml/);
});

test('run-maestro-ios creates screenshot output directory under build/', () => {
  const source = fs.readFileSync(path.join(root, 'scripts/run-maestro-ios.sh'), 'utf8');
  assert.match(source, /mkdir -p "\$APP_ROOT\/build\/maestro\/screenshots"/);
});

test('Maestro flows write screenshots under build/maestro/screenshots only', () => {
  const maestroDir = path.join(root, '.maestro');
  for (const name of fs.readdirSync(maestroDir).filter((entry) => entry.endsWith('.yaml'))) {
    const source = fs.readFileSync(path.join(maestroDir, name), 'utf8');
    const shots = [...source.matchAll(/takeScreenshot:\s*(.+)$/gm)].map((m) => m[1].trim());
    for (const shot of shots) {
      assert.match(shot, /^build\/maestro\/screenshots\//, `${name} screenshot ${shot} must live under build/maestro/screenshots/`);
    }
  }
});

test('all Maestro flows use strict demo bootstrap before deep links', () => {
  const maestroDir = path.join(root, '.maestro');
  const flows = fs.readdirSync(maestroDir).filter((name) => name.endsWith('.yaml'));
  assert.equal(flows.length, 21);
  for (const name of flows) {
    const source = fs.readFileSync(path.join(maestroDir, name), 'utf8');
    assert.match(source, /id: onboarding-screen/, `${name} must assert onboarding-screen`);
    assert.match(source, /id: onboarding-demo-button/, `${name} must tap onboarding-demo-button`);
    assert.match(source, /id: home-screen/, `${name} must assert home-screen before deep links`);
    assert.doesNotMatch(source, /id: onboarding-demo-button\s*\n\s*optional: true/, `${name} must require demo bootstrap`);
  }
});
