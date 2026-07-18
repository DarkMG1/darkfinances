import { useRef } from 'react';
import { createMutationAdmissionRef } from '@/lib/mutation-screen-admission';

export type MutationAdmissionRef = React.MutableRefObject<ReturnType<typeof createMutationAdmissionRef>>;

/** Shared synchronous admission ref for multi-mutation screens (form + actions). */
export function useMutationScreenAdmission(): MutationAdmissionRef {
  return useRef(createMutationAdmissionRef());
}
