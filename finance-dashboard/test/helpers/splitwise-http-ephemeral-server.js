'use strict';

const fs = require('fs');
const path = require('path');
const { startEphemeralDashboardServer } = require('./ephemeral-dashboard-server');

function defaultSplitwiseStateFiles(dir) {
  return {
    journalPath: path.join(dir, 'operation-journal.json'),
    bulkPath: path.join(dir, 'bulk-operation-sagas.json'),
    owesPath: path.join(dir, 'owes-truth.json'),
    resolutionsPath: path.join(dir, 'splitwise-mirror-resolutions.json'),
    deletionPath: path.join(dir, 'transaction-deletion-sagas.json'),
    rowsPath: path.join(dir, 'mirror-rows.json'),
    personalPath: path.join(dir, 'personal.json'),
  };
}

function splitwiseExtraEnvForDir(dir, extra = {}) {
  return {
    ALLOW_RAW_ACTUAL_API: '1',
    OWES_TRUTH_PATH: path.join(dir, 'owes-truth.json'),
    SPLITWISE_MIRROR_RESOLUTIONS_PATH: path.join(dir, 'splitwise-mirror-resolutions.json'),
    TRANSACTION_DELETION_SAGAS_PATH: path.join(dir, 'transaction-deletion-sagas.json'),
    PERSONAL_CONFIG_PATH: path.join(dir, 'personal.json'),
    ...extra,
  };
}

async function startSplitwiseHttpServer(t, {
  tempPrefix,
  preloadBody,
  prepareState = null,
  extraEnvForDir = () => ({}),
} = {}) {
  let paths = {};
  const started = await startEphemeralDashboardServer(t, {
    tempPrefix,
    preloadFileName: 'preload-fixture-actual.js',
    preloadBody,
    prepareDir: (dir) => {
      paths = defaultSplitwiseStateFiles(dir);
      if (prepareState) prepareState(dir, paths);
    },
    extraEnvForDir: (dir) => splitwiseExtraEnvForDir(dir, extraEnvForDir(dir, paths)),
  });
  return { ...started, ...paths };
}

module.exports = {
  defaultSplitwiseStateFiles,
  splitwiseExtraEnvForDir,
  startSplitwiseHttpServer,
};
