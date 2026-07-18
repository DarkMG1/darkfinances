'use strict';

function isReconnectRefreshActive(input) {
  return input.configured && !input.demo;
}

module.exports = {
  isReconnectRefreshActive,
};
