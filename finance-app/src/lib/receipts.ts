import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { extractTextFromImage, isSupported } from 'expo-text-extractor';
import { type ReceiptFileSystem } from '@/lib/receipt-bounded-fallback';
import { processReceiptAsset as processReceiptAssetCore } from '@/lib/receipt-processor';

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

interface ReceiptProcessorDeps {
  fileSystem: ReceiptFileSystem;
  manipulateAsset: (
    uri: string,
    resize: { width: number } | { height: number } | undefined,
  ) => Promise<{ uri: string; base64?: string }>;
  extractOcrLines?: (uri: string) => Promise<string[]>;
}

const defaultReceiptProcessorDeps = (): ReceiptProcessorDeps => ({
  fileSystem: FileSystem as unknown as ReceiptFileSystem,
  extractOcrLines: async (uri) => {
    if (!isSupported) return [];
    try {
      return await extractTextFromImage(uri);
    } catch {
      return [];
    }
  },
  manipulateAsset: async (uri, resize) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const manipulator = require('expo-image-manipulator') as typeof import('expo-image-manipulator');
    return manipulator.manipulateAsync(
      uri,
      resize ? [{ resize }] : [],
      { base64: true, compress: 0.72, format: manipulator.SaveFormat.JPEG },
    );
  },
});

async function processAsset(
  asset: ImagePicker.ImagePickerAsset,
  source: 'camera' | 'library',
  deps: ReceiptProcessorDeps = defaultReceiptProcessorDeps(),
): Promise<CapturedReceipt> {
  return processReceiptAssetCore(asset, source, deps);
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
