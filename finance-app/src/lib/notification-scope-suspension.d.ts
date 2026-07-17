export function activateNotificationScope(scope: string | undefined, generation: number): void;

export function assertScopeReconciliationAdmitted(scope: string | undefined): void;

export function isNotificationScopeAdmissionAllowed(scope: string | undefined): boolean;

export function isNotificationScopeSuspended(scope: string | undefined): boolean;

export function suspendNotificationScope(scope: string | undefined): void;

export function resetNotificationScopeSuspensions(): void;
