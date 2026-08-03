#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');

const PREFERRED_DEVICES = [
  'iPhone 17 Pro',
  'iPhone 17',
  'iPhone 17 Pro Max',
  'iPhone 17e',
  'iPhone Air',
  'iPhone 16 Pro',
  'iPhone 16',
  'iPhone 15 Pro',
  'iPhone 15',
  'iPhone SE (3rd generation)',
  'iPhone 14 Pro',
];

function fail(message) {
  throw new Error(message);
}

function listAvailableDevices() {
  const result = spawnSync('xcrun', ['simctl', 'list', 'devices', 'available', '-j'], { encoding: 'utf8' });
  if (result.status !== 0) {
    fail(result.stderr || result.stdout || 'simctl list devices failed');
  }
  return JSON.parse(result.stdout);
}

function collectIphoneDevices(payload) {
  const devices = [];
  for (const [runtime, entries] of Object.entries(payload.devices || {})) {
    if (!runtime.includes('iOS')) continue;
    for (const entry of entries) {
      if (!entry.isAvailable || entry.isAvailable === false) continue;
      if (!entry.name?.startsWith('iPhone')) continue;
      devices.push({ ...entry, runtime });
    }
  }
  return devices;
}

function runtimeVersion(runtime) {
  const match = String(runtime || '').match(/\.iOS-(\d+)(?:-(\d+))?(?:-(\d+))?$/);
  return match ? match.slice(1).map((part) => Number(part || 0)) : [0, 0, 0];
}

function requiredRuntimeVersion(value) {
  if (!value) return null;
  if (!/^\d+\.\d+(?:\.\d+)?$/.test(value)) {
    fail(`invalid IOS_SIMULATOR_RUNTIME: ${value}`);
  }
  const parts = value.split('.').map(Number);
  while (parts.length < 3) parts.push(0);
  return parts;
}

function selectDevice(devices, { runtime = null } = {}) {
  const requiredRuntime = requiredRuntimeVersion(runtime);
  const eligible = requiredRuntime
    ? devices.filter((device) => {
        const version = runtimeVersion(device.runtime);
        return version.every((part, index) => part === requiredRuntime[index]);
      })
    : devices;
  if (requiredRuntime && eligible.length === 0) {
    fail(`no available iPhone simulator found for iOS ${runtime}`);
  }

  const ordered = [...eligible].sort((left, right) => {
    const leftVersion = runtimeVersion(left.runtime);
    const rightVersion = runtimeVersion(right.runtime);
    for (let index = 0; index < 3; index += 1) {
      if (leftVersion[index] !== rightVersion[index]) {
        return rightVersion[index] - leftVersion[index];
      }
    }
    return String(left.udid || '').localeCompare(String(right.udid || ''));
  });
  for (const preferred of PREFERRED_DEVICES) {
    const match = ordered.find((device) => device.name === preferred);
    if (match) return match;
  }
  const fallback = ordered.find((device) => device.name.startsWith('iPhone'));
  if (!fallback) fail('no available iPhone simulator found');
  return fallback;
}

function bootDevice(udid) {
  const boot = spawnSync('xcrun', ['simctl', 'boot', udid], { encoding: 'utf8' });
  if (boot.status !== 0 && !/current state: Booted|Unable to boot device in current state: Booted/.test(`${boot.stderr}${boot.stdout}`)) {
    fail(boot.stderr || boot.stdout || `simctl boot failed for ${udid}`);
  }
  const wait = spawnSync('xcrun', ['simctl', 'bootstatus', udid, '-b'], { encoding: 'utf8' });
  if (wait.status !== 0) fail(wait.stderr || wait.stdout || `simctl bootstatus failed for ${udid}`);
}

function exportDevice(device) {
  if (process.env.GITHUB_OUTPUT) {
    const fs = require('fs');
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `device=${device.udid}\n`);
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `name=${device.name}\n`);
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `runtime=${device.runtime}\n`);
  }
  process.stdout.write(`device=${device.udid}\n`);
  process.stdout.write(`name=${device.name}\n`);
  process.stdout.write(`runtime=${device.runtime}\n`);
}

function main() {
  try {
    const payload = listAvailableDevices();
    const devices = collectIphoneDevices(payload);
    const device = selectDevice(devices, { runtime: process.env.IOS_SIMULATOR_RUNTIME || null });
    bootDevice(device.udid);
    exportDevice(device);
  } catch (error) {
    console.error(`ci-ios-simulator: ${error.message}`);
    process.exit(1);
  }
}

if (require.main === module) main();
module.exports = {
  PREFERRED_DEVICES,
  bootDevice,
  collectIphoneDevices,
  selectDevice,
};
