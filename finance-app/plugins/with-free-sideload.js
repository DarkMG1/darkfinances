const { withEntitlementsPlist } = require('@expo/config-plugins');

module.exports = function withFreeSideload(config) {
  return withEntitlementsPlist(config, (config) => {
    delete config.modResults['aps-environment'];
    delete config.modResults['com.apple.security.application-groups'];
    return config;
  });
};
