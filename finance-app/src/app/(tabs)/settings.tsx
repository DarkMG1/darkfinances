import React, { useEffect, useState } from 'react';
import { Alert, Pressable, Share, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import Constants from 'expo-constants';
import { useRouter } from 'expo-router';
import * as Updates from 'expo-updates';
import { Screen } from '@/components/screen';
import { Card, CardTitle } from '@/components/ui';
import { useReconcilePending, useSetReconcileEnabled } from '@/api/hooks/finance.hooks';
import { useServerConfig } from '@/state/server';
import { verifyConnectionConfig } from '@/api/client/requests';
import { authenticate, isBiometricAvailable } from '@/lib/biometric';
import { DASHBOARD_WIDGETS, useDashboardWidgets } from '@/lib/dashboard-widgets';
import { buildRedactedDiagnostics } from '@/lib/diagnostics';
import { DEFAULT_LOW_BALANCE, DEFAULT_THRESHOLD, ensurePermission, getNotifSettings, NOTIF, notifyNotifSettingsChanged } from '@/lib/notifications';
import { getFinanceCapabilities } from '@/lib/capabilities';
import { isNotificationReconciliationActive } from '@/lib/notification-reconciliation-active';
import { kv } from '@/lib/storage';
import { colors } from '@/theme/colors';

type NotifKey = 'bills' | 'largeCharge' | 'newSub' | 'weekly' | 'lowBalance' | 'repayments';

const mask = (t: string | null) => (t ? `••••${t.slice(-4)}` : '—');

export default function Settings() {
  const { serverUrl, token, faceId, demo, setConfig, clear } = useServerConfig();
  const router = useRouter();
  const [bioAvailable, setBioAvailable] = useState(false);
  const [editUrl, setEditUrl] = useState(serverUrl ?? '');
  const [newToken, setNewToken] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [updateStatus, setUpdateStatus] = useState<string | null>(null);
  const [notif, setNotif] = useState(getNotifSettings());
  const [thresholdText, setThresholdText] = useState(String(getNotifSettings().threshold || DEFAULT_THRESHOLD));
  const [lowText, setLowText] = useState(String(getNotifSettings().lowBalanceThreshold || DEFAULT_LOW_BALANCE));
  const reconPending = useReconcilePending();
  const setReconcileEnabled = useSetReconcileEnabled();
  const [reconEnabled, setReconEnabled] = useState<boolean | null>(null);
  const dashboard = useDashboardWidgets();
  const capabilities = getFinanceCapabilities();
  const notificationsAvailable = isNotificationReconciliationActive({
    configured: !!serverUrl && !!token,
    demo,
    notificationsCapable: capabilities.notifications,
  });

  useEffect(() => {
    isBiometricAvailable().then(setBioAvailable);
  }, []);

  const reconEnabledValue = reconEnabled ?? !!reconPending.data?.enabled;

  const toggleNotif = async (key: NotifKey, value: boolean) => {
    if (!notificationsAvailable) return;
    if (value && !(await ensurePermission())) {
      Alert.alert('Notifications off', 'Enable notifications for DarkFinances in iOS Settings to use alerts.');
      return;
    }
    kv.setBool(NOTIF[key], value);
    setNotif(getNotifSettings());
    notifyNotifSettingsChanged();
  };

  const saveThreshold = () => {
    const n = parseFloat(thresholdText);
    if (n > 0) {
      kv.setNum(NOTIF.threshold, n);
      setNotif(getNotifSettings());
      notifyNotifSettingsChanged();
      setStatus(`Large-charge threshold set to $${n}`);
    }
  };

  const saveLowThreshold = () => {
    const n = parseFloat(lowText);
    if (n > 0) {
      kv.setNum(NOTIF.lowBalanceThreshold, n);
      setNotif(getNotifSettings());
      notifyNotifSettingsChanged();
      setStatus(`Low-balance alert set to $${n}`);
    }
  };

  const checkUpdates = async () => {
    if (!Updates.isEnabled) {
      setUpdateStatus('OTA runs only in a release (sideloaded) build');
      return;
    }
    setUpdateStatus('Checking…');
    try {
      const res = await Updates.checkForUpdateAsync();
      if (!res.isAvailable) {
        setUpdateStatus('Up to date');
        return;
      }
      setUpdateStatus('Downloading update…');
      await Updates.fetchUpdateAsync();
      setUpdateStatus('Update downloaded; restart prompt ready');
    } catch (e: any) {
      setUpdateStatus(e?.message || 'Update check failed');
    }
  };
  const exportDiagnostics = async () => {
    const diagnostics = buildRedactedDiagnostics({ serverUrl, demo, faceId });
    await Share.share({
      title: 'DarkFinances diagnostics',
      message: JSON.stringify(diagnostics, null, 2),
    });
  };

  const toggleFaceId = async (value: boolean) => {
    if (value) {
      const ok = await authenticate('Enable Face ID lock');
      if (!ok) return;
    }
    await setConfig({ faceId: value });
  };

  const test = async () => {
    setStatus('Testing…');
    try {
      const candidateUrl = editUrl.trim() || serverUrl || '';
      const candidateToken = newToken.trim() || token || '';
      await verifyConnectionConfig({ serverUrl: candidateUrl, token: candidateToken, demo });
      setStatus('Connected ✓');
    } catch (e: any) {
      setStatus(e?.error || e?.message || 'Failed');
    }
  };

  const saveUrl = async () => {
    if (editUrl.trim()) {
      setStatus('Verifying server…');
      try {
        const verified = await verifyConnectionConfig({
          serverUrl: editUrl,
          token: newToken.trim() || token || '',
          demo,
        });
        await setConfig(verified);
        setEditUrl(verified.serverUrl);
        if (newToken.trim()) setNewToken('');
        setStatus('Server URL updated');
      } catch (e: any) {
        setStatus(e?.error || e?.message || 'Could not verify server');
      }
    }
  };
  const saveToken = async () => {
    if (newToken.trim()) {
      setStatus('Verifying token…');
      try {
        const verified = await verifyConnectionConfig({
          serverUrl: editUrl.trim() || serverUrl || '',
          token: newToken,
          demo: false,
        });
        await setConfig(verified);
        setEditUrl(verified.serverUrl);
        setNewToken('');
        setStatus(demo ? 'Token updated; demo mode turned off' : 'Token updated');
      } catch (e: any) {
        setStatus(e?.error || e?.message || 'Could not verify token');
      }
    }
  };
  const setDemoMode = async (value: boolean) => {
    try {
      const verified = await verifyConnectionConfig({
        serverUrl: editUrl.trim() || serverUrl || '',
        token: newToken.trim() || token || '',
        demo: value,
      });
      await setConfig(verified);
      setEditUrl(verified.serverUrl);
      if (newToken.trim()) setNewToken('');
    } catch (e: any) {
      Alert.alert('Could not change demo mode', e?.error || e?.message || 'Please try again.');
    }
  };

  const disconnect = () => {
    Alert.alert('Disconnect', 'Remove the saved server and token from this device?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Disconnect',
        style: 'destructive',
        onPress: async () => {
          try {
            await clear();
          } catch (e: any) {
            Alert.alert(
              'Could not disconnect',
              e?.error || e?.message || 'A pending finance operation must be reconciled first.',
            );
          }
        },
      },
    ]);
  };

  return (
    <Screen title="Settings" testID="settings-screen">
      <CardTitle>Connection</CardTitle>
      <Card style={{ marginBottom: 16 }}>
        <Text style={styles.label}>Server URL</Text>
        <TextInput testID="settings-server-url-input" style={styles.input} value={editUrl} onChangeText={setEditUrl} autoCapitalize="none" autoCorrect={false} />
        <Pressable testID="settings-save-url-button" style={({ pressed }) => [styles.smallBtn, pressed && { opacity: 0.85 }]} onPress={saveUrl}><Text style={styles.smallBtnText}>Save URL</Text></Pressable>

        <Text style={[styles.label, { marginTop: 16 }]}>API Token</Text>
        <Text style={styles.maskedToken}>{mask(token)}</Text>
        <TextInput testID="settings-token-input" style={styles.input} value={newToken} onChangeText={setNewToken} autoCapitalize="none" autoCorrect={false} secureTextEntry placeholder="Replace token…" placeholderTextColor={colors.muted} />
        <Pressable testID="settings-save-token-button" style={({ pressed }) => [styles.smallBtn, pressed && { opacity: 0.85 }]} onPress={saveToken}><Text style={styles.smallBtnText}>Update Token</Text></Pressable>

        <Pressable testID="settings-test-connection-button" style={({ pressed }) => [styles.smallBtn, { marginTop: 16, backgroundColor: colors.surface2 }, pressed && { opacity: 0.7 }]} onPress={test}>
          <Text style={[styles.smallBtnText, { color: colors.accentLight }]}>Test Connection</Text>
        </Pressable>
        {status ? <Text style={styles.status}>{status}</Text> : null}
      </Card>

      <CardTitle>Security</CardTitle>
      <Card style={{ marginBottom: 16 }}>
        <View style={styles.switchRow}>
          <View>
            <Text style={styles.switchLabel}>Face ID Lock</Text>
            <Text style={styles.switchSub}>{bioAvailable ? 'Require Face ID on open' : 'Not available on this device'}</Text>
          </View>
          <Switch testID="settings-face-id-switch" value={faceId} onValueChange={toggleFaceId} disabled={!bioAvailable} trackColor={{ true: colors.accent }} />
        </View>
      </Card>

      <CardTitle>Demo Mode</CardTitle>
      <Card style={{ marginBottom: 16 }}>
        <View style={styles.switchRow}>
          <View style={{ flex: 1, paddingRight: 12 }}>
            <Text style={styles.switchLabel}>Show demo data</Text>
            <Text style={styles.switchSub}>Replace everything with sample finances — safe to show others. Your real data is never touched.</Text>
          </View>
          <Switch testID="settings-demo-mode-switch" value={demo} onValueChange={setDemoMode} trackColor={{ true: colors.accent }} />
        </View>
      </Card>

      <CardTitle>Dashboard</CardTitle>
      <Card style={{ marginBottom: 16 }}>
        {DASHBOARD_WIDGETS.map((w, idx) => (
          <View key={w.key} style={[styles.switchRow, idx < DASHBOARD_WIDGETS.length - 1 && styles.rowDivider]}>
            <View style={{ flex: 1, paddingRight: 12 }}>
              <Text style={styles.switchLabel}>{w.label}</Text>
              <Text style={styles.switchSub}>Show on Home</Text>
            </View>
            <Switch testID={`settings-dashboard-${w.key}-switch`} value={dashboard.visible[w.key]} onValueChange={(v) => dashboard.setVisible(w.key, v)} trackColor={{ true: colors.accent }} />
          </View>
        ))}
      </Card>

      <CardTitle>Automation</CardTitle>
      <Card style={{ marginBottom: 16 }}>
        <Pressable testID="settings-rules-row" style={({ pressed }) => [styles.navRow, styles.rowDivider, pressed && { opacity: 0.6 }]} onPress={() => router.push('/rules')}>
          <View style={{ flex: 1, paddingRight: 12 }}>
            <Text style={styles.switchLabel}>Categorization Rules</Text>
            <Text style={styles.switchSub}>Auto-categorize transactions by payee</Text>
          </View>
          <Text style={styles.navArrow}>›</Text>
        </Pressable>

        <Pressable testID="settings-events-row" style={({ pressed }) => [styles.navRow, styles.rowDivider, pressed && { opacity: 0.6 }]} onPress={() => router.push('/events')}>
          <View style={{ flex: 1, paddingRight: 12 }}>
            <Text style={styles.switchLabel}>Trips & Events</Text>
            <Text style={styles.switchSub}>Group charges for a trip and track who owes you</Text>
          </View>
          <Text style={styles.navArrow}>›</Text>
        </Pressable>

        <View style={[styles.switchRow, styles.rowDivider]}>
          <View style={{ flex: 1, paddingRight: 12 }}>
            <Text style={styles.switchLabel}>Monthly reconciliation</Text>
            <Text style={styles.switchSub}>At month-end, review every expense and close out the month. You will be reminded until it is done.</Text>
          </View>
          <Switch
            testID="settings-reconciliation-switch"
            value={reconEnabledValue}
            onValueChange={(v) => { setReconEnabled(v); setReconcileEnabled.mutate({ enabled: v }); }}
            trackColor={{ true: colors.accent }}
          />
        </View>

        <Pressable testID="settings-reconcile-row" style={({ pressed }) => [styles.navRow, pressed && { opacity: 0.6 }]} onPress={() => router.push('/reconcile')}>
          <View style={{ flex: 1, paddingRight: 12 }}>
            <Text style={styles.switchLabel}>Reconcile a month</Text>
            <Text style={styles.switchSub}>Review a past month now</Text>
          </View>
          <Text style={styles.navArrow}>›</Text>
        </Pressable>
      </Card>

      <CardTitle>Notifications</CardTitle>
      <Card style={{ marginBottom: 16 }}>
        {!notificationsAvailable ? (
          <View testID="settings-notifications-unavailable">
            <Text style={styles.switchLabel}>Alerts unavailable</Text>
            <Text style={styles.switchSub}>
              {demo
                ? 'Notification alerts do not run in demo mode. Turn off demo mode to configure alerts.'
                : capabilities.freeSideload
                  ? 'This sideload build does not include notification support. Use a full release build to enable alerts.'
                  : 'Connect to your server to configure on-device alerts.'}
            </Text>
          </View>
        ) : (
          <>
        <NotifSwitch testID="settings-notif-bills" label="Bills due" sub="Remind me the day before" value={notif.bills} onChange={(v) => toggleNotif('bills', v)} disabled={!notificationsAvailable} />
        <NotifSwitch testID="settings-notif-large-charge" label="Large charges" sub={`Alert over $${notif.threshold}`} value={notif.largeCharge} onChange={(v) => toggleNotif('largeCharge', v)} disabled={!notificationsAvailable} />
        {notif.largeCharge ? (
          <View style={styles.thresholdRow}>
            <Text style={styles.switchSub}>Large-charge threshold ($)</Text>
            <TextInput testID="settings-large-charge-threshold-input" style={styles.thresholdInput} value={thresholdText} onChangeText={setThresholdText} onBlur={saveThreshold} keyboardType="decimal-pad" />
          </View>
        ) : null}
        <NotifSwitch testID="settings-notif-low-balance" label="Low balance" sub={`Alert under $${notif.lowBalanceThreshold} in a cash account`} value={notif.lowBalance} onChange={(v) => toggleNotif('lowBalance', v)} disabled={!notificationsAvailable} />
        {notif.lowBalance ? (
          <View style={styles.thresholdRow}>
            <Text style={styles.switchSub}>Low-balance threshold ($)</Text>
            <TextInput testID="settings-low-balance-threshold-input" style={styles.thresholdInput} value={lowText} onChangeText={setLowText} onBlur={saveLowThreshold} keyboardType="decimal-pad" />
          </View>
        ) : null}
        <NotifSwitch testID="settings-notif-new-sub" label="New subscriptions" sub="When a new recurring charge appears" value={notif.newSub} onChange={(v) => toggleNotif('newSub', v)} disabled={!notificationsAvailable} />
        <NotifSwitch testID="settings-notif-repayments" label="Repayments to review" sub="When an incoming payment may settle a debt" value={notif.repayments} onChange={(v) => toggleNotif('repayments', v)} disabled={!notificationsAvailable} />
        <NotifSwitch testID="settings-notif-weekly" label="Weekly digest" sub="Sunday 9am check-in" value={notif.weekly} onChange={(v) => toggleNotif('weekly', v)} last disabled={!notificationsAvailable} />
        <Text style={styles.notifHint}>Alerts are on-device and refresh when you open the app.</Text>
          </>
        )}
      </Card>

      <CardTitle>About</CardTitle>
      <Card style={{ marginBottom: 16 }}>
        <View style={styles.aboutRow}>
          <Text style={styles.aboutKey}>Version</Text>
          <Text style={styles.aboutVal}>{Constants.expoConfig?.version ?? '1.0.0'}</Text>
        </View>
        <View style={styles.aboutRow}>
          <Text style={styles.aboutKey}>Channel</Text>
          <Text style={styles.aboutVal}>{Updates.channel || 'dev'}</Text>
        </View>
        <Pressable testID="settings-check-updates-button" style={({ pressed }) => [styles.smallBtn, { marginTop: 12, backgroundColor: colors.surface2 }, pressed && { opacity: 0.7 }]} onPress={checkUpdates}>
          <Text style={[styles.smallBtnText, { color: colors.accentLight }]}>Check for Updates</Text>
        </Pressable>
        <Pressable testID="settings-export-diagnostics-button" style={({ pressed }) => [styles.smallBtn, { marginTop: 8, backgroundColor: colors.surface2 }, pressed && { opacity: 0.7 }]} onPress={exportDiagnostics}>
          <Text style={[styles.smallBtnText, { color: colors.accentLight }]}>Export Redacted Diagnostics</Text>
        </Pressable>
        {updateStatus ? <Text style={styles.status}>{updateStatus}</Text> : null}
      </Card>

      <Pressable testID="settings-disconnect-button" style={({ pressed }) => [styles.disconnect, pressed && { opacity: 0.7 }]} onPress={disconnect}>
        <Text style={styles.disconnectText}>Disconnect</Text>
      </Pressable>
    </Screen>
  );
}

function NotifSwitch({ label, sub, value, onChange, last, testID, disabled }: { label: string; sub: string; value: boolean; onChange: (v: boolean) => void; last?: boolean; testID?: string; disabled?: boolean }) {
  return (
    <View style={[styles.switchRow, styles.notifRow, last && { borderBottomWidth: 0 }]}>
      <View style={{ flex: 1, paddingRight: 12 }}>
        <Text style={styles.switchLabel}>{label}</Text>
        <Text style={styles.switchSub}>{sub}</Text>
      </View>
      <Switch testID={testID} value={value} onValueChange={onChange} disabled={disabled} trackColor={{ true: colors.accent }} />
    </View>
  );
}

const styles = StyleSheet.create({
  label: { color: colors.muted, fontSize: 12, fontWeight: '600', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 },
  notifRow: { paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  thresholdRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 10 },
  thresholdInput: { backgroundColor: colors.surface2, borderColor: colors.border, borderWidth: 1, borderRadius: 8, color: colors.text, paddingHorizontal: 12, paddingVertical: 8, fontSize: 14, width: 110, textAlign: 'right' },
  notifHint: { color: colors.muted, fontSize: 11, marginTop: 10 },
  input: { backgroundColor: colors.surface2, borderColor: colors.border, borderWidth: 1, borderRadius: 8, color: colors.text, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, marginBottom: 8 },
  maskedToken: { color: colors.text, fontSize: 14, fontFamily: 'Menlo', marginBottom: 8 },
  smallBtn: { backgroundColor: colors.accent, borderRadius: 8, paddingVertical: 10, alignItems: 'center' },
  smallBtnText: { color: '#fff', fontWeight: '600', fontSize: 13 },
  status: { color: colors.accentLight, fontSize: 13, marginTop: 12, textAlign: 'center' },
  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  navRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  rowDivider: { paddingBottom: 14, marginBottom: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  navArrow: { color: colors.muted, fontSize: 22, fontWeight: '700' },
  switchLabel: { color: colors.text, fontSize: 15, fontWeight: '600' },
  switchSub: { color: colors.muted, fontSize: 12, marginTop: 2 },
  aboutRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 4 },
  aboutKey: { color: colors.muted, fontSize: 14 },
  aboutVal: { color: colors.text, fontSize: 14, fontWeight: '600' },
  disconnect: { borderColor: colors.red, borderWidth: 1, borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
  disconnectText: { color: colors.red, fontWeight: '600', fontSize: 15 },
});
