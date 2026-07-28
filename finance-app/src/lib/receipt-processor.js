'use strict';

const {
  assertBoundedBase64Payload,
  readBoundedFileBase64,
} = require('./receipt-bounded-fallback');

function parseOcr(lines) {
  const text = lines.join('\n');
  const grab = (s) => {
    const re = /(?:\$\s?)?(\d{1,5}[.,]\d{2})\b/g;
    const out = [];
    let m;
    while ((m = re.exec(s))) out.push(parseFloat(m[1].replace(',', '.')));
    return out;
  };
  let amount = null;
  const totalLine = lines.find((l) => /\b(grand\s*total|total|amount due|balance due)\b/i.test(l) && /\d/.test(l));
  if (totalLine) {
    const v = grab(totalLine);
    if (v.length) amount = Math.max(...v);
  }
  if (amount == null) {
    const all = grab(text);
    if (all.length) amount = Math.max(...all);
  }

  let date = null;
  const iso = text.match(/\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/);
  const us = text.match(/\b(\d{1,2})[-/.](\d{1,2})[-/.](20\d{2})\b/);
  if (iso) date = `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;
  else if (us) date = `${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`;

  return { amount, date };
}

async function processReceiptAsset(asset, source, deps) {
  const ocrLines = deps.extractOcrLines ? await deps.extractOcrLines(asset.uri) : [];
  const { amount, date } = parseOcr(ocrLines);
  const longest = Math.max(asset.width || 0, asset.height || 0);
  const resize = longest > 2200
    ? asset.width >= asset.height
      ? { width: 2200 }
      : { height: 2200 }
    : undefined;
  let processed;
  try {
    processed = await deps.manipulateAsset(asset.uri, resize);
  } catch {
    processed = {
      uri: asset.uri,
      base64: await readBoundedFileBase64(asset.uri, deps.fileSystem),
    };
  }
  if (!processed.base64) throw new Error('Could not encode receipt image.');
  assertBoundedBase64Payload(processed.base64);
  const fallbackMime = String(asset.mimeType || '').toLowerCase();
  const mime = processed.uri === asset.uri && ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'].includes(fallbackMime)
    ? fallbackMime
    : 'image/jpeg';
  return {
    uri: processed.uri,
    base64: processed.base64,
    mime,
    ocrText: ocrLines.join('\n'),
    ocrLines,
    amount,
    date,
    source,
  };
}

module.exports = {
  parseOcr,
  processReceiptAsset,
};
