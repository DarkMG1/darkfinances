'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIR_SIGNATURE = 0x02014b50;
const LOCAL_FILE_SIGNATURE = 0x04034b50;

function fail(message) {
  throw new Error(message);
}

function readUInt16LE(buffer, offset) {
  return buffer.readUInt16LE(offset);
}

function readUInt32LE(buffer, offset) {
  return buffer.readUInt32LE(offset);
}

function findEndOfCentralDirectory(buffer) {
  const minimum = 22;
  const start = Math.max(0, buffer.length - (0xffff + minimum));
  for (let offset = buffer.length - minimum; offset >= start; offset -= 1) {
    const signature = readUInt32LE(buffer, offset);
    if (signature === 0x07064b50) fail('zip64 end-of-central-directory is not supported');
    if (signature === EOCD_SIGNATURE) return offset;
  }
  fail('zip archive missing end-of-central-directory record');
}

function rejectZip64ExtraField(buffer, offset, extraLength, label) {
  if (extraLength <= 0) return;
  const extraStart = offset;
  const extraEnd = extraStart + extraLength;
  let extraOffset = extraStart;
  while (extraOffset + 4 <= extraEnd) {
    const extraId = readUInt16LE(buffer, extraOffset);
    const dataSize = readUInt16LE(buffer, extraOffset + 2);
    if (extraId === 0x0001) fail(`zip64 extended information extra field is not supported (${label})`);
    extraOffset += 4 + dataSize;
  }
}

function normalizeMemberPath(member, label = 'member', { allowDirectory = false } = {}) {
  if (typeof member !== 'string' || member.length === 0) {
    fail(`unsafe archive ${label}: empty path`);
  }
  if (member.includes('\\')) fail(`unsafe archive ${label}: backslash path ${member}`);
  if (member.includes('\0')) fail(`unsafe archive ${label}: NUL path ${member}`);
  if (member.startsWith('/') || member.startsWith('./') || member.startsWith('../')) {
    fail(`unsafe archive ${label}: absolute or relative path ${member}`);
  }
  const portable = member.replaceAll('\\', '/');
  const isDirectory = portable.endsWith('/');
  const trimmed = isDirectory ? portable.slice(0, -1) : portable;
  if (trimmed.length === 0) fail(`unsafe archive ${label}: root directory path`);
  const parts = trimmed.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    fail(`unsafe archive ${label}: traversal path ${member}`);
  }
  if (isDirectory && !allowDirectory) {
    fail(`unsafe archive ${label}: directory path ${member}`);
  }
  return isDirectory ? `${trimmed}/` : trimmed;
}

function collisionKey(normalized, isDirectory) {
  return isDirectory ? `${normalized}\0dir` : `${normalized}\0file`;
}

function parseCentralDirectory(buffer, limits) {
  const eocdOffset = findEndOfCentralDirectory(buffer);
  const entryCount = readUInt16LE(buffer, eocdOffset + 10);
  const centralDirSize = readUInt32LE(buffer, eocdOffset + 12);
  const centralDirOffset = readUInt32LE(buffer, eocdOffset + 16);
  if (entryCount === 0xffff || centralDirSize === 0xffffffff || centralDirOffset === 0xffffffff) {
    fail('zip64 central directory size/offset markers are not supported');
  }
  if (entryCount > limits.maxMemberCount) {
    fail(`zip archive exceeds member count bound (${limits.maxMemberCount})`);
  }
  if (centralDirOffset + centralDirSize > buffer.length) {
    fail('zip central directory exceeds archive bounds');
  }

  const entries = [];
  let offset = centralDirOffset;
  let totalUncompressed = 0;
  const seen = new Set();
  const seenLower = new Set();

  for (let index = 0; index < entryCount; index += 1) {
    if (readUInt32LE(buffer, offset) !== CENTRAL_DIR_SIGNATURE) {
      fail(`zip central directory entry ${index} has invalid signature`);
    }
    const compressionMethod = readUInt16LE(buffer, offset + 10);
    const crc32 = readUInt32LE(buffer, offset + 16);
    const compressedSize = readUInt32LE(buffer, offset + 20);
    const uncompressedSize = readUInt32LE(buffer, offset + 24);
    const nameLength = readUInt16LE(buffer, offset + 28);
    const extraLength = readUInt16LE(buffer, offset + 30);
    const commentLength = readUInt16LE(buffer, offset + 32);
    const externalAttributes = readUInt32LE(buffer, offset + 38);
    const localHeaderOffset = readUInt32LE(buffer, offset + 42);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > buffer.length) fail(`zip entry ${index} name exceeds archive bounds`);
    rejectZip64ExtraField(buffer, nameEnd, extraLength, `entry ${index}`);
    const rawName = buffer.slice(nameStart, nameEnd).toString('utf8');
    const unixMode = (externalAttributes >>> 16) & 0xffff;
    const isSymlink = (unixMode & 0o170000) === 0o120000;
    const isDirectory = rawName.endsWith('/') || (unixMode & 0o170000) === 0o040000;
    const normalized = normalizeMemberPath(rawName, `entry ${index}`, { allowDirectory: isDirectory });
    const key = collisionKey(normalized, isDirectory);
    if (seen.has(key)) fail(`zip archive contains duplicate member: ${normalized}`);
    const lowerKey = `${normalized.toLowerCase()}\0${isDirectory ? 'dir' : 'file'}`;
    if (seenLower.has(lowerKey)) {
      fail(`zip archive contains case-colliding members for ${normalized}`);
    }
    seen.add(key);
    seenLower.add(lowerKey);

    if (isSymlink) fail(`zip archive contains symlink member: ${normalized}`);
    if (!isDirectory && compressionMethod !== 0 && compressionMethod !== 8) {
      fail(`zip entry ${index} uses unsupported compression method ${compressionMethod}`);
    }
    if (isDirectory) {
      entries.push({
        name: normalized,
        isDirectory: true,
        compressionMethod,
        crc32,
        compressedSize,
        uncompressedSize,
        localHeaderOffset,
      });
      offset = nameEnd + extraLength + commentLength;
      continue;
    }
    if (uncompressedSize > limits.maxMemberBytes) {
      fail(`zip member ${normalized} exceeds per-file uncompressed bound (${limits.maxMemberBytes})`);
    }
    if (compressedSize > limits.maxArchiveBytes) {
      fail(`zip member ${normalized} exceeds compressed size bound (${limits.maxArchiveBytes})`);
    }
    if (uncompressedSize > 0 && compressedSize > 0) {
      const ratio = uncompressedSize / compressedSize;
      if (ratio > limits.maxCompressionRatio) {
        fail(`zip member ${normalized} exceeds compression ratio bound (${limits.maxCompressionRatio})`);
      }
    }
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > limits.maxUncompressedBytes) {
      fail(`zip archive exceeds total uncompressed bound (${limits.maxUncompressedBytes})`);
    }

    entries.push({
      name: normalized,
      isDirectory: false,
      compressionMethod,
      crc32,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });
    offset = nameEnd + extraLength + commentLength;
  }

  return entries;
}

function readLocalHeader(buffer, entry) {
  const offset = entry.localHeaderOffset;
  if (readUInt32LE(buffer, offset) !== LOCAL_FILE_SIGNATURE) {
    fail(`zip local header invalid for ${entry.name}`);
  }
  const flags = readUInt16LE(buffer, offset + 6);
  const compressionMethod = readUInt16LE(buffer, offset + 8);
  const crc32 = readUInt32LE(buffer, offset + 14);
  const compressedSize = readUInt32LE(buffer, offset + 18);
  const uncompressedSize = readUInt32LE(buffer, offset + 22);
  const nameLength = readUInt16LE(buffer, offset + 26);
  const extraLength = readUInt16LE(buffer, offset + 28);
  const nameStart = offset + 30;
  const nameEnd = nameStart + nameLength;
  if (nameEnd > buffer.length) fail(`zip local header name exceeds archive bounds for ${entry.name}`);
  const rawName = buffer.slice(nameStart, nameEnd).toString('utf8');
  const localIsDirectory = rawName.endsWith('/');
  const normalized = normalizeMemberPath(rawName, `local header for ${entry.name}`, { allowDirectory: localIsDirectory });
  if (normalized !== entry.name) {
    fail(`zip local header name mismatch for ${entry.name}: ${normalized}`);
  }
  if (entry.isDirectory) {
    return {
      dataStart: nameEnd + extraLength,
      dataEnd: nameEnd + extraLength,
      flags,
    };
  }
  if (!entry.isDirectory && compressionMethod !== entry.compressionMethod) {
    fail(`zip local header compression mismatch for ${entry.name}`);
  }
  if (compressedSize !== entry.compressedSize || uncompressedSize !== entry.uncompressedSize) {
    fail(`zip local header size mismatch for ${entry.name}`);
  }
  if (crc32 !== entry.crc32) {
    fail(`zip local header crc mismatch for ${entry.name}`);
  }
  if ((flags & 0x0001) !== 0) {
    fail(`zip local header uses unsupported encryption flag for ${entry.name}`);
  }
  const dataStart = nameEnd + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > buffer.length) fail(`zip member ${entry.name} data exceeds archive bounds`);
  return {
    dataStart,
    dataEnd,
    flags,
  };
}

function readLocalFileData(buffer, entry, limits) {
  const header = readLocalHeader(buffer, entry);
  if (entry.isDirectory) return Buffer.alloc(0);
  const compressed = buffer.slice(header.dataStart, header.dataEnd);
  let data;
  if (entry.compressionMethod === 0) {
    data = compressed;
  } else if (entry.compressionMethod === 8) {
    if (entry.uncompressedSize === 0 && entry.compressedSize > 0) {
      fail(`zip member ${entry.name} declares zero output size with non-empty compressed data`);
    }
    data = zlib.inflateRawSync(compressed, {
      maxOutputLength: limits.maxMemberBytes,
    });
  } else {
    fail(`zip member ${entry.name} uses unsupported compression`);
  }
  if (data.length !== entry.uncompressedSize) {
    fail(`zip member ${entry.name} uncompressed size mismatch`);
  }
  const actualCrc = zlib.crc32(data) >>> 0;
  if (actualCrc !== entry.crc32) {
    fail(`zip member ${entry.name} crc32 mismatch`);
  }
  return data;
}

function validateZipArchive(buffer, limits) {
  if (!Buffer.isBuffer(buffer)) fail('zip archive must be a Buffer');
  if (buffer.length > limits.maxArchiveBytes) {
    fail(`zip archive exceeds compressed size bound (${limits.maxArchiveBytes})`);
  }
  return parseCentralDirectory(buffer, limits);
}

function extractZipArchive(buffer, destRoot, limits) {
  const entries = validateZipArchive(buffer, limits);
  const resolvedRoot = path.resolve(destRoot);
  fs.mkdirSync(resolvedRoot, { recursive: true });
  const extracted = [];
  for (const entry of entries) {
    const destPath = path.resolve(resolvedRoot, ...entry.name.replace(/\/$/, '').split('/'));
    const relative = path.relative(resolvedRoot, destPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      fail(`zip member escapes destination: ${entry.name}`);
    }
    if (entry.isDirectory) {
      fs.mkdirSync(destPath, { recursive: true });
      extracted.push(entry.name);
      continue;
    }
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    const data = readLocalFileData(buffer, entry, limits);
    fs.writeFileSync(destPath, data, { mode: entry.name.endsWith('.sh') || entry.name.includes('/bin/') ? 0o755 : 0o644 });
    extracted.push(entry.name);
  }
  return extracted;
}

module.exports = {
  collisionKey,
  extractZipArchive,
  normalizeMemberPath,
  parseCentralDirectory,
  readLocalFileData,
  readLocalHeader,
  validateZipArchive,
};
