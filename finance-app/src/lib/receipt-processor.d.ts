export interface ReceiptAssetInput {
  uri: string;
  width?: number | null;
  height?: number | null;
  mimeType?: string | null;
}

export interface ReceiptProcessorDeps {
  fileSystem: import('@/lib/receipt-bounded-fallback').ReceiptFileSystem;
  manipulateAsset: (
    uri: string,
    resize: { width: number } | { height: number } | undefined,
  ) => Promise<{ uri: string; base64?: string }>;
  extractOcrLines?: (uri: string) => Promise<string[]>;
}

export interface CapturedReceiptPayload {
  uri: string;
  base64: string;
  mime: string;
  ocrText: string;
  ocrLines: string[];
  amount: number | null;
  date: string | null;
  source: 'camera' | 'library';
}

export declare function processReceiptAsset(
  asset: ReceiptAssetInput,
  source: 'camera' | 'library',
  deps: ReceiptProcessorDeps,
): Promise<CapturedReceiptPayload>;
