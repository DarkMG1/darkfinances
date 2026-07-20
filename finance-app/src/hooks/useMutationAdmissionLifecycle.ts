import { useCallback, useEffect, useRef } from 'react';
import {
  releaseMutationAdmission,
  tryAcquireMutationAdmission,
} from '@/lib/mutation-screen-admission';
import type { MutationAdmissionRef } from '@/hooks/useMutationScreenAdmission';

/** Per-hook admission lease bound to each dispatch; stale settles cannot release a newer owner. */
export function useMutationAdmissionLifecycle(
  admissionRef: MutationAdmissionRef | undefined,
  identityKey: string,
) {
  const admissionLeaseRef = useRef<number | null>(null);

  const releaseHeldAdmission = useCallback(() => {
    const lease = admissionLeaseRef.current;
    if (lease == null) return;
    admissionLeaseRef.current = null;
    releaseMutationAdmission(admissionRef, lease);
  }, [admissionRef]);

  useEffect(() => {
    releaseHeldAdmission();
    return releaseHeldAdmission;
  }, [identityKey, releaseHeldAdmission]);

  const acquireAdmission = useCallback((): number | null => {
    const lease = tryAcquireMutationAdmission(admissionRef);
    if (lease == null) return null;
    admissionLeaseRef.current = lease;
    return lease;
  }, [admissionRef]);

  const releaseAdmissionForLease = useCallback((lease: number | null | undefined) => {
    if (lease == null || lease === 0) return;
    if (admissionLeaseRef.current === lease) {
      admissionLeaseRef.current = null;
    }
    releaseMutationAdmission(admissionRef, lease);
  }, [admissionRef]);

  return {
    acquireAdmission,
    releaseAdmissionForLease,
    releaseHeldAdmission,
    admissionLeaseRef,
  };
}
