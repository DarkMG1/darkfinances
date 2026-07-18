declare module '@/lib/mutation-activation-sequence' {
  export function nextMutationActivationSeq(): number;
  export function currentMutationActivationSeq(): number;
  export function resetMutationActivationSequence(): void;
}
