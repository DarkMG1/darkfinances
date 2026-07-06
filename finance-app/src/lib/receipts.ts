import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { extractTextFromImage, isSupported } from 'expo-text-extractor';

// On-device receipt capture + OCR. iOS runs Apple Vision (via expo-text-extractor),
// so text never leaves the phone. The raw image is copied into the app's document
// dir (survives cache eviction) and also uploaded to the server for durability.
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
const localPath = (id: string) => `${DIR}${id}.jpg`;

async function ensureDir() {
  const info = await FileSystem.getInfoAsync(DIR);
  if (!info.exists) await FileSystem.makeDirectoryAsync(DIR, { intermediates: true });
}

// Persist a local copy keyed by the server-assigned receipt id.
export async function saveReceiptLocal(sourceUri: string, id: string): Promise<string | null> {
  try {
    await ensureDir();
    const dest = localPath(id);
    await FileSystem.copyAsync({ from: sourceUri, to: dest });
    return dest;
  } catch {
    return null;
  }
}
export async function localReceiptUri(id: string): Promise<string | null> {
  try {
    const info = await FileSystem.getInfoAsync(localPath(id));
    return info.exists ? localPath(id) : null;
  } catch {
    return null;
  }
}
export async function deleteReceiptLocal(id: string) {
  try {
    await FileSystem.deleteAsync(localPath(id), { idempotent: true });
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
  return {
    uri: asset.uri,
    base64: asset.base64 ?? '',
    mime: 'image/jpeg',
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
  const res = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.6, base64: true, exif: false });
  if (res.canceled || !res.assets?.length) return null;
  return processAsset(res.assets[0], 'camera');
}

export async function pickReceiptFromLibrary(): Promise<CapturedReceipt | null> {
  const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.6, base64: true, exif: false });
  if (res.canceled || !res.assets?.length) return null;
  return processAsset(res.assets[0], 'library');
}
