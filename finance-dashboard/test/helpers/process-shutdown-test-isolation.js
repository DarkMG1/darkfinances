'use strict';

const { resetProcessShutdownAbortForTests } = require('../../lib/process-shutdown-abort');

function registerProcessShutdownTestIsolation(test) {
  test.beforeEach(() => {
    resetProcessShutdownAbortForTests();
  });
  test.afterEach(() => {
    resetProcessShutdownAbortForTests();
  });
}

module.exports = {
  registerProcessShutdownTestIsolation,
  resetProcessShutdownTestIsolation: resetProcessShutdownAbortForTests,
};
