'use strict';

const NetInfo = require('@react-native-community/netinfo');

/**
 * @param {(snapshot: { isConnected: boolean | null, isInternetReachable: boolean | null }) => void} listener
 */
function subscribeNativeConnectivity(listener) {
  return NetInfo.addEventListener((state) => {
    listener({
      isConnected: state.isConnected ?? null,
      isInternetReachable: state.isInternetReachable ?? null,
    });
  });
}

module.exports = {
  subscribeNativeConnectivity,
};
