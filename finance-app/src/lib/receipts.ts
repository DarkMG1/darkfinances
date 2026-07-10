import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { extractTextFromImage, isSupported } from 'expo-text-extractor';

// On-device receipt capture + OCR. iOS runs Apple Vision (via expo-text-extractor).
// Before upload, photos are resized and transcoded to bounded JPEGs so a modern
// phone camera cannot create a 25 MB JSON payload or exhaust app memory.
export const ocrSupported = isSupported;

export interface CapturedReceipt {
  uri: string; // local file uri from the picker (cache)
  base64: string; // raw bytes for the server upload
  mime: string;
  ocrText: string;
  ocrLines: string[];
  amount: number | null; // best-guess total
  date: string | null; // best-guess date (YYYY-MM-DD)
  source: 'camera' | 'library';
}

const DIR = (FileSystem.documentDirectory ?? '') + 'receipts/';
export async function purgeLegacyReceiptCopies() {
  try {
    await FileSystem.deleteAsync(DIR, { idempotent: true });
  } catch {
    /* best effort */
  }
}

// Pull a likely total + date out of the OCR lines. Heuristic, best-effort — the
// user can always correct on the transaction. Amount prefers a line that mentions
// "total"; otherwise the largest currency-looking number on the receipt.
function parseOcr(lines: string[]): { amount: number | null; date: string | null } {
  const text = lines.join('\n');
  const grab = (s: string): number[] => {
    const re = /(?:\$\s?)?(\d{1,5}[.,]\d{2})\b/g;
    const out: number[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(s))) out.push(parseFloat(m[1].replace(',', '.')));
    return out;
  };
  let amount: number | null = null;
  const totalLine = lines.find((l) => /\b(grand\s*total|total|amount due|balance due)\b/i.test(l) && /\d/.test(l));
  if (totalLine) {
    const v = grab(totalLine);
    if (v.length) amount = Math.max(...v);
  }
  if (amount == null) {
    const all = grab(text);
    if (all.length) amount = Math.max(...all);
  }

  let date: string | null = null;
  const iso = text.match(/\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/);
  const us = text.match(/\b(\d{1,2})[-/.](\d{1,2})[-/.](20\d{2})\b/);
  if (iso) date = `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;
  else if (us) date = `${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`;

  return { amount, date };
}

async function processAsset(asset: ImagePicker.ImagePickerAsset, source: 'camera' | 'library'): Promise<CapturedReceipt> {
  let ocrLines: string[] = [];
  try {
    if (isSupported) ocrLines = await extractTextFromImage(asset.uri);
  } catch {
    ocrLines = [];
  }
  const { amount, date } = parseOcr(ocrLines);
  const longest = Math.max(asset.width || 0, asset.height || 0);
  const resize = longest > 2200
    ? asset.width >= asset.height
      ? { width: 2200 }
      : { height: 2200 }
    : undefined;
  let processed: { uri: string; base64?: string };
  try {
    // Dynamic loading keeps the 1.1 OTA bridge safe on binaries built before
    // ExpoImageManipulator existed; 1.2+ uses the bounded native path.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const manipulator = require('expo-image-manipulator') as typeof import('expo-image-manipulator');
    processed = await manipulator.manipulateAsync(
      asset.uri,
      resize ? [{ resize }] : [],
      { base64: true, compress: 0.72, format: manipulator.SaveFormat.JPEG },
    );
  } catch {
    processed = {
      uri: asset.uri,
      base64: await FileSystem.readAsStringAsync(asset.uri, { encoding: FileSystem.EncodingType.Base64 }),
    };
  }
  if (!processed.base64) throw new Error('Could not encode receipt image.');
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

export async function scanReceiptFromCamera(): Promise<CapturedReceipt | null> {
  const perm = await ImagePicker.requestCameraPermissionsAsync();
  if (!perm.granted) throw new Error('Camera access is off — enable it in iOS Settings.');
  const res = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 1, base64: false, exif: false });
  if (res.canceled || !res.assets?.length) return null;
  return processAsset(res.assets[0], 'camera');
}

export async function pickReceiptFromLibrary(): Promise<CapturedReceipt | null> {
  const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1, base64: false, exif: false });
  if (res.canceled || !res.assets?.length) return null;
  return processAsset(res.assets[0], 'library');
}
