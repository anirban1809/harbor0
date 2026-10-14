import type { StorageUsage } from '@harbor/contracts';

/**
 * Less free than this and storage is full: hardly any file fits (1% of the limit, at most
 * 1 MB). The apps, the drive's banner and the sync engine all use this one rule.
 */
export const fullBelow = (quotaBytes?: number) =>
  Math.min(1_000_000, quotaBytes ? quotaBytes / 100 : 1_000_000);

/** How full the account is: over its (lowered) limit, full, nearly full (95%), or fine. */
export function storageState(storage: StorageUsage) {
  const taken = storage.usedBytes + storage.reservedBytes;
  if (storage.usedBytes > storage.quotaBytes) return 'over' as const;
  if (storage.quotaBytes - taken < fullBelow(storage.quotaBytes)) return 'full' as const;
  if (taken / storage.quotaBytes >= 0.95) return 'low' as const;
  return 'ok' as const;
}
