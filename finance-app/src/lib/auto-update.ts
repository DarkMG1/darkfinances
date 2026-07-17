import { useEffect, useSyncExternalStore } from 'react';
import { Alert, AppState } from 'react-native';
import * as Updates from 'expo-updates';
import { getOtaUpdateDisplayStatus } from '@/lib/ota-update-display';
import { createOtaUpdateOwner } from '@/lib/ota-update-owner';
import { createOtaUpdatePersistence } from '@/lib/ota-update-persistence';
import { nativePendingFromUpdates } from '@/lib/ota-update-owner-runner';
import { kv } from '@/lib/storage';

const persistence = createOtaUpdatePersistence({
  getString: (key: string) => kv.getString(key),
  setString: (key: string, value: string | null) => kv.setString(key, value),
});

type NativePending = { pending: boolean; updateId: string | null };

let sharedOwner: ReturnType<typeof createOtaUpdateOwner> | null = null;
const otaNativePendingRef: { current: NativePending } = { current: { pending: false, updateId: null } };

function getSharedOwner() {
  if (!sharedOwner) {
    sharedOwner = createOtaUpdateOwner({
      isSupported: () => Updates.isEnabled,
      persistence,
      checkForUpdate: () => Updates.checkForUpdateAsync(),
      fetchUpdate: () => Updates.fetchUpdateAsync(),
      reload: () => Updates.reloadAsync(),
      showPrompt: ({ onRestart, onLater }: { onRestart: () => void; onLater: () => void }) => {
        Alert.alert(
          'Update ready',
          'The latest update has downloaded. Restart now to apply it?',
          [
            { text: 'Later', style: 'cancel', onPress: onLater },
            { text: 'Restart', onPress: onRestart },
          ],
        );
      },
      getNativePending: () => otaNativePendingRef.current,
    });
  }
  return sharedOwner;
}

export function useOtaUpdateStatus(): string | null {
  const owner = getSharedOwner();
  const snapshot = useSyncExternalStore(owner.subscribe, owner.getSnapshot, owner.getSnapshot);
  return getOtaUpdateDisplayStatus(snapshot);
}

// Auto-check for an OTA update on JS launch AND whenever the app returns to the
// foreground. The native `checkAutomatically: ON_LOAD` only fires on a true cold
// start, but iOS usually *resumes* the app from the background (no relaunch), so
// that check never runs in practice. Driving it from JS via AppState covers the
// common "reopen the app" case. Download while the privacy gate is active, but
// wait to prompt until Face ID and its fade have completely settled.
export function useAutoUpdate(canPrompt: boolean) {
  const updates = Updates.useUpdates();
  const owner = getSharedOwner();

  const { isUpdatePending, downloadedUpdate } = updates;

  useEffect(() => {
    owner.initialize();
    owner.maybeAutoCheck();
  }, [owner]);

  useEffect(() => {
    otaNativePendingRef.current = nativePendingFromUpdates(updates);
    owner.syncNativePending();
  }, [owner, isUpdatePending, downloadedUpdate, updates]);

  useEffect(() => {
    owner.setPromptGateOpen(canPrompt);
  }, [canPrompt, owner]);

  useEffect(() => {
    const active = AppState.currentState === 'active';
    owner.setAppActive(active);
    const sub = AppState.addEventListener('change', (next) => {
      owner.setAppActive(next === 'active');
    });
    return () => sub.remove();
  }, [owner]);

  useSyncExternalStore(owner.subscribe, owner.getSnapshot, owner.getSnapshot);
}

export async function checkForUpdatesManual() {
  const owner = getSharedOwner();
  return owner.requestManualCheck();
}

export function getOtaUpdateSnapshot() {
  return getSharedOwner().getSnapshot();
}

export function __resetOtaUpdateOwnerForTests() {
  sharedOwner?.dispose();
  sharedOwner = null;
  otaNativePendingRef.current = { pending: false, updateId: null };
}
