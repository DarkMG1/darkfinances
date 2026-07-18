const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { ASSET_PATH, verifyChartJsAsset } = require('../scripts/chart-js-vendor');

const dashboardRoot = path.resolve(__dirname, '..');
const indexHtml = fs.readFileSync(path.join(dashboardRoot, 'public', 'index.html'), 'utf8');
const serverSource = fs.readFileSync(path.join(dashboardRoot, 'server.js'), 'utf8');
const script = indexHtml.match(/<script>([\s\S]*)<\/script>/)?.[1] || '';
const externalScriptPattern = /<script[^>]+src=["']https?:\/\//i;
const cdnScriptPattern = /cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|unpkg\.com/i;
const cspDirectivePattern = /Content-Security-Policy[\s\S]*?script-src[^;]+;/;

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

test('authenticated dashboard HTML must not load third-party JavaScript CDNs', () => {
  assert.doesNotMatch(indexHtml, externalScriptPattern, 'index.html must not reference external script URLs');
  assert.doesNotMatch(indexHtml, cdnScriptPattern, 'index.html must not reference known JavaScript CDNs');
});

test('dashboard CSP must not allow third-party script hosts', () => {
  const cspMatch = serverSource.match(cspDirectivePattern);
  assert.ok(cspMatch, 'server.js must define a Content-Security-Policy script-src directive');
  const scriptSrc = cspMatch[0];
  assert.doesNotMatch(scriptSrc, cdnScriptPattern, 'script-src must not whitelist JavaScript CDNs');
  assert.doesNotMatch(scriptSrc, /https:\/\/[^'"\s]+/, 'script-src must not whitelist external script hosts');
  assert.match(scriptSrc, /script-src 'self' 'unsafe-inline'/);
  assert.doesNotMatch(scriptSrc, /unsafe-eval/);
});

test('browser dashboard loads a pinned local Chart.js asset', () => {
  const manifest = verifyChartJsAsset();
  assert.equal(manifest.package, 'chart.js');
  assert.equal(manifest.version, '4.4.0');
  assert.equal(manifest.assetPath, 'public/vendor/chart.umd.js');
  assert.match(indexHtml, /<script src="\/vendor\/chart\.umd\.js"><\/script>/);
  assert.match(fs.readFileSync(path.join(dashboardRoot, 'public', 'vendor', 'THIRD-PARTY-NOTICES.txt'), 'utf8'), /chart\.js 4\.4\.0 \(MIT\)/);
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

test('browser dashboard script parses and does not shadow the escaping helper', () => {
  assert.ok(script);
  assert.doesNotThrow(() => new vm.Script(script));
  assert.doesNotMatch(script, /\blet html\s*=/);
  assert.match(script, /const html = \(s\) =>/);
});

test('browser dashboard has a forced synthetic-data route', () => {
  assert.match(script, /location\.pathname === '\/demo'/);
  assert.match(script, /demoOnlyPage \|\|/);
});

test('browser trends chart does not coerce incomplete months to zero spend/income', () => {
  assert.match(script, /monthTrendComplete/);
  assert.match(script, /m\.income != null \? m\.income : null/);
  assert.doesNotMatch(script, /m\.income \?\? 0/);
  assert.doesNotMatch(script, /m\.spend \?\? 0/);
});

test('renderSafeToSpend surfaces authoritative incompleteReasons when unavailable', () => {
  const fnMatch = script.match(/function renderSafeToSpend\([\s\S]*?\n {4}\}/);
  assert.ok(fnMatch, 'renderSafeToSpend should exist in dashboard script');

  const dom = {
    safeToSpendValue: { textContent: '', style: {} },
    safeToSpendDetail: { textContent: '' },
    safeToSpendReasons: { innerHTML: '', hidden: false },
    safeToSpendReserved: { innerHTML: '' },
  };
  const document = {
    getElementById: (id) => ({
      safeToSpendValue: dom.safeToSpendValue,
      safeToSpendDetail: dom.safeToSpendDetail,
      safeToSpendReasons: dom.safeToSpendReasons,
      safeToSpendReserved: dom.safeToSpendReserved,
    }[id] || null),
  };
  const fmt = (value) => `$${value}`;
  const html = (value) => String(value == null ? '' : value);

  vm.runInNewContext(
    `${fnMatch[0]}\nrenderSafeToSpend({ complete: false, value: null, incompleteReasons: ['budget_data_unavailable', 'goal_commitment_unknown'] });`,
    { document, fmt, html },
  );

  assert.equal(dom.safeToSpendValue.textContent, 'Unavailable');
  assert.match(dom.safeToSpendReasons.innerHTML, /budget_data_unavailable/);
  assert.match(dom.safeToSpendReasons.innerHTML, /goal_commitment_unknown/);
  assert.equal(dom.safeToSpendReasons.hidden, false);
});
