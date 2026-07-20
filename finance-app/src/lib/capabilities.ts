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

function pluginIncluded(name: string): boolean {
  const plugins = Constants.expoConfig?.plugins ?? [];
  return plugins.some((plugin) => (Array.isArray(plugin) ? plugin[0] : plugin) === name);
}

export function getFinanceCapabilities(): FinanceCapabilities {
  const freeSideload = readExtraFlag('freeSideload');
  const notifications = !freeSideload && pluginIncluded('expo-notifications');
  const widgets = !freeSideload && Platform.OS === 'ios';
  return {
    widgets,
    appGroups: !freeSideload,
    notifications,
    offlineSnapshot: false,
    freeSideload,
  };
}
