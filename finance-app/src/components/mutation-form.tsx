import React, { useEffect, useRef } from 'react';
import {
  AccessibilityInfo,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TextInputProps,
  View,
  ViewStyle,
} from 'react-native';
import type { MappedMutationOutcome } from '@/lib/mutation-form-errors';
import { colors } from '@/theme/colors';

const ERROR_TEXT = '#ff6b6b';

export function MutationLiveRegion({ message }: { message: string }) {
  const prev = useRef('');
  useEffect(() => {
    if (!message || message === prev.current) return;
    prev.current = message;
    AccessibilityInfo.announceForAccessibility(message);
  }, [message]);
  return (
    <View
      accessibilityLiveRegion="polite"
      importantForAccessibility="yes"
      accessible
      accessibilityLabel={message || undefined}
      style={styles.srOnly}
    />
  );
}

export function MutationFormBanner({
  outcome,
  onRetry,
  onRefetch,
  testID = 'mutation-form-banner',
}: {
  outcome: MappedMutationOutcome | null;
  onRetry?: () => void;
  onRefetch?: () => void;
  testID?: string;
}) {
  if (!outcome) return null;
  const action = outcome.action;
  const onAction = action?.kind === 'refetch' ? onRefetch : onRetry;
  return (
    <View
      testID={testID}
      accessibilityRole="alert"
      style={[
        styles.banner,
        outcome.kind === 'terminal' || outcome.kind === 'conflict_ownership'
          ? styles.bannerTerminal
          : styles.bannerRecoverable,
      ]}
    >
      <Text style={styles.bannerText}>{outcome.summary}</Text>
      {action && onAction ? (
        <Pressable
          testID={`${testID}-action`}
          accessibilityRole="button"
          accessibilityLabel={action.label}
          style={({ pressed }) => [styles.bannerAction, pressed && { opacity: 0.7 }]}
          onPress={onAction}
          hitSlop={8}
        >
          <Text style={styles.bannerActionText}>{action.label}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function MutationFieldLabel({ children, error }: { children: React.ReactNode; error?: string }) {
  return (
    <Text
      style={[styles.fieldLabel, error ? { color: ERROR_TEXT } : null]}
      accessibilityRole="text"
    >
      {children}
    </Text>
  );
}

export function MutationFieldError({ error, testID }: { error?: string; testID?: string }) {
  if (!error) return null;
  return (
    <Text
      testID={testID}
      style={styles.fieldError}
      accessibilityRole="text"
      accessibilityLiveRegion="polite"
    >
      {error}
    </Text>
  );
}

export interface MutationTextFieldProps extends TextInputProps {
  label: string;
  error?: string;
  containerStyle?: ViewStyle;
}

export const MutationTextField = React.forwardRef<TextInput, MutationTextFieldProps>(
  function MutationTextField({ label, error, containerStyle, style, ...rest }, ref) {
    return (
      <View style={containerStyle}>
        <MutationFieldLabel error={error}>{label}</MutationFieldLabel>
        <TextInput
          ref={ref}
          {...rest}
          style={[styles.input, error ? styles.inputError : null, style]}
          accessibilityLabel={label}
          accessibilityHint={error ? `Error: ${error}` : rest.accessibilityHint}
          accessibilityState={{ disabled: rest.editable === false }}
        />
        <MutationFieldError error={error} testID={rest.testID ? `${rest.testID}-error` : undefined} />
      </View>
    );
  },
);

export function MutationSubmitButton({
  label,
  pendingLabel = 'Saving…',
  onPress,
  disabled,
  testID,
}: {
  label: string;
  pendingLabel?: string;
  onPress: () => void;
  disabled?: boolean;
  testID?: string;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={disabled ? `${pendingLabel}, button disabled` : label}
      accessibilityState={{ disabled: !!disabled, busy: !!disabled }}
      style={({ pressed }) => [styles.submit, (disabled || pressed) && { opacity: 0.7 }]}
      onPress={onPress}
      disabled={disabled}
    >
      <Text style={styles.submitText}>{disabled ? pendingLabel : label}</Text>
    </Pressable>
  );
}

export function MutationSheet({
  visible,
  title,
  onRequestClose,
  canDismiss,
  children,
  testID,
  bottomInset = 0,
}: {
  visible: boolean;
  title: string;
  onRequestClose: () => void;
  canDismiss?: boolean;
  children: React.ReactNode;
  testID?: string;
  bottomInset?: number;
}) {
  const handleClose = () => {
    if (canDismiss === false) return;
    onRequestClose();
  };
  return (
    <Modal
      visible={visible}
      animationType={Platform.OS === 'ios' ? 'slide' : 'fade'}
      transparent
      onRequestClose={handleClose}
      accessibilityViewIsModal
    >
      <Pressable style={styles.modalBg} onPress={handleClose} accessibilityLabel="Dismiss sheet">
        <Pressable
          testID={testID}
          style={[styles.sheet, { paddingBottom: bottomInset + 16 }]}
          onPress={() => {}}
          accessibilityLabel={title}
        >
          <Text accessibilityRole="header" style={styles.sheetTitle}>{title}</Text>
          {children}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  srOnly: {
    position: 'absolute',
    width: 1,
    height: 1,
    opacity: 0,
    overflow: 'hidden',
  },
  banner: {
    borderRadius: 10,
    padding: 12,
    marginBottom: 12,
    gap: 8,
    minHeight: 44,
    justifyContent: 'center',
  },
  bannerRecoverable: {
    backgroundColor: colors.yellow + '22',
    borderWidth: 1,
    borderColor: colors.yellow + '55',
  },
  bannerTerminal: {
    backgroundColor: colors.red + '18',
    borderWidth: 1,
    borderColor: colors.red + '44',
  },
  bannerText: {
    color: colors.text,
    fontSize: 14,
    lineHeight: 20,
  },
  bannerAction: {
    alignSelf: 'flex-start',
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  bannerActionText: {
    color: colors.accentLight,
    fontSize: 15,
    fontWeight: '600',
  },
  fieldLabel: {
    color: colors.muted,
    fontSize: 13,
    marginBottom: 6,
    marginTop: 4,
  },
  fieldError: {
    color: ERROR_TEXT,
    fontSize: 13,
    marginTop: 4,
    lineHeight: 18,
  },
  input: {
    backgroundColor: colors.surface2,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    minHeight: 44,
    color: colors.text,
    fontSize: 16,
    borderWidth: 1,
    borderColor: colors.border,
  },
  inputError: {
    borderColor: ERROR_TEXT,
  },
  submit: {
    backgroundColor: colors.accent,
    borderRadius: 12,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 16,
  },
  submitText: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '600',
  },
  modalBg: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: colors.bg,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: 16,
    maxHeight: '92%',
  },
  sheetTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: colors.text,
    marginBottom: 12,
  },
});
