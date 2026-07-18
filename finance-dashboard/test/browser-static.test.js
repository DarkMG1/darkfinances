const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const http = require('http');
const { ASSET_PATH, verifyChartJsAsset } = require('../scripts/chart-js-vendor');
const {
  buildBrowserManifest,
  cacheControlFor,
  contentTypeFor,
  createBrowserStaticMiddleware,
  expectedManifestAssetPaths,
  isPublicBrowserAsset,
  listModuleFiles,
  loadBrowserAssetInventory,
  normalizePublicPath,
  resolvePublicFile,
  servedAssetPaths,
} = require('../lib/browser-static');
const { DASHBOARD_RUNTIME_FILES } = require('../lib/release-files');
const { verifyNoInlineBrowserStyles } = require('../lib/browser-style-policy');

const dashboardRoot = path.resolve(__dirname, '..');
const publicRoot = path.join(dashboardRoot, 'public');
const indexHtml = fs.readFileSync(path.join(publicRoot, 'index.html'), 'utf8');
const serverSource = fs.readFileSync(path.join(dashboardRoot, 'server.js'), 'utf8');
const manifestPath = path.join(publicRoot, 'browser-manifest.json');

const BASELINE_INDEX_BYTES = 68051;
const INDEX_BUDGET_BYTES = 12000;
const INLINE_SCRIPT_PATTERN = /<script(?![^>]*\ssrc=)[^>]*>[\s\S]*?<\/script>/i;
const INLINE_STYLE_PATTERN = /<style[\s\S]*?<\/style>/i;
const INLINE_HANDLER_PATTERN = /\son[a-z]+\s*=/i;
const EXTERNAL_ASSET_PATTERN = /(?:href|src)=["']https?:\/\//i;
const cdnScriptPattern = /cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|unpkg\.com|fonts\.googleapis\.com/i;
const cspDirectivePattern = /Content-Security-Policy[\s\S]*?script-src[^;]+;/;

function readBrowserSources() {
  const modulePaths = listModuleFiles().map((file) => path.join(publicRoot, 'js', file));
  const sources = modulePaths.map((file) => fs.readFileSync(file, 'utf8'));
  sources.push(fs.readFileSync(path.join(publicRoot, 'css', 'dashboard.css'), 'utf8'));
  return { modulePaths, sources: sources.join('\n') };
}

function loadChartRuntime() {
  verifyChartJsAsset();
  const chartSource = fs.readFileSync(ASSET_PATH, 'utf8');
  const sandbox = {
    module: { exports: {} },
    exports: {},
    devicePixelRatio: 1,
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  vm.runInNewContext(chartSource, sandbox, { filename: ASSET_PATH });
  return sandbox.Chart || sandbox.module.exports;
}

function mockCanvas() {
  const measureText = () => ({
    width: 10,
    actualBoundingBoxLeft: 0,
    actualBoundingBoxRight: 10,
    actualBoundingBoxAscent: 8,
    actualBoundingBoxDescent: 2,
  });
  const context = new Proxy(
    { canvas: { width: 400, height: 200 }, font: '10px sans-serif' },
    {
      get(target, property) {
        if (property in target) return target[property];
        if (property === 'fillStyle' || property === 'strokeStyle') return '#000';
        if (property === 'measureText') return measureText;
        return () => {};
      },
    },
  );
  return { getContext: () => context, width: 400, height: 200, style: {} };
}

function parseModuleGraph(entrySource, entryPath) {
  const graph = new Map();
  const queue = [{ source: entrySource, file: entryPath }];
  while (queue.length) {
    const { source, file } = queue.shift();
    if (graph.has(file)) continue;
    graph.set(file, []);
    for (const match of source.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      const spec = match[1];
      if (!spec.startsWith('.')) throw new Error(`non-relative import in ${file}: ${spec}`);
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), spec));
      graph.get(file).push(resolved);
      const absolute = path.join(publicRoot, resolved);
      assert.equal(fs.existsSync(absolute), true, `missing module ${resolved} imported by ${file}`);
      queue.push({ source: fs.readFileSync(absolute, 'utf8'), file: resolved });
    }
  }
  return graph;
}

function startStaticServer(inventory) {
  const middleware = createBrowserStaticMiddleware({ inventory });
  const server = http.createServer((req, res) => {
    middleware(req, res, () => {
      res.statusCode = 404;
      res.end('not found');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function request(server, urlPath, method = 'GET') {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: urlPath, method }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('browser dashboard index.html stays within the size budget and drops inline assets', () => {
  const bytes = Buffer.byteLength(indexHtml, 'utf8');
  assert.ok(bytes < INDEX_BUDGET_BYTES, `index.html is ${bytes} bytes; budget is ${INDEX_BUDGET_BYTES}`);
  assert.ok(bytes < BASELINE_INDEX_BYTES * 0.25, `index.html should be substantially smaller than ${BASELINE_INDEX_BYTES} byte baseline`);
  assert.doesNotMatch(indexHtml, INLINE_SCRIPT_PATTERN);
  assert.doesNotMatch(indexHtml, INLINE_STYLE_PATTERN);
  assert.doesNotMatch(indexHtml, INLINE_HANDLER_PATTERN);
  assert.doesNotMatch(indexHtml, /\bstyle\s*=/i);
  assert.doesNotMatch(indexHtml, EXTERNAL_ASSET_PATTERN);
  assert.doesNotMatch(indexHtml, cdnScriptPattern);
  assert.match(indexHtml, /<link rel="stylesheet" href="\/css\/dashboard\.css"/);
  assert.match(indexHtml, /<script src="\/vendor\/chart\.umd\.js"><\/script>/);
  assert.match(indexHtml, /<script type="module" src="\/js\/app\.js"><\/script>/);
  assert.match(indexHtml, /<noscript>/);
  assert.match(indexHtml, /id="loadMoreBtn"[^>]*hidden/);
  assert.match(indexHtml, /id="goalDeleteBtn"[^>]*hidden/);
});

test('browser style policy gate forbids inline style attributes across public HTML and JS', () => {
  assert.doesNotThrow(() => verifyNoInlineBrowserStyles());
});

test('dashboard CSP rejects inline script/style and third-party hosts', () => {
  const cspMatch = serverSource.match(cspDirectivePattern);
  assert.ok(cspMatch, 'server.js must define a Content-Security-Policy script-src directive');
  const policy = cspMatch[0];
  assert.doesNotMatch(policy, cdnScriptPattern);
  assert.doesNotMatch(policy, /https:\/\/[^'"\s]+/);
  assert.match(policy, /script-src 'self'/);
  assert.match(serverSource, /style-src 'self'/);
  assert.doesNotMatch(serverSource, /unsafe-inline/);
  assert.doesNotMatch(serverSource, /unsafe-eval/);
});

test('browser dashboard loads a pinned local Chart.js asset before modules', () => {
  const manifest = verifyChartJsAsset();
  assert.equal(manifest.package, 'chart.js');
  assert.equal(manifest.version, '4.4.0');
  assert.equal(manifest.assetPath, 'public/vendor/chart.umd.js');
  assert.match(fs.readFileSync(path.join(publicRoot, 'vendor', 'THIRD-PARTY-NOTICES.txt'), 'utf8'), /chart\.js 4\.4\.0 \(MIT\)/);
  assert.doesNotMatch(fs.readFileSync(ASSET_PATH, 'utf8'), /sourceMappingURL/);
  const chartTag = indexHtml.indexOf('<script src="/vendor/chart.umd.js"></script>');
  const moduleTag = indexHtml.indexOf('<script type="module" src="/js/app.js"></script>');
  assert.ok(chartTag >= 0 && moduleTag > chartTag, 'Chart.js vendor must load before the module entry');
});

test('browser modules form a closed relative import graph from app.js', () => {
  const entry = fs.readFileSync(path.join(publicRoot, 'js', 'app.js'), 'utf8');
  const graph = parseModuleGraph(entry, 'js/app.js');
  assert.ok(graph.size >= 10, 'expected a multi-module browser graph');
  for (const [file, imports] of graph) {
    assert.match(file, /^js\//, file);
    for (const dep of imports) {
      assert.match(dep, /^js\//, `${file} -> ${dep}`);
      assert.ok(dep.endsWith('.js'), dep);
    }
  }
});

test('browser modules preserve escaping, demo route, and Safe-to-Spend guards', () => {
  const { sources } = readBrowserSources();
  assert.doesNotMatch(sources, /\blet html\s*=/);
  assert.match(sources, /const html = \(s\) =>/);
  assert.match(sources, /location\.pathname === '\/demo'/);
  assert.match(sources, /demoOnlyPage \|\|/);
  assert.match(sources, /metric\?\.complete === true && Number\.isFinite\(metric\.value\)/);
  assert.match(sources, /available \? fmt\(metric\.value\) : 'Unavailable'/);
  assert.match(sources, /if \(!d\) return 'date uncertain'/);
  assert.match(sources, /if \(!d\) return null/);
  assert.doesNotMatch(sources, /const dueLabel = \(d\) => \{ const n = daysUntil\(d\)/);
});

test('browser dependency boundaries keep render modules from importing app.js', () => {
  for (const file of listModuleFiles()) {
    const source = fs.readFileSync(path.join(publicRoot, 'js', file), 'utf8');
    if (file === 'app.js') continue;
    assert.doesNotMatch(source, /from ['"]\.\/app\.js['"]/, file);
    assert.doesNotMatch(source, /from ['"]\.\.\/app\.js['"]/, file);
  }
});

test('browser manifest matches committed module digests and authoritative inventory', () => {
  const built = buildBrowserManifest();
  const committed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const chartManifest = JSON.parse(fs.readFileSync(path.join(publicRoot, 'vendor', 'chart-js.manifest.json'), 'utf8'));
  assert.deepEqual(committed.modules.sort(), built.modules.sort());
  assert.deepEqual(committed.pages, built.pages);
  assert.deepEqual(committed.vendor, built.vendor);
  assert.deepEqual(committed.meta, built.meta);
  assert.equal(committed.version, built.version);
  assert.deepEqual(committed.digests, built.digests);
  assert.deepEqual(Object.keys(committed.digests).sort(), expectedManifestAssetPaths(committed));
  assert.equal(committed.digests['vendor/chart.umd.js'], chartManifest.sha256);
  for (const relative of expectedManifestAssetPaths(committed)) {
    assert.equal(DASHBOARD_RUNTIME_FILES.includes(`public/${relative}`), true, relative);
  }
  assert.equal(DASHBOARD_RUNTIME_FILES.includes('public/browser-manifest.json'), true);
});

test('browser asset inventory loads immutable verified bytes at startup', () => {
  const inventory = loadBrowserAssetInventory({ publicRoot });
  assert.equal(inventory.assets.size, servedAssetPaths(JSON.parse(fs.readFileSync(manifestPath, 'utf8'))).length);
  const app = inventory.assets.get('js/app.js');
  assert.ok(Buffer.isBuffer(app.body));
  assert.equal(app.body.toString('utf8'), fs.readFileSync(path.join(publicRoot, 'js/app.js'), 'utf8'));
});

test('browser asset inventory rejects tampered, missing, and symlinked assets at startup', () => {
  const tmpRoot = fs.mkdtempSync(path.join(require('os').tmpdir(), 'df-browser-'));
  try {
    fs.cpSync(publicRoot, tmpRoot, { recursive: true });
    assert.doesNotThrow(() => loadBrowserAssetInventory({ publicRoot: tmpRoot }));

    fs.writeFileSync(path.join(tmpRoot, 'js/app.js'), 'console.log("tampered");\n');
    assert.throws(
      () => loadBrowserAssetInventory({ publicRoot: tmpRoot }),
      /digest mismatch for js\/app\.js|does not match built/,
    );

    fs.cpSync(publicRoot, tmpRoot, { recursive: true, force: true });
    fs.unlinkSync(path.join(tmpRoot, 'css/dashboard.css'));
    assert.throws(
      () => loadBrowserAssetInventory({ publicRoot: tmpRoot }),
      /browser asset is missing: css\/dashboard\.css/,
    );

    fs.cpSync(publicRoot, tmpRoot, { recursive: true, force: true });
    fs.writeFileSync(path.join(tmpRoot, 'js/extra-module.js'), 'export {};\n');
    const manifest = JSON.parse(fs.readFileSync(path.join(tmpRoot, 'browser-manifest.json'), 'utf8'));
    manifest.modules = [...manifest.modules, 'js/extra-module.js'].sort();
    manifest.digests['js/extra-module.js'] = require('crypto')
      .createHash('sha256')
      .update(fs.readFileSync(path.join(tmpRoot, 'js/extra-module.js')))
      .digest('hex');
    fs.writeFileSync(path.join(tmpRoot, 'browser-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    assert.throws(
      () => loadBrowserAssetInventory({ publicRoot: tmpRoot }),
      /digests do not match committed asset bytes|does not match built/,
    );

    fs.cpSync(publicRoot, tmpRoot, { recursive: true, force: true });
    fs.rmSync(path.join(tmpRoot, 'js/extra-module.js'), { force: true });
    fs.unlinkSync(path.join(tmpRoot, 'js/app.js'));
    fs.symlinkSync(path.join(publicRoot, 'js/app.js'), path.join(tmpRoot, 'js/app.js'));
    assert.throws(
      () => loadBrowserAssetInventory({ publicRoot: tmpRoot }),
      /symlinked browser asset path: js\/app\.js/,
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('browser static middleware serves verified immutable bytes after on-disk tampering', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(require('os').tmpdir(), 'df-browser-serve-'));
  try {
    fs.cpSync(publicRoot, tmpRoot, { recursive: true });
    const inventory = loadBrowserAssetInventory({ publicRoot: tmpRoot });
    const verified = inventory.assets.get('js/app.js').body.toString('utf8');
    const server = await startStaticServer(inventory);
    try {
      const before = await request(server, '/js/app.js');
      assert.equal(before.status, 200);
      assert.equal(before.body, verified);

      fs.writeFileSync(path.join(tmpRoot, 'js/app.js'), 'console.log("post-start tamper");\n');
      const after = await request(server, '/js/app.js');
      assert.equal(after.status, 200);
      assert.equal(after.body, verified);
      assert.notEqual(after.body, fs.readFileSync(path.join(tmpRoot, 'js/app.js'), 'utf8'));
    } finally {
      await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('isPublicBrowserAsset uses explicit prefix allowlist, not inventory membership', () => {
  assert.equal(isPublicBrowserAsset('/index.html'), false);
  assert.equal(isPublicBrowserAsset('/login.html'), true);
  assert.equal(isPublicBrowserAsset('/login'), false);
  assert.equal(isPublicBrowserAsset('/login/extra'), false);
  assert.equal(isPublicBrowserAsset('/js/app.js'), true);
  assert.equal(isPublicBrowserAsset('/css/dashboard.css'), true);
  assert.equal(isPublicBrowserAsset('/css/login.css'), true);
  assert.equal(isPublicBrowserAsset('/vendor/chart.umd.js'), true);
  assert.equal(isPublicBrowserAsset('/vendor/chart-js.manifest.json'), true);
  assert.equal(isPublicBrowserAsset('/browser-manifest.json'), true);
  assert.equal(isPublicBrowserAsset('/demo'), false);
  assert.equal(isPublicBrowserAsset('/'), false);
  assert.equal(isPublicBrowserAsset('/js/../index.html'), false);
});

test('browser static middleware blocks traversal and serves typed assets with cache policy', async () => {
  assert.equal(normalizePublicPath('/../server.js'), null);
  assert.equal(resolvePublicFile('/js/../../server.js'), null);
  assert.equal(contentTypeFor('js/app.js'), 'text/javascript; charset=utf-8');
  assert.equal(contentTypeFor('css/dashboard.css'), 'text/css; charset=utf-8');
  assert.equal(cacheControlFor('index.html'), 'no-store');
  assert.equal(cacheControlFor('login.html'), 'no-store');
  assert.equal(cacheControlFor('js/app.js'), 'no-store');
  assert.match(cacheControlFor('vendor/chart.umd.js'), /immutable/);
  assert.equal(cacheControlFor('vendor/chart-js.manifest.json'), 'no-store');

  const inventory = loadBrowserAssetInventory({ publicRoot });
  const server = await startStaticServer(inventory);
  try {
    const ok = await request(server, '/js/app.js');
    assert.equal(ok.status, 200);
    assert.match(ok.headers['content-type'], /javascript/);
    assert.equal(ok.headers['cache-control'], 'no-store');
    assert.equal(ok.headers['x-content-type-options'], 'nosniff');

    const css = await request(server, '/css/dashboard.css');
    assert.equal(css.status, 200);
    assert.match(css.headers['content-type'], /text\/css/);
    assert.equal(css.headers['cache-control'], 'no-store');

    const page = await request(server, '/index.html');
    assert.equal(page.status, 200);
    assert.equal(page.headers['cache-control'], 'no-store');
    assert.equal(page.headers['x-content-type-options'], 'nosniff');

    const missing = await request(server, '/js/not-a-module.js');
    assert.equal(missing.status, 404);

    const traversal = await request(server, '/js/%2e%2e/server.js');
    assert.equal(traversal.status, 404);

    const encoded = await request(server, '/js/%2e%2e%2f%2e%2e/public/index.html');
    assert.equal(encoded.status, 404);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test('pinned Chart.js bundle supports dashboard chart types', () => {
  const Chart = loadChartRuntime();
  assert.equal(typeof Chart, 'function');
  assert.equal(typeof Chart.register, 'function');
  const canvas = mockCanvas();

  for (const type of ['doughnut', 'line', 'bar']) {
    const chart = new Chart(canvas, {
      type,
      data: { labels: ['A'], datasets: [{ data: [1] }] },
      options: { animation: false, responsive: false, plugins: { legend: { display: false } } },
    });
    chart.update('none');
    chart.destroy();
  }
});

test('pinned Chart.js bundle supports the dashboard income/spending/net mixed chart', () => {
  const Chart = loadChartRuntime();
  const canvas = mockCanvas();
  const labels = ['Jan', 'Feb'];
  const inc = [100, 120];
  const spd = [80, 90];
  const net = inc.map((value, index) => value - spd[index]);

  const chart = new Chart(canvas, {
    data: {
      labels,
      datasets: [
        { type: 'bar', label: 'Income', data: inc, backgroundColor: 'rgba(34,197,94,0.7)', borderRadius: 3, order: 3 },
        { type: 'bar', label: 'Spending', data: spd, backgroundColor: 'rgba(239,68,68,0.65)', borderRadius: 3, order: 2 },
        {
          type: 'line',
          label: 'Net',
          data: net,
          borderColor: '#a898ff',
          backgroundColor: '#a898ff',
          borderWidth: 2,
          tension: 0.3,
          pointRadius: 2,
          pointHoverRadius: 4,
          order: 1,
        },
      ],
    },
    options: {
      animation: false,
      responsive: false,
      maintainAspectRatio: false,
      plugins: { legend: { labels: { color: '#6b6b80', font: { size: 10 }, boxWidth: 10 } } },
      scales: {
        x: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#6b6b80', font: { size: 10 } } },
        y: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#6b6b80', font: { size: 10 } } },
      },
    },
  });
  chart.update('none');
  chart.destroy();
});

test('browser dashboard module entry exposes deterministic bootstrap error handling', () => {
  const entry = fs.readFileSync(path.join(publicRoot, 'js', 'app.js'), 'utf8');
  assert.match(entry, /init\(\)\.catch\(showBootstrapError\)/);
  assert.match(entry, /installDemoFetch\(\)/);
  assert.match(entry, /registerAfterFilterChange\(renderTxns\)/);
});

test('browser dashboard smoke parses module sources without eval or dynamic codegen', () => {
  const { spawnSync } = require('node:child_process');
  const { modulePaths } = readBrowserSources();
  for (const file of modulePaths) {
    const source = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /\beval\s*\(/, file);
    assert.doesNotMatch(source, /new Function\s*\(/, file);
    const check = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    assert.equal(check.status, 0, `${file}: ${check.stderr || check.stdout}`);
  }
});
