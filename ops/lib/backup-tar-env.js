'use strict';

const COPYFILE_DISABLE_VALUE = '1';

function backupTarEnv(baseEnv = process.env) {
  return {
    ...baseEnv,
    COPYFILE_DISABLE: COPYFILE_DISABLE_VALUE,
  };
}

module.exports = {
  COPYFILE_DISABLE_VALUE,
  backupTarEnv,
};
