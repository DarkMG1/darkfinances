export declare const DEFAULT_MAX_SOURCE_BYTES: number;
export declare const DEFAULT_MAX_ENCODED_BYTES: number;
export declare const LOCAL_RECEIPT_URI_SCHEMES: readonly ['file:'];

export interface ReceiptFileSystem {
  getInfoAsync: (uri: string) => Promise<{
    exists?: boolean;
    isDirectory?: boolean;
    size?: number;
  }>;
  readAsStringAsync: (uri: string, options: { encoding: unknown }) => Promise<string>;
  EncodingType: { Base64: unknown };
}

export declare function assertLocalReceiptUri(uri: string): void;

export declare function estimateDecodedBase64Bytes(base64: string): number;

export declare function statRegularFileSize(uri: string, fileSystem: ReceiptFileSystem): Promise<number>;

export declare function readBoundedFileBase64(
  uri: string,
  fileSystem: ReceiptFileSystem,
  options?: { maxSourceBytes?: number; maxEncodedBytes?: number },
): Promise<string>;

export declare function assertBoundedBase64Payload(base64: string, maxEncodedBytes?: number): void;
