import type { OtaUpdateSnapshot } from '@/lib/ota-update-owner';

export function getOtaUpdateDisplayStatus(state: OtaUpdateSnapshot): string | null;
export function getOtaUpdateStatusLabel(state: OtaUpdateSnapshot): string | null;
