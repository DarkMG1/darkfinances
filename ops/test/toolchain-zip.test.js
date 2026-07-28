'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');
const { extractZipArchive, validateZipArchive } = require('../../scripts/toolchain-zip');

const DEFAULT_LIMITS = {
  maxArchiveBytes: 1024 * 1024,
  maxUncompressedBytes: 1024 * 1024,
  maxMemberCount: 16,
  maxMemberBytes: 512 * 1024,
  maxCompressionRatio: 20,
};

function makeLocalFileHeader(name, data, compressionMethod = 0, crc32 = 0) {
  const nameBuffer = Buffer.from(name, 'utf8');
  const header = Buffer.alloc(30 + nameBuffer.length);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(compressionMethod, 8);
  header.writeUInt32LE(crc32 >>> 0, 14);
  header.writeUInt32LE(compressionMethod === 8 ? data.length : data.length, 18);
  header.writeUInt32LE(data.length, 22);
  header.writeUInt16LE(nameBuffer.length, 26);
  header.writeUInt16LE(0, 28);
  nameBuffer.copy(header, 30);
  return Buffer.concat([header, data]);
}

function makeCentralDirectoryEntry(name, localHeaderOffset, sizes) {
  const nameBuffer = Buffer.from(name, 'utf8');
  const entry = Buffer.alloc(46 + nameBuffer.length);
  entry.writeUInt32LE(0x02014b50, 0);
  entry.writeUInt16LE(20, 4);
  entry.writeUInt16LE(0, 6);
  entry.writeUInt16LE(sizes.compressionMethod || 0, 10);
  entry.writeUInt32LE((sizes.crc32 || 0) >>> 0, 16);
  entry.writeUInt32LE(sizes.compressedSize, 20);
  entry.writeUInt32LE(sizes.uncompressedSize, 24);
  entry.writeUInt16LE(nameBuffer.length, 28);
  entry.writeUInt16LE(0, 30);
  entry.writeUInt16LE(0, 32);
  entry.writeUInt32LE(0, 34);
  entry.writeUInt32LE(sizes.externalAttributes || 0, 38);
  entry.writeUInt32LE(localHeaderOffset, 42);
  nameBuffer.copy(entry, 46);
  return entry;
}

function makeZip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const data = entry.data || Buffer.alloc(0);
    const payload = entry.compressionMethod === 8
      ? zlib.deflateRawSync(data)
      : data;
    const crc32 = entry.isDirectory ? 0 : zlib.crc32(data) >>> 0;
    const local = makeLocalFileHeader(entry.name, payload, entry.compressionMethod || 0, crc32);
    parts.push(local);
    central.push(makeCentralDirectoryEntry(entry.name, offset, {
      compressionMethod: entry.compressionMethod || 0,
      compressedSize: payload.length,
      uncompressedSize: data.length,
      crc32,
      externalAttributes: entry.isDirectory ? ((0o040755 << 16) >>> 0) : 0,
    }));
    offset += local.length;
  }
  const centralStart = offset;
  const centralDir = Buffer.concat(central);
  parts.push(centralDir);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(centralStart, 16);
  parts.push(eocd);
  return Buffer.concat(parts);
}

test('validateZipArchive rejects symlink members', () => {
  const data = Buffer.from('target');
  const local = makeLocalFileHeader('link.txt', data);
  const central = makeCentralDirectoryEntry('link.txt', 0, {
    compressedSize: data.length,
    uncompressedSize: data.length,
    externalAttributes: ((0o120000 << 16) >>> 0),
  });
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(local.length, 16);
  const zip = Buffer.concat([local, central, eocd]);
  assert.throws(
    () => validateZipArchive(zip, DEFAULT_LIMITS),
    /symlink member/,
  );
});

test('validateZipArchive rejects traversal and duplicate members', () => {
  assert.throws(
    () => validateZipArchive(makeZip([{ name: '../evil.txt', data: Buffer.from('x') }]), DEFAULT_LIMITS),
    /traversal|unsafe/,
  );
  assert.throws(
    () => validateZipArchive(makeZip([
      { name: 'a.txt', data: Buffer.from('a') },
      { name: 'a.txt', data: Buffer.from('b') },
    ]), DEFAULT_LIMITS),
    /duplicate member/,
  );
});

test('validateZipArchive rejects zip bomb compression ratio', () => {
  const data = Buffer.alloc(256 * 1024, 0);
  const zip = makeZip([{ name: 'bomb.bin', data, compressionMethod: 8 }]);
  assert.throws(
    () => validateZipArchive(zip, { ...DEFAULT_LIMITS, maxCompressionRatio: 10 }),
    /compression ratio bound/,
  );
});

test('extractZipArchive publishes directories and files from full tree archives', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-extract-'));
  const zip = makeZip([
    { name: 'maestro/', data: Buffer.alloc(0), isDirectory: true },
    { name: 'maestro/bin/maestro', data: Buffer.from('#!/bin/sh\necho maestro\n') },
    { name: 'maestro/lib/helper.jar', data: Buffer.from('jar') },
  ]);
  const members = extractZipArchive(zip, dest, DEFAULT_LIMITS);
  assert.ok(members.includes('maestro/'));
  assert.ok(fs.existsSync(path.join(dest, 'maestro/lib/helper.jar')));
});

test('validateZipArchive rejects zip64 end-of-central-directory marker', () => {
  const zip = makeZip([{ name: 'a.txt', data: Buffer.from('a') }]);
  const eocdOffset = zip.length - 22;
  zip.writeUInt32LE(0x07064b50, eocdOffset);
  assert.throws(
    () => validateZipArchive(zip, DEFAULT_LIMITS),
    /zip64 end-of-central-directory is not supported/,
  );
});

test('validateZipArchive rejects zip64 central directory count/size/offset sentinels', () => {
  const zip = makeZip([{ name: 'a.txt', data: Buffer.from('a') }]);
  const eocdOffset = zip.length - 22;
  zip.writeUInt16LE(0xffff, eocdOffset + 10);
  assert.throws(
    () => validateZipArchive(zip, DEFAULT_LIMITS),
    /zip64 central directory size\/offset markers are not supported/,
  );
  const zip2 = makeZip([{ name: 'a.txt', data: Buffer.from('a') }]);
  const eocd2 = zip2.length - 22;
  zip2.writeUInt32LE(0xffffffff, eocd2 + 12);
  assert.throws(
    () => validateZipArchive(zip2, DEFAULT_LIMITS),
    /zip64 central directory size\/offset markers are not supported/,
  );
});

test('validateZipArchive rejects zip64 extended information extra field', () => {
  const data = Buffer.from('payload');
  const nameBuffer = Buffer.from('a.txt', 'utf8');
  const extra = Buffer.alloc(4);
  extra.writeUInt16LE(0x0001, 0);
  extra.writeUInt16LE(0, 2);
  const local = Buffer.alloc(30 + nameBuffer.length + extra.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 8);
  local.writeUInt32LE(zlib.crc32(data) >>> 0, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuffer.length, 26);
  local.writeUInt16LE(extra.length, 28);
  nameBuffer.copy(local, 30);
  extra.copy(local, 30 + nameBuffer.length);
  const localPart = Buffer.concat([local, data]);
  const central = makeCentralDirectoryEntry('a.txt', 0, {
    compressedSize: data.length,
    uncompressedSize: data.length,
    crc32: zlib.crc32(data) >>> 0,
  });
  const centralWithExtra = Buffer.concat([
    central.slice(0, 46 + nameBuffer.length),
    extra,
  ]);
  centralWithExtra.writeUInt16LE(extra.length, 30);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralWithExtra.length, 12);
  eocd.writeUInt32LE(localPart.length, 16);
  const zip = Buffer.concat([localPart, centralWithExtra, eocd]);
  assert.throws(
    () => validateZipArchive(zip, DEFAULT_LIMITS),
    /zip64 extended information extra field is not supported/,
  );
});

test('extractZipArchive rejects zero-size deflate entries with non-empty compressed data', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-zero-deflate-'));
  const payload = Buffer.from('not-empty');
  const compressed = zlib.deflateRawSync(payload);
  assert.ok(compressed.length > 0);
  const nameBuffer = Buffer.from('bomb.bin', 'utf8');
  const local = Buffer.alloc(30 + nameBuffer.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(zlib.crc32(payload) >>> 0, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(0, 22);
  local.writeUInt16LE(nameBuffer.length, 26);
  local.writeUInt16LE(0, 28);
  nameBuffer.copy(local, 30);
  const localPart = Buffer.concat([local, compressed]);
  const central = makeCentralDirectoryEntry('bomb.bin', 0, {
    compressionMethod: 8,
    compressedSize: compressed.length,
    uncompressedSize: 0,
    crc32: zlib.crc32(payload) >>> 0,
  });
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(localPart.length, 16);
  const zip = Buffer.concat([localPart, central, eocd]);
  assert.throws(
    () => extractZipArchive(zip, dest, DEFAULT_LIMITS),
    /declares zero output size with non-empty compressed data/,
  );
});
