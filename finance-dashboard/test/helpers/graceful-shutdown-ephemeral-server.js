'use strict';

const path = require('path');
const { startEphemeralDashboardServer } = require('./ephemeral-dashboard-server');

async function startShutdownDashboard(t, {
  tempPrefix,
  preloadBody,
  extraEnvForDir = () => ({}),
} = {}) {
  let releasePath;
  const started = await startEphemeralDashboardServer(t, {
    tempPrefix,
    preloadBody,
    extraEnvForDir: (dir) => {
      releasePath = path.join(dir, 'release.fill');
      return {
        TEST_RELEASE_PATH: releasePath,
        ...extraEnvForDir(dir),
      };
    },
  });
  return { ...started, releasePath };
}

module.exports = {
  startShutdownDashboard,
};
