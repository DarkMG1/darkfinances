const fs = require('fs');
const path = require('path');
const {
  RELEASE_PROFILE_RULES,
  requireNonEmptyString,
} = require('../finance-dashboard/lib/release-schema');

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function resolveReleaseProfile(root, variant, requestedProfile = null) {
  const profile = requestedProfile || (variant === 'free-sideload' ? 'free-sideload' : 'production');
  requireNonEmptyString(profile, 'release profile');
  const rule = RELEASE_PROFILE_RULES[profile];
  if (!rule) throw new Error(`unsupported release profile: ${profile}`);
  if (rule.variant !== variant) {
    throw new Error(`release profile ${profile} is not valid for ${variant}`);
  }
  if (profile === 'production' || profile === 'preview') {
    const eas = readJson(path.join(root, 'finance-app', 'eas.json'), 'finance-app/eas.json');
    const buildProfile = eas.build?.[profile];
    if (!buildProfile || typeof buildProfile !== 'object' || Array.isArray(buildProfile)) {
      throw new Error(`finance-app/eas.json is missing build profile ${profile}`);
    }
    if (buildProfile.channel !== rule.channel || buildProfile.environment !== rule.environment) {
      throw new Error(
        `finance-app/eas.json ${profile} must map channel ${rule.channel} and environment ${rule.environment}`,
      );
    }
  }
  return { name: profile, ...rule };
}

module.exports = { resolveReleaseProfile };
