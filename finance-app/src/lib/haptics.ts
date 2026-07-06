import * as Haptics from 'expo-haptics';

// Thin, fire-and-forget wrapper around expo-haptics. Every call is wrapped in a
// catch so a missing taptic engine (simulator, older device) can never throw and
// break a tap handler. Use `tap` for selections/navigation, `success`/`warning`
// for the result of a write, and `light`/`heavy` for physical-feeling gestures.
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
