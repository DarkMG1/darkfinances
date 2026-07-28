import { useEffect, useRef, useSyncExternalStore } from 'react';
import * as Notifications from 'expo-notifications';
import { useRouter } from 'expo-router';
import { getFinanceCapabilities } from '@/lib/capabilities';
import { isNotificationReconciliationActive } from '@/lib/notification-reconciliation-active';
import {
  clearNotificationRoutingState,
  parseNotificationRoute,
} from '@/lib/notifications';
import {
  getProfileGeneration,
  subscribeProfileGeneration,
} from '@/lib/notification-reconciliation';
import { useServerConfig } from '@/state/server';

export function NotificationRouter() {
  const router = useRouter();
  const capabilities = getFinanceCapabilities();
  const { configured, demo, scope } = useServerConfig();
  const notificationsActive = isNotificationReconciliationActive({
    configured,
    demo,
    notificationsCapable: capabilities.notifications,
  });
  const profileGeneration = useSyncExternalStore(
    subscribeProfileGeneration,
    getProfileGeneration,
    getProfileGeneration,
  );
  const handledGenerationRef = useRef<number | null>(null);

  useEffect(() => {
    if (!notificationsActive) return;
    clearNotificationRoutingState();
    handledGenerationRef.current = null;
  }, [notificationsActive, profileGeneration, scope]);

  useEffect(() => {
    if (!notificationsActive) return;
    const open = (data: unknown) => {
      const payload = parseNotificationRoute(data);
      if (!payload || payload.scope !== scope) return;
      if (handledGenerationRef.current === profileGeneration) return;
      handledGenerationRef.current = profileGeneration;
      router.push(payload.route as never);
    };
    const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
      open(response.notification.request.content.data);
    });
    void Notifications.getLastNotificationResponseAsync().then((response) => {
      if (response) open(response.notification.request.content.data);
    }).catch(() => {});
    return () => subscription.remove();
  }, [notificationsActive, profileGeneration, router, scope]);

  return null;
}
