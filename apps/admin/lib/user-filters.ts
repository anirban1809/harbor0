import type { AdminUserFilters } from '../../../packages/contracts/src/admin';

export type FilterKey = keyof AdminUserFilters;

export const PLATFORM_NAMES: Record<string, string> = {
  WEB: 'Web',
  MACOS: 'Mac app',
  WINDOWS: 'Windows app',
  LINUX: 'Linux app',
  IOS: 'iOS',
  ANDROID: 'Android',
};

/** A choice that takes a number, e.g. "Inactive for N+ days" is `inactive-<N>d`. */
export type CustomChoice = {
  id: string;
  label: string;
  unit: string;
  prefix: string;
  suffix: string;
  min: number;
  max: number;
  step?: number;
};
const custom = (
  id: string,
  label: string,
  unit: string,
  prefix: string,
  suffix: string,
  max: number,
  step?: number,
): CustomChoice => ({
  id: `custom:${id}`,
  label,
  unit,
  prefix,
  suffix,
  min: step ? step : 1,
  max,
  step,
});

/**
 * Each filter's choices, in the order the console shows them; the empty value is "any".
 * Custom choices take any number and show an input beside the menu.
 */
export const FILTERS: {
  key: FilterKey;
  label: string;
  options: [string, string][];
  custom?: CustomChoice[];
}[] = [
  {
    key: 'state',
    label: 'Account',
    options: [
      ['', 'Any state'],
      ['active', 'Active'],
      ['unverified', 'Email not verified'],
      ['never-signed-in', 'Never signed in'],
      ['disabled', 'Sign-in disabled'],
      ['suspended', 'Suspended'],
      ['deleted', 'Deleted'],
    ],
  },
  {
    key: 'platform',
    label: 'Platform',
    options: [
      ['', 'Any platform'],
      ...Object.entries(PLATFORM_NAMES),
      ['MOBILE', 'Any mobile'],
      ['DESKTOP', 'Any desktop app'],
      ['NONE', 'No devices'],
    ],
  },
  {
    key: 'storage',
    label: 'Storage',
    options: [
      ['', 'Any storage'],
      ['empty', 'Nothing stored'],
      ['uploaded', 'Has stored files'],
      ['over-50', 'Over 50% of quota'],
      ['over-90', 'Over 90% of quota'],
    ],
    custom: [
      custom('over', 'Over N% of quota…', '% of quota', 'over-', '', 100),
      custom('gb', 'At least N GB…', 'GB', 'gb-', '', 999999, 0.001),
    ],
  },
  {
    key: 'quota',
    label: 'Quota',
    options: [
      ['', 'Any quota'],
      ['standard', 'Sign-up quota'],
      ['raised', 'Raised by staff'],
    ],
  },
  {
    key: 'seen',
    label: 'Last active',
    options: [
      ['', 'Any activity'],
      ['1d', 'Active today'],
      ['7d', 'Active in 7 days'],
      ['30d', 'Active in 30 days'],
      ['inactive-30d', 'Inactive 30+ days'],
      ['never', 'Never active'],
    ],
    custom: [
      custom('seen', 'Active within N days…', 'days', '', 'd', 9999),
      custom('inactive', 'Inactive for N+ days…', 'days', 'inactive-', 'd', 9999),
    ],
  },
  {
    key: 'joined',
    label: 'Joined',
    options: [
      ['', 'Joined any time'],
      ['1d', 'Joined today'],
      ['7d', 'Joined in 7 days'],
      ['30d', 'Joined in 30 days'],
      ['90d', 'Joined in 90 days'],
      ['older-90d', 'Joined 90+ days ago'],
    ],
    custom: [
      custom('joined', 'Joined within N days…', 'days', '', 'd', 9999),
      custom('older', 'Joined over N days ago…', 'days', 'older-', 'd', 9999),
    ],
  },
];

/** The custom choice a stored value belongs to, and its number: `inactive-45d` → 45. */
export function customValue(filter: (typeof FILTERS)[number], value: string | undefined) {
  if (!value || filter.options.some(([v]) => v === value)) return null;
  for (const choice of filter.custom ?? []) {
    if (!value.startsWith(choice.prefix) || !value.endsWith(choice.suffix)) continue;
    const n = value.slice(choice.prefix.length, value.length - choice.suffix.length || undefined);
    if (/^\d+(\.\d+)?$/.test(n)) return { choice, n };
  }
  return null;
}

/** One filter's value as a phrase, e.g. "Inactive for 45+ days" or "Over 75% of quota". */
export function describeFilter(key: FilterKey, value: string) {
  const filter = FILTERS.find((f) => f.key === key)!;
  const preset = filter.options.find(([v]) => v === value);
  if (preset) return preset[1];
  const custom = customValue(filter, value);
  return custom ? custom.choice.label.replace('N', custom.n).replace('…', '') : value;
}

/** A search and filters as a sentence, e.g. "Active · Android · Inactive for 45+ days". */
export function describeRule(rule: { q: string; filters: AdminUserFilters }) {
  const parts = FILTERS.filter(({ key }) => rule.filters[key]).map(({ key }) =>
    describeFilter(key, rule.filters[key]!),
  );
  if (rule.q) parts.unshift(`Email or username starts with “${rule.q}”`);
  return parts.length ? parts.join(' · ') : 'Every account';
}

/** The Users page showing this search and these filters. */
export function usersHref(rule: { q: string; filters: AdminUserFilters }) {
  const search = new URLSearchParams({
    ...(rule.q ? { q: rule.q } : {}),
    ...(Object.fromEntries(Object.entries(rule.filters).filter(([, v]) => v)) as Record<
      string,
      string
    >),
  });
  return `/users${search.size ? `?${search}` : ''}`;
}
