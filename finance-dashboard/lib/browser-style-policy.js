const fs = require('fs');
const path = require('path');
const { listModuleFiles, PUBLIC_ROOT } = require('./browser-static');

const INLINE_STYLE_ATTR = /\bstyle\s*=/i;
const CSSOM_STYLE_ASSIGN = /\.style\s*\./;

const PUBLIC_HTML = Object.freeze([
  'index.html',
  'login.html',
]);

function browserJsPaths() {
  return listModuleFiles().map((file) => path.join(PUBLIC_ROOT, 'js', file));
}

function scanSources(sources) {
  const violations = [];
  for (const { file, source } of sources) {
    const lines = source.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (INLINE_STYLE_ATTR.test(line)) {
        violations.push({ file, line: i + 1, kind: 'style-attribute', excerpt: line.trim().slice(0, 120) });
      }
      if (CSSOM_STYLE_ASSIGN.test(line)) {
        violations.push({ file, line: i + 1, kind: 'cssom-style', excerpt: line.trim().slice(0, 120) });
      }
    }
  }
  return violations;
}

function collectBrowserStyleSources() {
  const sources = PUBLIC_HTML.map((name) => ({
    file: `public/${name}`,
    source: fs.readFileSync(path.join(PUBLIC_ROOT, name), 'utf8'),
  }));
  for (const file of browserJsPaths()) {
    sources.push({
      file: path.relative(path.join(PUBLIC_ROOT, '..'), file).split(path.sep).join('/'),
      source: fs.readFileSync(file, 'utf8'),
    });
  }
  return sources;
}

function verifyNoInlineBrowserStyles() {
  const violations = scanSources(collectBrowserStyleSources());
  if (violations.length) {
    const detail = violations.map((v) => `${v.file}:${v.line} [${v.kind}] ${v.excerpt}`).join('\n');
    throw new Error(`browser assets must not use inline style attributes or CSSOM style assignment:\n${detail}`);
  }
}

module.exports = {
  INLINE_STYLE_ATTR,
  CSSOM_STYLE_ASSIGN,
  collectBrowserStyleSources,
  scanSources,
  verifyNoInlineBrowserStyles,
};
