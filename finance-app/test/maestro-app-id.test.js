const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { resolveMaestroAppId } = require('../scripts/resolve-maestro-app-id');

const maestroDir = path.resolve(__dirname, '../.maestro');

test('resolveMaestroAppId honors explicit env override', () => {
  assert.equal(resolveMaestroAppId({ MAESTRO_APP_ID: 'custom.app.id' }), 'custom.app.id');
});

test('resolveMaestroAppId uses Expo Go when MAESTRO_EXPO_GO=1', () => {
  assert.equal(resolveMaestroAppId({ MAESTRO_EXPO_GO: '1' }), 'host.exp.Exponent');
});

test('resolveMaestroAppId defaults to Expo bundle identifier', () => {
  assert.equal(resolveMaestroAppId({}), 'dev.darkmg1.finances');
});

test('Maestro flows reference shared MAESTRO_APP_ID env', () => {
  const flows = fs.readdirSync(maestroDir).filter((name) => name.endsWith('.yaml'));
  assert.ok(flows.length > 0);
  for (const file of flows) {
    const firstLine = fs.readFileSync(path.join(maestroDir, file), 'utf8').split('\n')[0];
    assert.equal(firstLine, 'appId: ${MAESTRO_APP_ID}', `${file} must use MAESTRO_APP_ID env`);
  }
});
