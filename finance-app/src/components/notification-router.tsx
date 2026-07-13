import { useEffect } from 'react';
import * as Notifications from 'expo-notifications';
import { useRouter } from 'expo-router';
import { parseNotificationRoute } from '@/lib/notifications';
import { useServerConfig } from '@/state/server';

export function NotificationRouter() {
  const router = useRouter();
  const { configured, demo, scope } = useServerConfig();

  useEffect(() => {
    if (!configured || demo) return;
    const open = (data: unknown) => {
      const payload = parseNotificationRoute(data);
      if (!payload || payload.scope !== scope || !payload.route.startsWith('/')) return;
      router.push(payload.route as never);
    };
    const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
      open(response.notification.request.content.data);
    });
    void Notifications.getLastNotificationResponseAsync().then((response) => {
      if (response) open(response.notification.request.content.data);
    }).catch(() => {});
    return () => subscription.remove();
  }, [configured, demo, router, scope]);

  return null;
}
