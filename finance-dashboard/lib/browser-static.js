const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PUBLIC_ROOT = path.resolve(__dirname, '..', 'public');
const MODULE_ROOT = path.join(PUBLIC_ROOT, 'js');

const CONTENT_TYPES = Object.freeze({
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
});

const VENDOR_IMMUTABLE = Object.freeze([
  'vendor/chart.umd.js',
  'vendor/chart-js.manifest.json',
  'vendor/THIRD-PARTY-NOTICES.txt',
]);

function listModuleFiles(relative = '', root = MODULE_ROOT) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) return listModuleFiles(child, absolute);
    if (entry.isFile() && entry.name.endsWith('.js')) return [child];
    return [];
  });
}

function hashFile(relativePath) {
  const absolute = path.join(PUBLIC_ROOT, relativePath);
  return crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
}

function buildBrowserManifest() {
  const moduleFiles = listModuleFiles().sort().map((file) => `js/${file}`);
  const stylesheets = ['css/dashboard.css', 'css/login.css'].filter((file) => fs.existsSync(path.join(PUBLIC_ROOT, file)));
  const entrypoints = ['js/app.js', 'js/login.js'].filter((file) => fs.existsSync(path.join(PUBLIC_ROOT, file)));
  const assets = [...entrypoints, ...stylesheets, ...moduleFiles].sort();
  const digests = Object.fromEntries(assets.map((asset) => [asset, hashFile(asset)]));
  const version = crypto.createHash('sha256')
    .update(assets.map((asset) => `${asset}:${digests[asset]}`).join('\n'))
    .digest('hex')
    .slice(0, 16);
  return {
    version,
    entrypoints,
    stylesheets,
    modules: moduleFiles,
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

function resolvePublicFile(requestPath) {
  const normalized = normalizePublicPath(requestPath);
  if (!normalized) return null;
  const candidate = path.resolve(PUBLIC_ROOT, normalized);
  const relative = path.relative(PUBLIC_ROOT, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) return null;
  return { normalized, candidate };
}

function contentTypeFor(normalizedPath) {
  return CONTENT_TYPES[path.extname(normalizedPath).toLowerCase()] || 'application/octet-stream';
}

function cacheControlFor(normalizedPath) {
  if (normalizedPath === 'index.html' || normalizedPath === 'login.html') {
    return 'no-store';
  }
  if (VENDOR_IMMUTABLE.includes(normalizedPath)) {
    return 'public, max-age=31536000, immutable';
  }
  if (normalizedPath.startsWith('js/') || normalizedPath.startsWith('css/')) {
    return 'no-store';
  }
  return 'no-store';
}

function requestPath(req) {
  if (typeof req.path === 'string') return req.path;
  const url = req.url || '/';
  return url.split('?')[0];
}

function isPublicBrowserAsset(requestPath) {
  if (typeof requestPath !== 'string') return false;
  return requestPath.startsWith('/js/')
    || requestPath.startsWith('/css/')
    || requestPath.startsWith('/vendor/')
    || requestPath === '/browser-manifest.json';
}

function createBrowserStaticMiddleware(options = {}) {
  const publicRoot = options.publicRoot || PUBLIC_ROOT;
  const readFile = options.readFile || fs.readFileSync;

  return function browserStatic(req, res, next) {
    if (!['GET', 'HEAD'].includes(req.method)) return next();
    const resolved = resolvePublicFile(requestPath(req));
    if (!resolved) return next();
    const body = readFile(resolved.candidate);
    res.statusCode = 200;
    if (typeof res.setHeader === 'function') {
      res.setHeader('Content-Type', contentTypeFor(resolved.normalized));
      res.setHeader('Cache-Control', cacheControlFor(resolved.normalized));
      res.setHeader('X-Content-Type-Options', 'nosniff');
    }
    if (req.method === 'HEAD') return res.end();
    if (typeof res.send === 'function') return res.send(body);
    return res.end(body);
  };
}

module.exports = {
  PUBLIC_ROOT,
  buildBrowserManifest,
  cacheControlFor,
  contentTypeFor,
  createBrowserStaticMiddleware,
  isPublicBrowserAsset,
  listModuleFiles,
  normalizePublicPath,
  resolvePublicFile,
};
