const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PUBLIC_ROOT = path.resolve(__dirname, '..', 'public');
const MODULE_ROOT = path.join(PUBLIC_ROOT, 'js');
const MANIFEST_RELATIVE = 'browser-manifest.json';
const CHART_VENDOR_MANIFEST_RELATIVE = 'vendor/chart-js.manifest.json';

const CONTENT_TYPES = Object.freeze({
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
});

const PAGE_ASSETS = Object.freeze(['index.html', 'login.html']);
const VENDOR_ASSETS = Object.freeze([
  'vendor/chart.umd.js',
  'vendor/chart-js.manifest.json',
  'vendor/THIRD-PARTY-NOTICES.txt',
]);
const META_ASSETS = Object.freeze([MANIFEST_RELATIVE]);

function inventoryAssetPaths(manifestOrBuilt) {
  return [
    ...(manifestOrBuilt.pages || PAGE_ASSETS),
    ...(manifestOrBuilt.stylesheets || []),
    ...(manifestOrBuilt.modules || []),
    ...(manifestOrBuilt.vendor || VENDOR_ASSETS),
  ].sort();
}

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function listModuleFiles(relative = '', root = MODULE_ROOT) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) return listModuleFiles(child, absolute);
    if (entry.isFile() && entry.name.endsWith('.js') && entry.name !== 'package.json') return [child];
    return [];
  });
}

function hashFile(relativePath, publicRoot = PUBLIC_ROOT) {
  const absolute = path.join(publicRoot, relativePath);
  return sha256Buffer(fs.readFileSync(absolute));
}

function loadChartVendorManifest(publicRoot = PUBLIC_ROOT) {
  return JSON.parse(fs.readFileSync(path.join(publicRoot, CHART_VENDOR_MANIFEST_RELATIVE), 'utf8'));
}

function buildBrowserManifest(publicRoot = PUBLIC_ROOT) {
  const moduleFiles = listModuleFiles(undefined, path.join(publicRoot, 'js')).sort().map((file) => `js/${file}`);
  const stylesheets = ['css/dashboard.css', 'css/login.css'];
  const assets = inventoryAssetPaths({
    pages: PAGE_ASSETS,
    stylesheets,
    modules: moduleFiles,
    vendor: VENDOR_ASSETS,
  });
  const digests = Object.fromEntries(assets.map((asset) => [asset, hashFile(asset, publicRoot)]));
  const chartManifest = loadChartVendorManifest(publicRoot);
  const chartRelative = 'vendor/chart.umd.js';
  if (digests[chartRelative] !== chartManifest.sha256) {
    throw new Error('browser manifest chart.umd.js digest must match chart-js.manifest.json sha256');
  }
  const version = crypto.createHash('sha256')
    .update(assets.map((asset) => `${asset}:${digests[asset]}`).join('\n'))
    .digest('hex')
    .slice(0, 16);
  return {
    version,
    entrypoints: ['js/app.js', 'js/login.js'].filter((file) => assets.includes(file)),
    stylesheets,
    pages: [...PAGE_ASSETS],
    vendor: [...VENDOR_ASSETS],
    modules: moduleFiles,
    meta: [...META_ASSETS],
    digests,
  };
}

function normalizePublicPath(requestPath) {
  if (typeof requestPath !== 'string' || !requestPath.startsWith('/')) return null;
  const decoded = decodeURIComponent(requestPath.split('?')[0]);
  const trimmed = decoded.replace(/^\/+/, '');
  if (!trimmed || trimmed.includes('\0')) return null;
  const normalized = path.posix.normalize(trimmed);
  if (normalized.startsWith('../') || normalized === '..') return null;
  return normalized;
}

function resolveRegularFileUnderRoot(publicRoot, relativePath) {
  if (!relativePath || relativePath.includes('\\')) return null;
  const segments = relativePath.split('/').filter(Boolean);
  if (segments.some((segment) => segment === '.' || segment === '..')) return null;

  let realRoot;
  try {
    realRoot = fs.realpathSync(publicRoot);
  } catch {
    return null;
  }

  let current = realRoot;
  for (const segment of segments) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch {
      return null;
    }
    if (stat.isSymbolicLink()) return null;
  }

  let stat;
  try {
    stat = fs.lstatSync(current);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;

  let realFile;
  try {
    realFile = fs.realpathSync(current);
  } catch {
    return null;
  }
  if (realFile !== current) return null;
  if (realFile !== realRoot && !realFile.startsWith(`${realRoot}${path.sep}`)) return null;
  return current;
}

function resolvePublicFile(requestPath, publicRoot = PUBLIC_ROOT) {
  const normalized = normalizePublicPath(requestPath);
  if (!normalized) return null;
  const candidate = resolveRegularFileUnderRoot(publicRoot, normalized);
  if (!candidate) return null;
  return { normalized, candidate };
}

function contentTypeFor(normalizedPath) {
  return CONTENT_TYPES[path.extname(normalizedPath).toLowerCase()] || 'application/octet-stream';
}

function cacheControlFor(normalizedPath) {
  if (PAGE_ASSETS.includes(normalizedPath)) return 'no-store';
  if (normalizedPath === MANIFEST_RELATIVE) return 'no-store';
  if (normalizedPath === 'vendor/chart.umd.js') return 'public, max-age=31536000, immutable';
  if (normalizedPath.startsWith('vendor/')) return 'no-store';
  if (normalizedPath.startsWith('js/') || normalizedPath.startsWith('css/')) return 'no-store';
  return 'no-store';
}

function requestPath(req) {
  if (typeof req.path === 'string') return req.path;
  const url = req.url || '/';
  return url.split('?')[0];
}

function expectedManifestAssetPaths(manifest) {
  return inventoryAssetPaths(manifest);
}

function servedAssetPaths(manifest) {
  return [...expectedManifestAssetPaths(manifest), ...META_ASSETS].sort();
}

function loadBrowserAssetInventory(options = {}) {
  const publicRoot = path.resolve(options.publicRoot || PUBLIC_ROOT);
  const manifestPath = path.join(publicRoot, MANIFEST_RELATIVE);
  if (!fs.existsSync(manifestPath)) {
    throw new Error('public/browser-manifest.json is missing');
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const chartManifest = loadChartVendorManifest(publicRoot);
  const assetPaths = expectedManifestAssetPaths(manifest);
  const digestKeys = Object.keys(manifest.digests || {}).sort();
  const servedPaths = servedAssetPaths(manifest);

  if (JSON.stringify(assetPaths) !== JSON.stringify(digestKeys)) {
    throw new Error('browser manifest digests must match the authoritative asset inventory exactly');
  }

  for (const relative of servedPaths) {
    const absolute = path.join(publicRoot, relative);
    if (!fs.existsSync(absolute)) {
      throw new Error(`browser asset is missing: ${relative}`);
    }
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      throw new Error(`symlinked browser asset path: ${relative}`);
    }
    if (!stat.isFile()) {
      throw new Error(`browser asset is not a regular file: ${relative}`);
    }
  }

  const built = buildBrowserManifest(publicRoot);
  if (manifest.version !== built.version) {
    throw new Error(`browser manifest version ${manifest.version} does not match built ${built.version}`);
  }
  if (JSON.stringify(manifest.digests) !== JSON.stringify(built.digests)) {
    throw new Error('browser manifest digests do not match committed asset bytes');
  }
  if (JSON.stringify(manifest.pages) !== JSON.stringify(built.pages)
    || JSON.stringify(manifest.vendor) !== JSON.stringify(built.vendor)
    || JSON.stringify(manifest.modules) !== JSON.stringify(built.modules)
    || JSON.stringify(manifest.stylesheets) !== JSON.stringify(built.stylesheets)) {
    throw new Error('browser manifest inventory lists do not match committed asset bytes');
  }
  if (JSON.stringify([...(manifest.modules || [])].sort()) !== JSON.stringify(built.modules)) {
    throw new Error('browser module files on disk do not match committed manifest modules');
  }

  const chartRelative = 'vendor/chart.umd.js';
  if (manifest.digests[chartRelative] !== chartManifest.sha256) {
    throw new Error('browser manifest chart.umd.js digest must match chart-js.manifest.json sha256');
  }

  const assets = new Map();
  for (const relative of servedPaths) {
    const absolute = resolveRegularFileUnderRoot(publicRoot, relative);
    if (!absolute) {
      throw new Error(`browser asset is missing, non-regular, symlinked, or outside public root: ${relative}`);
    }
    const body = fs.readFileSync(absolute);
    if (relative !== MANIFEST_RELATIVE) {
      const digest = sha256Buffer(body);
      const expected = manifest.digests[relative];
      if (digest !== expected) {
        throw new Error(`browser asset digest mismatch for ${relative}`);
      }
      if (relative === chartRelative && body.length !== chartManifest.size) {
        throw new Error(`browser asset size mismatch for ${relative}`);
      }
    }
    assets.set(relative, Object.freeze({
      body: Buffer.from(body),
      contentType: contentTypeFor(relative),
      cacheControl: cacheControlFor(relative),
      digest: relative === MANIFEST_RELATIVE ? null : sha256Buffer(body),
      size: body.length,
    }));
  }

  return Object.freeze({
    version: manifest.version,
    publicRoot: fs.realpathSync(publicRoot),
    assets,
  });
}

const PUBLIC_BROWSER_PREFIXES = Object.freeze(['js/', 'css/', 'vendor/']);
const PUBLIC_BROWSER_EXACT = Object.freeze([
  MANIFEST_RELATIVE,
  'login.html',
]);

function isPublicBrowserAsset(requestPath) {
  if (typeof requestPath !== 'string') return false;
  const normalized = normalizePublicPath(requestPath);
  if (!normalized) return false;
  if (PUBLIC_BROWSER_EXACT.includes(normalized)) return true;
  return PUBLIC_BROWSER_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function sendBrowserAsset(req, res, inventory, relativePath) {
  const asset = inventory.assets.get(relativePath);
  if (!asset) {
    res.statusCode = 404;
    return res.end('not found');
  }
  res.statusCode = 200;
  res.setHeader('Content-Type', asset.contentType);
  res.setHeader('Cache-Control', asset.cacheControl);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method === 'HEAD') return res.end();
  if (typeof res.send === 'function') return res.send(asset.body);
  return res.end(asset.body);
}

function createBrowserStaticMiddleware(options = {}) {
  const inventory = options.inventory || loadBrowserAssetInventory(options);

  return function browserStatic(req, res, next) {
    if (!['GET', 'HEAD'].includes(req.method)) return next();
    const normalized = normalizePublicPath(requestPath(req));
    if (!normalized || !inventory.assets.has(normalized)) return next();
    return sendBrowserAsset(req, res, inventory, normalized);
  };
}

module.exports = {
  PUBLIC_ROOT,
  PAGE_ASSETS,
  VENDOR_ASSETS,
  PUBLIC_BROWSER_EXACT,
  PUBLIC_BROWSER_PREFIXES,
  buildBrowserManifest,
  cacheControlFor,
  contentTypeFor,
  createBrowserStaticMiddleware,
  expectedManifestAssetPaths,
  inventoryAssetPaths,
  isPublicBrowserAsset,
  listModuleFiles,
  loadBrowserAssetInventory,
  normalizePublicPath,
  resolvePublicFile,
  resolveRegularFileUnderRoot,
  sendBrowserAsset,
  servedAssetPaths,
};
