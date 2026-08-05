import * as LocalAuthentication from 'expo-local-authentication';
import { Platform } from 'react-native';
import { biometricLabelForTypes } from '@/lib/biometric-label.js';

export async function isBiometricAvailable(): Promise<boolean> {
  const hasHardware = await LocalAuthentication.hasHardwareAsync();
  const enrolled = await LocalAuthentication.isEnrolledAsync();
  return hasHardware && enrolled;
}

export async function getBiometricLabel(): Promise<string> {
  try {
    const types = await LocalAuthentication.supportedAuthenticationTypesAsync();
    return biometricLabelForTypes(Platform.OS, types);
  } catch {
    return 'Biometrics';
  }
}

export async function authenticate(reason = 'Unlock Finances'): Promise<boolean> {
  try {
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: reason,
      fallbackLabel: 'Use passcode',
      cancelLabel: 'Cancel',
    });
    return result.success;
  } catch {
    return false;
  }
}
