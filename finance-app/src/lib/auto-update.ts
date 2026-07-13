import { useEffect, useRef, useState } from 'react';
import { Alert, AppState } from 'react-native';
import * as Updates from 'expo-updates';

// Auto-check for an OTA update on JS launch AND whenever the app returns to the
// foreground. The native `checkAutomatically: ON_LOAD` only fires on a true cold
// start, but iOS usually *resumes* the app from the background (no relaunch), so
// that check never runs in practice. Driving it from JS via AppState covers the
// common "reopen the app" case. Download while the privacy gate is active, but
// wait to prompt until Face ID and its fade have completely settled.
export function useAutoUpdate(canPrompt: boolean) {
  const { isUpdatePending } = Updates.useUpdates();
  const busy = useRef(false);
  const fetched = useRef(false);
  const prompted = useRef(false);
  const lastAt = useRef(0);
  const [downloaded, setDownloaded] = useState(false);

  useEffect(() => {
    if (!Updates.isEnabled) return; // dev client / Expo Go — OTA disabled

    const check = async () => {
      if (busy.current || fetched.current) return;
      if (Date.now() - lastAt.current < 30_000) return; // throttle rapid fg/bg toggles
      busy.current = true;
      lastAt.current = Date.now();
      try {
        const res = await Updates.checkForUpdateAsync();
        if (res.isAvailable) {
          await Updates.fetchUpdateAsync();
          fetched.current = true;
          setDownloaded(true);
        }
      } catch {
        /* offline / transient network — ignore and retry on the next foreground */
      } finally {
        busy.current = false;
      }
    };

    check(); // initial JS load (covers warm starts where ON_LOAD didn't apply)
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') check();
    });
    return () => sub.remove();
  }, []);

  useEffect(() => {
    if (!Updates.isEnabled || !canPrompt || prompted.current) return;
    if (!downloaded && !isUpdatePending) return;
    if (AppState.currentState !== 'active') return;

    const timer = setTimeout(() => {
      if (AppState.currentState !== 'active' || prompted.current) return;
      prompted.current = true;
      Alert.alert('Update ready', 'The latest update has downloaded. Restart now to apply it?', [
        { text: 'Later', style: 'cancel' },
        { text: 'Restart', onPress: () => { void Updates.reloadAsync(); } },
      ]);
    }, 300);
    return () => clearTimeout(timer);
  }, [canPrompt, downloaded, isUpdatePending]);
}
