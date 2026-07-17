export const SUSPENSION_KEY_PREFIX: string;

export function bindNotificationScopeSuspensionPersistence(persistence: {
  kv: {
    getString: (key: string) => string | null;
    setString: (key: string, value: string | null) => void;
  };
  storage: {
    getAllKeys: () => string[];
    remove: (key: string) => void;
  };
}): void;

export function activateNotificationScope(scope: string | undefined, generation: number): void;

export function assertScopeReconciliationAdmitted(scope: string | undefined): void;

export function isNotificationScopeAdmissionAllowed(scope: string | undefined): boolean;

export function isNotificationScopeSuspended(scope: string | undefined): boolean;

export function readPersistedSuspensionGeneration(scope: string | undefined): number | null;

export function suspendNotificationScope(scope: string | undefined): void;

export function resetNotificationScopeSuspensions(): void;

export function simulateNotificationScopeSuspensionModuleReset(): void;
