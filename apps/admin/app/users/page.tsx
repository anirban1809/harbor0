'use client';
import { Suspense, useEffect, useState, type FormEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useInfiniteQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, ArrowUpDown, Search, UsersRound, X } from 'lucide-react';
import type {
  AdminUserFilters,
  AdminUserPage,
  AdminUserSort,
} from '../../../../packages/contracts/src/admin';
import { adminUserFiltersSchema } from '../../../../packages/contracts/src/admin';
import { Button } from '../../../web/components/ui/button';
import { Card } from '../../../web/components/ui/card';
import { Checkbox } from '../../../web/components/ui/checkbox';
import { Input, InputGroup } from '../../../web/components/ui/input';
import { Select } from '../../../web/components/ui/select';
import { DataTable } from '../../../web/components/ui/table';
import { Skeleton } from '../../../web/components/ui/skeleton';
import { AddToGroupDialog, type GroupAddition } from '../../components/add-to-group-dialog';
import { PageHeader, Shell, useCan } from '../../components/shell';
import { StatusBadges } from '../../components/status-badges';
import { StorageMeter } from '../../components/storage-meter';
import { Stat } from '../../components/storage-totals';
import { api } from '../../lib/api';
import { bytes, date, plural, relative } from '../../lib/format';

type SortKey = AdminUserSort['sort'];

type FilterKey = keyof AdminUserFilters;

const PLATFORM_NAMES: Record<string, string> = {
  WEB: 'Web',
  MACOS: 'Mac app',
  WINDOWS: 'Windows app',
  LINUX: 'Linux app',
  IOS: 'iOS',
  ANDROID: 'Android',
};

/** A choice that takes a number, e.g. "Inactive for N+ days" is `inactive-<N>d`. */
type CustomChoice = {
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
const FILTERS: {
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
function customValue(filter: (typeof FILTERS)[number], value: string | undefined) {
  if (!value || filter.options.some(([v]) => v === value)) return null;
  for (const choice of filter.custom ?? []) {
    if (!value.startsWith(choice.prefix) || !value.endsWith(choice.suffix)) continue;
    const n = value.slice(choice.prefix.length, value.length - choice.suffix.length || undefined);
    if (/^\d+(\.\d+)?$/.test(n)) return { choice, n };
  }
  return null;
}

/** A filter's menu, plus a number input when a custom choice is picked. */
function FilterControl({
  filter,
  value,
  onChange,
}: {
  filter: (typeof FILTERS)[number];
  value: string | undefined;
  onChange: (value: string) => void;
}) {
  const current = customValue(filter, value);
  // A custom choice picked but not yet given a number; the filter is unchanged until then.
  const [pending, setPending] = useState<CustomChoice | null>(null);
  const choice = pending ?? current?.choice ?? null;
  const [draft, setDraft] = useState(current?.n ?? '');
  useEffect(() => {
    setDraft(current?.n ?? '');
    setPending(null);
  }, [value]);
  const apply = () => {
    const n = Number(draft);
    if (!choice || !draft || !Number.isFinite(n) || n < choice.min || n > choice.max) return;
    const amount = choice.step ? String(Math.round(n * 1000) / 1000) : String(Math.round(n));
    const next = `${choice.prefix}${amount}${choice.suffix}`;
    if (next === value) setPending(null);
    else onChange(next);
  };
  return (
    <span className="admin-filter">
      <Select
        aria-label={filter.label}
        value={choice ? choice.id : (value ?? '')}
        active={!!value}
        onChange={(e) => {
          const picked = filter.custom?.find((c) => c.id === e.target.value);
          if (picked) {
            setPending(picked);
            setDraft(current?.choice.id === picked.id ? current.n : '');
          } else onChange(e.target.value);
        }}
      >
        {filter.options.map(([v, name]) => (
          <option key={v} value={v}>
            {name}
          </option>
        ))}
        {filter.custom?.map((c) => (
          <option key={c.id} value={c.id}>
            {c.label}
          </option>
        ))}
      </Select>
      {choice && (
        <form
          className="admin-filter-custom"
          onSubmit={(e) => {
            e.preventDefault();
            apply();
          }}
        >
          <Input
            type="number"
            inputMode="decimal"
            aria-label={`${choice.label.replace('…', '')} (${choice.unit})`}
            min={choice.min}
            max={choice.max}
            step={choice.step ?? 1}
            value={draft}
            autoFocus={!!pending}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={apply}
          />
          <span className="admin-muted">{choice.unit}</span>
        </form>
      )}
    </span>
  );
}

/** Combinations staff ask about often, one click each. */
const PRESETS: { label: string; filters: AdminUserFilters }[] = [
  { label: 'Signed up, never uploaded', filters: { state: 'active', storage: 'empty' } },
  { label: 'Verified, never signed in', filters: { state: 'never-signed-in' } },
  { label: 'Gone quiet', filters: { state: 'active', storage: 'uploaded', seen: 'inactive-30d' } },
  { label: 'Near their quota', filters: { state: 'active', storage: 'over-90' } },
  { label: 'New this week', filters: { joined: '7d' } },
  { label: 'Mobile, no desktop', filters: { platform: 'MOBILE', seen: '30d' } },
  { label: 'Stuck unverified', filters: { state: 'unverified', joined: 'older-90d' } },
];

function readSort(params: URLSearchParams): AdminUserSort | null {
  const sort = params.get('sort');
  if (sort !== 'created' && sort !== 'storage' && sort !== 'seen') return null;
  return { sort, order: params.get('order') === 'asc' ? 'asc' : 'desc' };
}

function readFilters(params: URLSearchParams): AdminUserFilters {
  const filters: Record<string, string> = {};
  for (const { key } of FILTERS) {
    const value = params.get(key);
    if (value && adminUserFiltersSchema.shape[key].safeParse(value).success) filters[key] = value;
  }
  return filters as AdminUserFilters;
}

const sameFilters = (a: AdminUserFilters, b: AdminUserFilters) =>
  FILTERS.every(({ key }) => (a[key] ?? '') === (b[key] ?? ''));

/** Totals across every matching account, not just the loaded page. */
function Summary({ summary }: { summary: NonNullable<AdminUserPage['summary']> }) {
  const platforms = Object.entries(summary.platforms)
    .sort(([, a], [, b]) => b - a)
    .map(([p, n]) => `${PLATFORM_NAMES[p] ?? p} ${n}`)
    .join(' · ');
  const share = (n: number) =>
    summary.accounts ? `${Math.round((n / summary.accounts) * 100)}% of matches` : undefined;
  return (
    <Card>
      <div className="admin-stats">
        <Stat label="Matching accounts" value={summary.accounts.toLocaleString()} />
        <Stat
          label="Active in 30 days"
          value={summary.active30d.toLocaleString()}
          hint={share(summary.active30d)}
        />
        <Stat
          label="Storage used"
          value={bytes(summary.usedBytes)}
          hint={`of ${bytes(summary.quotaBytes)} allocated`}
        />
        <Stat
          label="Average per account"
          value={bytes(summary.accounts ? summary.usedBytes / summary.accounts : 0)}
        />
      </div>
      <p className="admin-muted admin-totals-note">
        {platforms ? `Signed in from: ${platforms}. ` : ''}As of {relative(summary.computedAt)}; the
        list is read at most every 2 minutes.
      </p>
    </Card>
  );
}

/** A column header that sorts the list by `column`, newest or largest first on the first click. */
function SortHeader({
  column,
  label,
  current,
  onSort,
}: {
  column: SortKey;
  label: string;
  current: AdminUserSort | null;
  onSort: (sort: AdminUserSort) => void;
}) {
  const active = current?.sort === column ? current.order : null;
  const Icon = active === 'asc' ? ArrowUp : active === 'desc' ? ArrowDown : ArrowUpDown;
  return (
    <th aria-sort={active === 'asc' ? 'ascending' : active === 'desc' ? 'descending' : 'none'}>
      <button
        type="button"
        className="admin-sort"
        data-active={active ? '' : undefined}
        onClick={() => onSort({ sort: column, order: active === 'desc' ? 'asc' : 'desc' })}
      >
        {label}
        <Icon aria-hidden="true" />
      </button>
    </th>
  );
}

function Users() {
  const router = useRouter();
  const params = useSearchParams();
  const q = params.get('q') ?? '';
  const sort = readSort(params);
  const filters = readFilters(params);
  const filtering = Object.keys(filters).length > 0;
  const [draft, setDraft] = useState(q);
  useEffect(() => setDraft(q), [q]);
  const users = useInfiniteQuery({
    queryKey: ['users', q, sort?.sort, sort?.order, filters],
    queryFn: ({ pageParam }) => api.users(q, sort, pageParam, filters),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const go = (query: string, next: AdminUserSort | null, nextFilters: AdminUserFilters) => {
    const search = new URLSearchParams({
      ...(query ? { q: query } : {}),
      ...(Object.fromEntries(Object.entries(nextFilters).filter(([, v]) => v)) as Record<
        string,
        string
      >),
      ...(next ?? {}),
    });
    router.replace(`/users${search.size ? `?${search}` : ''}`);
  };
  const search = (event: FormEvent) => {
    event.preventDefault();
    go(draft.trim(), sort, filters);
  };
  const setFilter = (key: FilterKey, value: string) =>
    go(q, sort, { ...filters, [key]: value || undefined });
  const onSort = (s: AdminUserSort) => go(q, s, filters);
  const items = users.data?.pages.flatMap((p) => p.items) ?? [];
  const summary = users.data?.pages[0]?.summary ?? null;
  const canGroup = useCan('campaigns');
  const [selected, setSelected] = useState<Map<string, (typeof items)[number]>>(new Map());
  const [addition, setAddition] = useState<GroupAddition | null>(null);
  const listKey = params.toString();
  // A new search, filter or order is a new list; a selection from the last one would mislead.
  useEffect(() => setSelected(new Map()), [listKey]);
  const toggle = (user: (typeof items)[number], on: boolean) =>
    setSelected((current) => {
      const next = new Map(current);
      if (on) next.set(user.id, user);
      else next.delete(user.id);
      return next;
    });
  const allLoaded = items.length > 0 && items.every((u) => selected.has(u.id));
  const someLoaded = items.some((u) => selected.has(u.id));
  const toggleLoaded = () =>
    setSelected(allLoaded ? new Map() : new Map(items.map((u) => [u.id, u])));
  const addSelected = () =>
    setAddition({
      kind: 'selected',
      // An account without a quota has no profile yet: it never signed in.
      users: [...selected.values()].map((u) => ({
        id: u.id,
        email: u.email,
        hasProfile: u.quotaBytes !== null,
      })),
    });
  const addMatching = () =>
    summary &&
    setAddition({
      kind: 'matching',
      count: summary.accounts,
      add: (groupId) => api.addMatchingToGroup(groupId, q, filters),
    });
  const open = (id: string) => router.push(`/user?id=${encodeURIComponent(id)}`);
  return (
    <>
      <PageHeader
        title="Users"
        description="Search by email or username prefix, or paste an account ID. Filters combine."
      />
      <form className="admin-search" onSubmit={search} role="search">
        <InputGroup icon={<Search aria-hidden="true" />}>
          <Input
            placeholder="Email, username or account ID"
            aria-label="Search accounts"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            autoFocus
          />
        </InputGroup>
        <Button type="submit">Search</Button>
      </form>
      <div className="admin-filters" role="group" aria-label="Filter accounts">
        {FILTERS.map((filter) => (
          <FilterControl
            key={filter.key}
            filter={filter}
            value={filters[filter.key]}
            onChange={(value) => setFilter(filter.key, value)}
          />
        ))}
        {filtering && (
          <Button variant="ghost" size="sm" onClick={() => go(q, sort, {})}>
            <X aria-hidden="true" />
            Clear filters
          </Button>
        )}
      </div>
      <div className="admin-presets" role="group" aria-label="Common filter combinations">
        {PRESETS.map((preset) => {
          const active = filtering && sameFilters(filters, preset.filters);
          return (
            <Button
              key={preset.label}
              type="button"
              size="sm"
              variant={active ? 'primary' : 'outline'}
              aria-pressed={active}
              onClick={() => go(q, sort, active ? {} : preset.filters)}
            >
              {preset.label}
            </Button>
          );
        })}
      </div>
      {summary && <Summary summary={summary} />}
      {canGroup && (selected.size > 0 || (summary && summary.accounts > 0)) && (
        <div className="admin-selection" role="region" aria-label="Selected accounts">
          {selected.size > 0 ? (
            <>
              <strong>{plural(selected.size, 'account')} selected</strong>
              <Button size="sm" onClick={addSelected}>
                <UsersRound aria-hidden="true" />
                Add to email group
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setSelected(new Map())}>
                Clear selection
              </Button>
            </>
          ) : (
            <span className="admin-muted">Select accounts to add them to an email group.</span>
          )}
          {summary && summary.accounts > 0 && (
            <Button
              size="sm"
              variant="outline"
              className="admin-selection-all"
              onClick={addMatching}
            >
              <UsersRound aria-hidden="true" />
              Add all {summary.accounts.toLocaleString()}{' '}
              {summary.accounts === 1 ? 'match' : 'matches'} to a group
            </Button>
          )}
        </div>
      )}
      <AddToGroupDialog
        open={!!addition}
        onOpenChange={(open) => !open && setAddition(null)}
        addition={addition}
        onAdded={() => setSelected(new Map())}
      />
      {users.isPending ? (
        <Skeleton className="admin-skeleton-block" />
      ) : users.error ? (
        <p className="admin-empty">{users.error.message}</p>
      ) : !items.length ? (
        <p className="admin-empty">
          {q ? `No accounts match “${q}”` : 'No accounts match'}
          {filtering ? ' with these filters.' : '.'}
        </p>
      ) : (
        <DataTable label="Accounts">
          <thead>
            <tr>
              {canGroup && (
                <th className="admin-select-cell">
                  <Checkbox
                    aria-label="Select every loaded account"
                    checked={allLoaded}
                    ref={(el) => {
                      if (el) el.indeterminate = someLoaded && !allLoaded;
                    }}
                    onChange={toggleLoaded}
                  />
                </th>
              )}
              <th>Account</th>
              <th>Status</th>
              <th>Platforms</th>
              <SortHeader column="storage" label="Storage" current={sort} onSort={onSort} />
              <SortHeader column="seen" label="Last active" current={sort} onSort={onSort} />
              <SortHeader column="created" label="Created" current={sort} onSort={onSort} />
            </tr>
          </thead>
          <tbody>
            {items.map((u) => (
              <tr
                key={u.id}
                tabIndex={0}
                className="admin-row-link"
                onClick={() => open(u.id)}
                onKeyDown={(e) => e.key === 'Enter' && open(u.id)}
                data-selected={selected.has(u.id) ? '' : undefined}
              >
                {canGroup && (
                  <td className="admin-select-cell" onClick={(e) => e.stopPropagation()}>
                    <Checkbox
                      aria-label={`Select ${u.email}`}
                      checked={selected.has(u.id)}
                      onChange={(e) => toggle(u, e.target.checked)}
                      onKeyDown={(e) => e.stopPropagation()}
                    />
                  </td>
                )}
                <td>
                  <strong>{u.displayName ?? u.email}</strong>
                  <div className="admin-muted">
                    {u.email}
                    {u.username ? ` · @${u.username}` : ''}
                  </div>
                </td>
                <td>
                  <StatusBadges
                    status={u.status}
                    enabled={u.enabled}
                    suspended={u.suspended}
                    deleted={u.deleted}
                  />
                </td>
                <td className="admin-muted">
                  {u.platforms.length
                    ? u.platforms.map((p) => PLATFORM_NAMES[p] ?? p).join(', ')
                    : '—'}
                </td>
                <td>
                  <StorageMeter used={u.usedBytes} quota={u.quotaBytes} compact />
                </td>
                <td className="admin-nowrap" title={u.lastSeenAt ? date(u.lastSeenAt) : undefined}>
                  {relative(u.lastSeenAt)}
                </td>
                <td className="admin-nowrap">{date(u.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}
      {users.hasNextPage && (
        <div className="admin-more">
          <Button
            variant="outline"
            onClick={() => users.fetchNextPage()}
            disabled={users.isFetchingNextPage}
          >
            Load more
          </Button>
        </div>
      )}
    </>
  );
}

export default function Page() {
  return (
    <Shell>
      <Suspense>
        <Users />
      </Suspense>
    </Shell>
  );
}
