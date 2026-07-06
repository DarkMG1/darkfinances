import { Nullish } from '@/api/generated/types';

// Normalize the configured server URL (strip trailing slash). The app talks to the
// same public host as the web dashboard.
export function getServerBaseUrl(serverUrl: Nullish<string>): string {
  if (!serverUrl) return '';
  let ret = serverUrl.trim();
  if (!/^https?:\/\//i.test(ret)) ret = 'https://' + ret;
  return ret.replace(/\/+$/, '');
}
