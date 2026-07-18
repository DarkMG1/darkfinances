import { useRef } from 'react';

/** Shared synchronous admission ref for multi-mutation screens (form + actions). */
export function useMutationScreenAdmission() {
  return useRef(false);
}
