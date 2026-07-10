import { Nullish } from '@/api/generated/types';

// Normalize the configured server URL (strip trailing slash). The app talks to the
// same public host as the web dashboard.
export function getServerBaseUrl(serverUrl: Nullish<string>): string {
  if (!serverUrl) return '';
  let ret = serverUrl.trim();
  if (!/^https?:\/\//i.test(ret)) ret = 'https://' + ret;
  return ret.replace(/\/+$/, '');
}

export function normalizeServerUrl(input: string, allowDevelopmentHttp = __DEV__): string {
  const normalized = getServerBaseUrl(input);
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error('Enter a valid server URL.');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Server URL cannot include credentials, a query, or a fragment.');
  }
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(allowDevelopmentHttp && loopback && url.protocol === 'http:')) {
    throw new Error('Use an HTTPS server URL.');
  }
  return url.toString().replace(/\/+$/, '');
}
