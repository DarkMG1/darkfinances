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
  assert.match(source, /MAESTRO_ARTIFACT_DIR=/);
  assert.match(source, /--test-output-dir=/);
  assert.match(source, /--debug-output=/);
  assert.match(source, /--flatten-debug-output/);
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

test('run-maestro-ios creates screenshot and failure-diagnostic directories under build/', () => {
  const source = fs.readFileSync(path.join(root, 'scripts/run-maestro-ios.sh'), 'utf8');
  assert.match(source, /mkdir -p "\$APP_ROOT\/build\/maestro\/screenshots"/);
  assert.match(source, /\$APP_ROOT\/build\/maestro\/results/);
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

test('all Maestro flows wait for onboarding through cold Metro startup', () => {
  const maestroDir = path.join(root, '.maestro');
  const flows = fs.readdirSync(maestroDir).filter((name) => name.endsWith('.yaml'));
  const startupWait = /- launchApp:\n    clearState: true\n    clearKeychain: true\n- extendedWaitUntil:\n    visible:\n      id: onboarding-screen\n    timeout: 60000/;
  const immediateAssertion = /- launchApp:\n    clearState: true\n    clearKeychain: true\n- assertVisible:\n    id: onboarding-screen/;

  for (const name of flows) {
    const source = fs.readFileSync(path.join(maestroDir, name), 'utf8');
    assert.match(source, startupWait, `${name} must tolerate a cold Metro bundle before onboarding`);
    assert.doesNotMatch(source, immediateAssertion, `${name} must not race Metro with an immediate assertion`);
  }
});

test('Maestro deep-link prompt guards tolerate iOS quote typography and require Open taps', () => {
  const maestroDir = path.join(root, '.maestro');
  const flows = fs.readdirSync(maestroDir).filter((name) => name.endsWith('.yaml'));
  const promptSelector = 'Open in ["“]Finances["”].*';
  const tolerantGuard = `visible: '${promptSelector}'`;
  const literalGuard = `visible: 'Open in "Finances"'`;
  const requiredHandler = /- runFlow:\n    when:\n      visible: 'Open in \["“\]Finances\["”\]\.\*'\n    commands:\n      - tapOn:\n          text: Open(?!\n          optional: true)/g;
  let deepLinkCount = 0;

  assert.match('Open in "Finances"?', new RegExp(`^${promptSelector}$`));
  assert.match('Open in “Finances”?', new RegExp(`^${promptSelector}$`));

  for (const name of flows) {
    const source = fs.readFileSync(path.join(maestroDir, name), 'utf8');
    const openLinks = [...source.matchAll(/^- openLink:/gm)].length;
    const tolerantGuards = source.split(tolerantGuard).length - 1;
    const requiredHandlers = [...source.matchAll(requiredHandler)].length;

    assert.ok(!source.includes(literalGuard), `${name} must not use the fragile literal prompt guard`);
    assert.equal(tolerantGuards, openLinks, `${name} must guard every deep link with the typography-tolerant prompt selector`);
    assert.equal(requiredHandlers, openLinks, `${name} must retain a required Open tap for every prompt guard`);
    deepLinkCount += openLinks;
  }

  assert.ok(deepLinkCount > 0, 'expected Maestro deep-link coverage');
});
