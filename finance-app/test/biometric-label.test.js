const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  AUTHENTICATION_TYPE,
  biometricLabelForTypes,
} = require('../src/lib/biometric-label.js');

test('biometric labels match platform and supported authentication types', () => {
  assert.equal(
    biometricLabelForTypes('ios', [AUTHENTICATION_TYPE.FACIAL_RECOGNITION]),
    'Face ID',
  );
  assert.equal(
    biometricLabelForTypes('ios', [AUTHENTICATION_TYPE.FINGERPRINT]),
    'Touch ID',
  );
  assert.equal(
    biometricLabelForTypes('android', [AUTHENTICATION_TYPE.FINGERPRINT]),
    'Fingerprint',
  );
  assert.equal(
    biometricLabelForTypes('android', [
      AUTHENTICATION_TYPE.FINGERPRINT,
      AUTHENTICATION_TYPE.FACIAL_RECOGNITION,
    ]),
    'Biometrics',
  );
  assert.equal(
    biometricLabelForTypes('android', [AUTHENTICATION_TYPE.FACIAL_RECOGNITION]),
    'Biometrics',
  );
  assert.equal(biometricLabelForTypes('web', []), 'Biometrics');
});

test('settings and lock screen resolve biometric labels instead of hardcoding Face ID', () => {
  const root = path.resolve(__dirname, '..');
  const settings = fs.readFileSync(path.join(root, 'src/app/(tabs)/settings.tsx'), 'utf8');
  const layout = fs.readFileSync(path.join(root, 'src/app/_layout.tsx'), 'utf8');
  for (const source of [settings, layout]) {
    assert.match(source, /getBiometricLabel/);
    assert.doesNotMatch(source, />[^<]*Face ID/);
  }
  assert.match(settings, /\{biometricLabel\} Lock/);
  assert.match(layout, /Unlock with \{biometricLabel\}/);
});
