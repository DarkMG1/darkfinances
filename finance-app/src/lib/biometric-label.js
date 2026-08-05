const AUTHENTICATION_TYPE = Object.freeze({
  FINGERPRINT: 1,
  FACIAL_RECOGNITION: 2,
});

/**
 * Resolve the user-facing name for the biometric methods exposed by a device.
 *
 * @param {string} platform
 * @param {readonly number[]} types
 * @returns {'Face ID' | 'Touch ID' | 'Fingerprint' | 'Biometrics'}
 */
function biometricLabelForTypes(platform, types) {
  if (platform === 'ios') {
    if (types.includes(AUTHENTICATION_TYPE.FACIAL_RECOGNITION)) return 'Face ID';
    if (types.includes(AUTHENTICATION_TYPE.FINGERPRINT)) return 'Touch ID';
  }

  if (
    platform === 'android'
    && types.length === 1
    && types[0] === AUTHENTICATION_TYPE.FINGERPRINT
  ) {
    return 'Fingerprint';
  }

  return 'Biometrics';
}

module.exports = {
  AUTHENTICATION_TYPE,
  biometricLabelForTypes,
};
