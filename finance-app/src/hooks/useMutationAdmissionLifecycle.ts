import { useCallback, useEffect, useRef } from 'react';
import {
  releaseMutationAdmission,
  tryAcquireMutationAdmission,
} from '@/lib/mutation-screen-admission';
import type { MutationAdmissionRef } from '@/hooks/useMutationScreenAdmission';

/** Per-hook admission lease: acquire, release on settle before token checks, cleanup on identity/unmount. */
export function useMutationAdmissionLifecycle(
  admissionRef: MutationAdmissionRef | undefined,
  identityKey: string,
) {
  const admissionLeaseRef = useRef<number | null>(null);

  const releaseHeldAdmission = useCallback(() => {
    const lease = admissionLeaseRef.current;
    admissionLeaseRef.current = null;
    if (lease != null) releaseMutationAdmission(admissionRef, lease);
  }, [admissionRef]);

  useEffect(() => {
    releaseHeldAdmission();
    return releaseHeldAdmission;
  }, [identityKey, releaseHeldAdmission]);

  const acquireAdmission = useCallback((): boolean => {
    const lease = tryAcquireMutationAdmission(admissionRef);
    if (lease == null) return false;
    admissionLeaseRef.current = lease;
    return true;
  }, [admissionRef]);

  const releaseAdmissionFromSettle = useCallback(() => {
    const lease = admissionLeaseRef.current;
    admissionLeaseRef.current = null;
    if (lease != null) releaseMutationAdmission(admissionRef, lease);
  }, [admissionRef]);

  return { acquireAdmission, releaseAdmissionFromSettle, releaseHeldAdmission };
}
