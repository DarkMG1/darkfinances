export type OtaUpdatePhase =
  | 'unsupported'
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'prompted'
  | 'deferred'
  | 'restarting'
  | 'error';

export interface OtaUpdateSnapshot {
  phase: OtaUpdatePhase;
  updateId: string | null;
  checkSource: 'auto' | 'manual' | null;
  error: string | null;
  manualStatus: string | null;
  promptedUpdateId: string | null;
  deferredUntil: number | null;
}

export interface OtaUpdateOwner {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => OtaUpdateSnapshot;
  initialize: () => void;
  maybeAutoCheck: () => void;
  requestManualCheck: () => Promise<OtaUpdateSnapshot>;
  requestRestart: () => Promise<void>;
  setAppActive: (active: boolean) => void;
  setPromptGateOpen: (open: boolean) => void;
  syncNativePending: () => void;
  dispose: () => void;
}

export function getOtaUpdateDisplayStatus(state: OtaUpdateSnapshot): string | null;

export function createOtaUpdateOwner(deps: Record<string, unknown>): OtaUpdateOwner;

export interface OtaUpdatePersistenceStore {
  getString: (key: string) => string | null;
  setString: (key: string, value: string | null) => void;
}

export function createOtaUpdatePersistence(store: OtaUpdatePersistenceStore): {
  readDeferred: (now?: number) => { updateId: string; deferredUntil: number } | null;
  writeDeferred: (record: { updateId: string; deferredUntil: number }) => void;
  clearDeferred: () => void;
};

export function nativePendingFromUpdates(updates: {
  isUpdatePending?: boolean;
  downloadedUpdate?: { updateId?: string; manifest?: { id?: string } | null };
  availableUpdate?: { updateId?: string; manifest?: { id?: string } | null };
}): { pending: boolean; updateId: string | null };

export function createOtaUpdateOwnerRunner(deps: Record<string, unknown>): {
  owner: OtaUpdateOwner;
  flushSchedules: (maxDelay?: number) => void;
  promptCount: () => number;
  lastPrompt: () => { onRestart: () => void; onLater: () => void } | null;
  scheduledCount: () => number;
};
