'use strict';

const fs = require('fs');
const path = require('path');
const { exportPublicKeyPem, exportPrivateKeyPem } = require('../../lib/coordinated-admission-crypto');
const { buildTestAdmissionToken, registerTestAdmission } = require('./admission-token-fixtures');
const { coordinatedLayoutForRoot } = require('../../lib/coordinated-operation-layout');

function installFakeSystemctl(root, units = {}) {
  const fakeBin = path.join(root, 'bin');
  fs.mkdirSync(fakeBin, { recursive: true, mode: 0o700 });
  const unitJson = JSON.stringify(units);
  fs.writeFileSync(path.join(fakeBin, 'systemctl'), `#!/usr/bin/env bash
set -euo pipefail
units='${unitJson}'
unit="\${@: -1}"
case " \$* " in
  *" is-active "*) node -e "const u=process.argv[1];const m=JSON.parse(process.argv[2]);const e=m[u]||{active:'inactive'};const s=e.active||'inactive';process.stdout.write(s);process.exit(['active','activating'].includes(s)?0:3)" "$unit" "$units" ;;
  *" is-enabled "*) node -e "const u=process.argv[1];const m=JSON.parse(process.argv[2]);const e=m[u]||{enabled:'disabled'};process.stdout.write(e.enabled||'disabled');process.exit(0)" "$unit" "$units" ;;
  *" list-units "*) exit 0 ;;
  *" stop "*|*" start "*) exit 0 ;;
  *) exit 0 ;;
esac
`, { mode: 0o755 });
  return fakeBin;
}

function installTestCoordinatorKeys(root, keyPair = null) {
  const { generateTestKeyPair } = require('../../lib/coordinated-admission-crypto');
  const pair = keyPair || generateTestKeyPair();
  const configDir = path.join(root, '.config', 'darkfinances');
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const privatePath = path.join(configDir, 'coordinated-sign.pem');
  const publicPath = path.join(configDir, 'coordinated-verify.pem');
  fs.writeFileSync(privatePath, exportPrivateKeyPem(pair.privateKey), { mode: 0o600 });
  fs.writeFileSync(publicPath, exportPublicKeyPem(pair.publicKey), { mode: 0o600 });
  return { pair, privatePath, publicPath };
}

function signedAdmissionEnv(root, {
  destination,
  archivePath,
  coordinatorRoot = path.join(root, 'backups'),
  bindings = {},
  keyPair = null,
  writers = {},
} = {}) {
  const keys = installTestCoordinatorKeys(root, keyPair);
  const layout = coordinatedLayoutForRoot(coordinatorRoot);
  fs.mkdirSync(layout.controlRoot, { recursive: true, mode: 0o700 });
  const { token } = buildTestAdmissionToken({
    keyPair: keys.pair,
    bindings: {
      archiveSha256: require('../../lib/backup-verify').sha256File(archivePath),
      destinationRoot: path.resolve(destination),
      manifestArtifactId: bindings.manifestArtifactId || 'a'.repeat(64),
      releaseManifestDigest: bindings.releaseManifestDigest || 'b'.repeat(64),
      coordinatedManifestDigest: bindings.coordinatedManifestDigest || 'c'.repeat(64),
      writerInventoryDigest: bindings.writerInventoryDigest || 'd'.repeat(64),
      actualDataGeneration: bindings.actualDataGeneration ?? null,
    },
    writers,
  });
  registerTestAdmission(layout, token);
  const tokenPath = path.join(root, 'quiescence-admission.json');
  fs.writeFileSync(tokenPath, `${JSON.stringify(token, null, 2)}\n`, { mode: 0o600 });
  const fakeBin = installFakeSystemctl(root, {
    'finance-dashboard.service': { active: 'inactive', enabled: 'enabled' },
    'actual-sync.timer': { active: 'inactive', enabled: 'enabled' },
    'actual-sync.service': { active: 'inactive', enabled: 'enabled' },
  });
  return {
    env: {
      ...process.env,
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`,
      RESTORE_QUIESCENCE_ADMISSION_PATH: tokenPath,
      COORDINATED_VERIFY_KEY_PATH: keys.publicPath,
      COORDINATED_SIGNING_KEY_PATH: keys.privatePath,
      DARKFINANCES_BACKUP_DIR: coordinatorRoot,
    },
    token,
    layout,
    keys,
  };
}

module.exports = {
  installFakeSystemctl,
  installTestCoordinatorKeys,
  signedAdmissionEnv,
};
