'use strict';

function isNotificationReconciliationActive(input) {
  return input.configured && !input.demo && input.notificationsCapable;
}

module.exports = {
  isNotificationReconciliationActive,
};
