import type { ImageSource } from 'expo-image';

export declare const RECEIPT_IMAGE_CACHE_POLICY: 'memory';
export declare const RECEIPT_IMAGE_CACHE_PURGE_FAILED: 'RECEIPT_IMAGE_CACHE_PURGE_FAILED';

export declare function buildReceiptImageCacheKey(
  scope: string,
  profileGeneration: number,
  receiptId: string,
): string;

export declare function buildReceiptImageSource(input: {
  uri: string;
  headers: Record<string, string>;
  demo?: boolean;
  scope: string;
  profileGeneration: number;
  receiptId: string;
}): ImageSource;

export declare function purgeReceiptImageCaches(imageModule?: {
  clearMemoryCache?: () => Promise<boolean>;
  clearDiskCache?: () => Promise<boolean>;
}): Promise<void>;
