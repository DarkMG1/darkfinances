import { createMMKV } from 'react-native-mmkv';
import { bindNotificationScopeSuspensionPersistence } from '@/lib/notification-scope-suspension';

// Non-secret persistence (server URL, UI prefs). The auth token lives in SecureStore.
export const storage = createMMKV({ id: 'darkfinances' });

export const kv = {
  getString: (key: string): string | null => storage.getString(key) ?? null,
  setString: (key: string, value: string | null) => {
    if (value == null) storage.remove(key);
    else storage.set(key, value);
  },
  getBool: (key: string, fallback = false): boolean => storage.getBoolean(key) ?? fallback,
  setBool: (key: string, value: boolean) => storage.set(key, value),
  getNum: (key: string, fallback = 0): number => storage.getNumber(key) ?? fallback,
  setNum: (key: string, value: number) => storage.set(key, value),
};

bindNotificationScopeSuspensionPersistence({ kv, storage });
