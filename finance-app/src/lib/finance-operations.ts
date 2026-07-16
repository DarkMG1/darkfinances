import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { kv } from '@/lib/storage';
import {
  canonicalJson,
  createReconciliationDiagnosticStore,
  createRequestOperationMachine,
  PendingOperationSnapshot,
  RedactedReconciliationDiagnostic,
} from '@/lib/request-operation-state';

const OPERATION_STORAGE_KEY = 'finance-pending-operations-v1';
const RECONCILIATION_DIAGNOSTIC_STORAGE_KEY = 'finance-operation-reconciliation-diagnostic-v1';

function sha256Hex(value: string): string {
  return bytesToHex(sha256(utf8ToBytes(value)));
}

const operationStore = {
  read(): PendingOperationSnapshot | null {
    const value = kv.getString(OPERATION_STORAGE_KEY);
    if (value == null) return null;
    return JSON.parse(value) as PendingOperationSnapshot;
  },
  write(snapshot: PendingOperationSnapshot): void {
    kv.setString(OPERATION_STORAGE_KEY, JSON.stringify(snapshot));
  },
};

const reconciliationDiagnosticStore = createReconciliationDiagnosticStore({
  read: () => kv.getString(RECONCILIATION_DIAGNOSTIC_STORAGE_KEY),
  write: (value) => kv.setString(RECONCILIATION_DIAGNOSTIC_STORAGE_KEY, value),
});

export const financeOperationMachine = createRequestOperationMachine({
  store: operationStore,
  hash: sha256Hex,
  keyFactory: ({ requestDigest, scopeDigest, createdAt, generation }) =>
    `ios-${sha256Hex(canonicalJson({
      version: 1,
      scopeDigest,
      requestDigest,
      createdAt,
      generation,
    }))}`,
});

export function financeOperationProfileScope(
  serverUrl: string | null | undefined,
  token: string | null | undefined,
  demo: boolean,
): string | null {
  if (demo || !serverUrl || !token) return null;
  return sha256Hex(canonicalJson({
    version: 1,
    serverUrl,
    token,
    profile: 'live',
  }));
}

export function prepareFinanceOperationProfilePurge(scopeDigest: string | null): void {
  if (scopeDigest) financeOperationMachine.prepareProfilePurge(scopeDigest);
}

export function recordFinanceOperationReconciliationError(error: unknown): void {
  reconciliationDiagnosticStore.record(error);
}

export function getFinanceOperationReconciliationDiagnostic(): RedactedReconciliationDiagnostic | null {
  return reconciliationDiagnosticStore.get();
}

export function clearFinanceOperationReconciliationDiagnostic(): void {
  reconciliationDiagnosticStore.clear();
}
