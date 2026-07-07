import React, { useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { testConnection } from '@/api/client/requests';
import { useServerConfig } from '@/state/server';
import { colors } from '@/theme/colors';

export default function Onboarding() {
  const insets = useSafeAreaInsets();
  const { setConfig } = useServerConfig();
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const connect = async () => {
    if (!url.trim() || !token.trim()) {
      setStatus('Enter both server URL and token');
      return;
    }
    setBusy(true);
    setStatus('Connecting…');
    try {
      const ok = await testConnection(url.trim(), token.trim());
      if (!ok) throw new Error('Server did not confirm');
      await setConfig({ serverUrl: url.trim(), token: token.trim() });
      // gate in _layout will switch to the tabs automatically
    } catch (e: any) {
      setStatus(e?.error || e?.message || 'Connection failed');
      setBusy(false);
    }
  };
  const useDemo = async () => {
    await setConfig({ serverUrl: 'http://127.0.0.1:5007', token: 'demo', demo: true });
  };

  return (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={[styles.inner, { paddingTop: insets.top + 40 }]}>
        <Text style={styles.logo}>dark<Text style={{ color: colors.accentLight }}>finances</Text></Text>
        <Text style={styles.sub}>Connect to your server</Text>

        <Text style={styles.label}>Server URL</Text>
        <TextInput
          style={styles.input}
          value={url}
          onChangeText={setUrl}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          placeholder="https://finances.example.dev"
          placeholderTextColor={colors.muted}
        />

        <Text style={styles.label}>API Token</Text>
        <TextInput
          style={styles.input}
          value={token}
          onChangeText={setToken}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
          placeholder="Paste your finance API token"
          placeholderTextColor={colors.muted}
        />

        <Pressable style={[styles.btn, busy && { opacity: 0.6 }]} disabled={busy} onPress={connect}>
          {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnText}>Connect</Text>}
        </Pressable>
        <Pressable testID="onboarding-demo-button" style={styles.demoBtn} disabled={busy} onPress={useDemo}>
          <Text style={styles.demoText}>Use demo data</Text>
        </Pressable>

        {status ? <Text style={styles.status}>{status}</Text> : null}
        <Text style={styles.hint}>Find your token in the dashboard server environment as FINANCE_API_TOKEN.</Text>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  inner: { flex: 1, paddingHorizontal: 24 },
  logo: { color: colors.text, fontSize: 26, fontWeight: '800', letterSpacing: -0.5 },
  sub: { color: colors.muted, fontSize: 15, marginTop: 6, marginBottom: 28 },
  label: { color: colors.muted, fontSize: 12, fontWeight: '600', marginBottom: 6, marginTop: 16, textTransform: 'uppercase', letterSpacing: 0.6 },
  input: {
    backgroundColor: colors.surface2,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 10,
    color: colors.text,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
  },
  btn: { backgroundColor: colors.accent, borderRadius: 12, paddingVertical: 15, alignItems: 'center', marginTop: 28 },
  btnText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  demoBtn: { borderColor: colors.border, borderWidth: 1, borderRadius: 12, paddingVertical: 13, alignItems: 'center', marginTop: 12 },
  demoText: { color: colors.text, fontWeight: '700', fontSize: 15 },
  status: { color: colors.accentLight, marginTop: 16, fontSize: 13, textAlign: 'center' },
  hint: { color: colors.muted, marginTop: 18, fontSize: 12, lineHeight: 18, textAlign: 'center' },
});
