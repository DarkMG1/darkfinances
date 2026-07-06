import { Nullish } from '@/api/generated/types';

// The API accepts a static bearer token via the X-Finance-Token header (or
// Authorization: Bearer <token>). We mirror seanime-tenji's X-Seanime-Token scheme.
export function getServerAuthHeaders(token: Nullish<string>): Record<string, string> {
  if (!token) return {};
  return { 'X-Finance-Token': token };
}
