const fs = require('fs');
const path = require('path');
const {
  ACTUAL_VERSION_PATTERN,
  validateActualAlignment,
} = require('../finance-dashboard/lib/release-schema');

const ACTUAL_IMAGE_PIN_PATTERN = /^([^@]+)@(sha256:[a-f0-9]{64})$/;

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function readActualServiceImage(compose) {
  const lines = compose.split(/\r?\n/);
  const serviceRoots = lines
    .map((line, index) => (/^services:\s*(?:#.*)?$/.test(line) ? index : -1))
    .filter((index) => index >= 0);
  if (serviceRoots.length !== 1) {
    throw new Error('ops/actual-compose.yml must contain one top-level services mapping');
  }
  const servicesStart = serviceRoots[0];
  let servicesEnd = lines.length;
  for (let index = servicesStart + 1; index < lines.length; index += 1) {
    if (/^[^\s#]/.test(lines[index])) {
      servicesEnd = index;
      break;
    }
  }
  const actualServices = [];
  for (let index = servicesStart + 1; index < servicesEnd; index += 1) {
    if (/^  actual:\s*(?:#.*)?$/.test(lines[index])) actualServices.push(index);
  }
  if (actualServices.length !== 1) {
    throw new Error('ops/actual-compose.yml must contain one direct services.actual mapping');
  }
  const actualStart = actualServices[0];
  let actualEnd = servicesEnd;
  for (let index = actualStart + 1; index < servicesEnd; index += 1) {
    if (/^  [^\s#][^:]*:/.test(lines[index])) {
      actualEnd = index;
      break;
    }
  }
  const images = [];
  for (let index = actualStart + 1; index < actualEnd; index += 1) {
    const match = lines[index].match(
      /^    image:\s*["']?actualbudget\/actual-server:([^"'\s#]+)["']?\s*(?:#.*)?$/,
    );
    if (match) images.push(match[1]);
  }
  if (images.length !== 1) {
    throw new Error('ops/actual-compose.yml must contain one direct services.actual.image');
  }
  const pin = ACTUAL_IMAGE_PIN_PATTERN.exec(images[0]);
  if (!pin) {
    throw new Error(
      'Actual server image must use an exact tag@sha256 digest pin '
      + '(actualbudget/actual-server:x.y.z@sha256:<64 lowercase hex>)',
    );
  }
  return pin[1];
}

function readActualAlignment(root) {
  const composePath = path.join(root, 'ops', 'actual-compose.yml');
  const dashboardPath = path.join(root, 'finance-dashboard', 'package.json');
  const toolsPath = path.join(root, 'actual-tools', 'package.json');
  const compose = fs.readFileSync(composePath, 'utf8');
  const serverImage = readActualServiceImage(compose);
  const dashboardApi = readJson(dashboardPath, 'finance-dashboard/package.json')
    .dependencies?.['@actual-app/api'] || null;
  const toolsApi = readJson(toolsPath, 'actual-tools/package.json')
    .dependencies?.['@actual-app/api'] || null;
  return validateActualAlignment({ serverImage, dashboardApi, toolsApi });
}

module.exports = {
  ACTUAL_IMAGE_PIN_PATTERN,
  ACTUAL_VERSION_PATTERN,
  readActualServiceImage,
  readActualAlignment,
  validateActualAlignment,
};
