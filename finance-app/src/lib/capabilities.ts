import Constants from 'expo-constants';
import { Platform } from 'react-native';

export interface FinanceCapabilities {
  widgets: boolean;
  appGroups: boolean;
  notifications: boolean;
  offlineSnapshot: boolean;
  freeSideload: boolean;
}

function readExtraFlag(name: string): boolean {
  const extra = Constants.expoConfig?.extra as Record<string, unknown> | undefined;
  return extra?.[name] === true;
}

export function getFinanceCapabilities(): FinanceCapabilities {
  const freeSideload = readExtraFlag('freeSideload');
  const widgets = !freeSideload && Platform.OS === 'ios';
  return {
    widgets,
    appGroups: !freeSideload,
    notifications: true,
    offlineSnapshot: false,
    freeSideload,
  };
}
