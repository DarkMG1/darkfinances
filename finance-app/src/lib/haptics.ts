import * as Haptics from 'expo-haptics';
import { createMutationOutcomeHapticGate } from '@/lib/mutation-outcome-haptics';

// Thin, fire-and-forget wrapper around expo-haptics. Every call is wrapped in a
// catch so a missing taptic engine (simulator, older device) can never throw and
// break a tap handler. Use `tap` for selections/navigation, `light`/`heavy` for
// physical-feeling gestures. Mutation success/warning outcome haptics are owned
// by useFinanceMutation via mutationOutcomeHaptics — screens must not duplicate
// those in mutation callbacks (see README § Mutation outcome haptics).
export const haptics = {
  tap: () => {
    Haptics.selectionAsync().catch(() => {});
  },
  light: () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
  },
  medium: () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
  },
  success: () => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
  },
  warning: () => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
  },
};

/** Client-side validation rejected before a network mutation is sent. */
export function hapticClientValidationRejected(): void {
  mutationOutcomeHaptics.emitClientValidationError();
}

export const mutationOutcomeHaptics = createMutationOutcomeHapticGate(haptics);
