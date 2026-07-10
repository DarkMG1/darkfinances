import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import * as Updates from 'expo-updates';

// Auto-check for an OTA update on JS launch AND whenever the app returns to the
// foreground. The native `checkAutomatically: ON_LOAD` only fires on a true cold
// start, but iOS usually *resumes* the app from the background (no relaunch), so
// that check never runs in practice. Driving it from JS via AppState covers the
// common "reopen the app" case. This is pure JS, so it ships over OTA.
export function useAutoUpdate() {
  const busy = useRef(false);
  const fetched = useRef(false); // stop nagging once we've pulled an update this session
  const lastAt = useRef(0);

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
          // Apply on the next cold launch. An alert here can race the Face ID
          // inactive/active transition and destabilize the privacy overlay.
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
}
