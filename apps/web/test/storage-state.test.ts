import { expect, it } from 'vitest';
import { storageState } from '../lib/storage-state';

const storage = (used: number, quota: number) => ({
  quotaBytes: quota,
  usedBytes: used,
  reservedBytes: 0,
  availableBytes: Math.max(0, quota - used),
});

it('calls storage full when hardly anything fits, not only at exactly 100%', () => {
  // 586 bytes left of 25 MB: full, not "running low".
  expect(storageState(storage(24_999_414, 25_000_000))).toBe('full');
  expect(storageState(storage(25_000_000, 25_000_000))).toBe('full');
  expect(storageState(storage(26_000_000, 25_000_000))).toBe('over');
  // 96% used, with 1 MB left: running low.
  expect(storageState(storage(24_000_000, 25_000_000))).toBe('low');
  expect(storageState(storage(10_000_000, 25_000_000))).toBe('ok');
  // A big account is full with under 1 MB left, whatever the percentage.
  expect(storageState(storage(50e9 - 500_000, 50e9))).toBe('full');
  expect(storageState(storage(50e9 - 5_000_000, 50e9))).toBe('low');
});
