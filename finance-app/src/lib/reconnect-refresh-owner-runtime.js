'use strict';

const {
  createReconnectRefreshOwner,
  getReconnectStaleWarningStore,
  resetReconnectRefreshStateForTests,
} = require('./reconnect-refresh');

/** @type {ReturnType<typeof createReconnectRefreshOwner> | null} */
let sharedOwner = null;
/** @type {Parameters<typeof createReconnectRefreshOwner>[0] | null} */
let ownerDeps = null;

const runtimeConfig = {
  scope: '',
  profileGeneration: 0,
  active: false,
  demo: false,
};

function configureReconnectRefreshOwnerDeps(baseDeps) {
  ownerDeps = {
    ...baseDeps,
    staleWarning: getReconnectStaleWarningStore(),
    get scope() {
      return runtimeConfig.scope;
    },
    get profileGeneration() {
      return runtimeConfig.profileGeneration;
    },
    isEnabled: () => runtimeConfig.active && !runtimeConfig.demo && !!runtimeConfig.scope,
  };
  if (sharedOwner) {
    sharedOwner.dispose();
    sharedOwner = null;
  }
}

function getSharedReconnectRefreshOwner() {
  if (!ownerDeps) {
    throw new Error('Reconnect refresh owner deps are not configured');
  }
  if (!sharedOwner) {
    sharedOwner = createReconnectRefreshOwner({
      ...ownerDeps,
      scope: runtimeConfig.scope,
      profileGeneration: runtimeConfig.profileGeneration,
      initialActive: runtimeConfig.active,
    });
  }
  return sharedOwner;
}

function updateReconnectRefreshRuntimeConfig(next) {
  runtimeConfig.scope = next.scope ?? '';
  runtimeConfig.profileGeneration = next.profileGeneration ?? 0;
  runtimeConfig.active = !!next.active;
  runtimeConfig.demo = !!next.demo;
  const owner = getSharedReconnectRefreshOwner();
  owner.setScope(runtimeConfig.scope);
  owner.setProfileGeneration(runtimeConfig.profileGeneration);
  owner.setActive(runtimeConfig.active);
}

function purgeReconnectRefreshOwnerProfile(scope) {
  getSharedReconnectRefreshOwner().purgeProfile(scope);
}

function resetReconnectRefreshOwnerRuntimeForTests() {
  sharedOwner?.dispose();
  sharedOwner = null;
  ownerDeps = null;
  runtimeConfig.scope = '';
  runtimeConfig.profileGeneration = 0;
  runtimeConfig.active = false;
  runtimeConfig.demo = false;
  resetReconnectRefreshStateForTests();
}

module.exports = {
  configureReconnectRefreshOwnerDeps,
  getSharedReconnectRefreshOwner,
  purgeReconnectRefreshOwnerProfile,
  resetReconnectRefreshOwnerRuntimeForTests,
  updateReconnectRefreshRuntimeConfig,
};
