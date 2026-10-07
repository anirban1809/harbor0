// Storage is sold in decimal units (100 GB = 100,000,000,000 bytes), so the console uses them too.
const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
export function bytes(value: number | null | undefined) {
  if (value == null) return '—';
  let n = value;
  let unit = 0;
  while (n >= 1000 && unit < units.length - 1) {
    n /= 1000;
    unit++;
  }
  return `${n >= 100 || unit === 0 ? Math.round(n) : n.toFixed(n >= 10 ? 1 : 2).replace(/\.?0+$/, '')} ${units[unit]}`;
}
export const GB = 1_000_000_000;
export const TB = 1_000_000_000_000;

export function date(value: string | null | undefined) {
  if (!value) return '—';
  return new Date(value).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}
export function relative(value: string | null | undefined) {
  if (!value) return '—';
  const seconds = Math.round((Date.now() - Date.parse(value)) / 1000);
  const steps: [number, Intl.RelativeTimeFormatUnit][] = [
    [60, 'second'],
    [60, 'minute'],
    [24, 'hour'],
    [30, 'day'],
    [12, 'month'],
    [Infinity, 'year'],
  ];
  let n = seconds;
  for (const [size, unit] of steps) {
    if (Math.abs(n) < size)
      return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(
        -Math.round(n),
        unit,
      );
    n /= size;
  }
  return date(value);
}

/** Plain-language labels for audit actions. */
export const actionLabels: Record<string, string> = {
  QUOTA_CHANGED: 'Changed storage limit',
  PASSWORD_RESET: 'Reset password',
  VERIFICATION_RESENT: 'Resent verification email',
  EMAIL_CONFIRMED: 'Confirmed email',
  SIGNED_OUT_EVERYWHERE: 'Signed out everywhere',
  DEVICE_SIGNED_OUT: 'Signed out a device',
  SUSPENDED: 'Suspended account',
  UNSUSPENDED: 'Restored account',
  ACCOUNT_DELETED: 'Deleted account',
  ACCOUNT_PURGED: 'Purged deleted account now',
  NOTE: 'Added a note',
  BETA_WAVE: 'Opened a beta wave',
  FLAG_CHANGED: 'Changed a feature flag',
  FLAG_USER_ADDED: 'Turned on a feature flag',
  FLAG_USER_REMOVED: 'Took off a feature flag',
};
export const flagModeLabels = { OFF: 'Off', TARGETED: 'Targeted', ON: 'On for everyone' } as const;
/** Roughly how many accounts a targeted flag reaches: the list plus a share of the rest. */
export function flagReach(
  flag: { mode: keyof typeof flagModeLabels; userIds: string[]; percent: number },
  accounts: number | null,
) {
  if (flag.mode === 'OFF') return 'No one';
  if (flag.mode === 'ON') return 'Everyone';
  const listed = flag.userIds.length;
  const people = `${listed} account${listed === 1 ? '' : 's'}`;
  if (!flag.percent) return people;
  if (accounts === null) return `${people} + ${flag.percent}%`;
  const total = Math.min(
    accounts,
    Math.round(listed + (Math.max(0, accounts - listed) * flag.percent) / 100),
  );
  return `${people} + ${flag.percent}% (about ${total.toLocaleString()} of ${accounts.toLocaleString()})`;
}
