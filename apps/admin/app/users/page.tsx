'use client';
import { Suspense, useEffect, useState, type FormEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useInfiniteQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, ArrowUpDown, Search, X } from 'lucide-react';
import type {
  AdminUserFilters,
  AdminUserPage,
  AdminUserSort,
} from '../../../../packages/contracts/src/admin';
import { Button } from '../../../web/components/ui/button';
import { Card } from '../../../web/components/ui/card';
import { Input, InputGroup } from '../../../web/components/ui/input';
import { Select } from '../../../web/components/ui/select';
import { DataTable } from '../../../web/components/ui/table';
import { Skeleton } from '../../../web/components/ui/skeleton';
import { PageHeader, Shell } from '../../components/shell';
import { StatusBadges } from '../../components/status-badges';
import { StorageMeter } from '../../components/storage-meter';
import { Stat } from '../../components/storage-totals';
import { api } from '../../lib/api';
import { bytes, date, relative } from '../../lib/format';

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

/** Each filter's choices, in the order the console shows them; the empty value is "any". */
const FILTERS: { key: FilterKey; label: string; options: [string, string][] }[] = [
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
  },
];

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
  for (const { key, options } of FILTERS) {
    const value = params.get(key);
    if (value && options.some(([v]) => v === value)) filters[key] = value;
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
        {FILTERS.map(({ key, label, options }) => (
          <Select
            key={key}
            aria-label={label}
            value={filters[key] ?? ''}
            active={!!filters[key]}
            onChange={(e) => setFilter(key, e.target.value)}
          >
            {options.map(([value, name]) => (
              <option key={value} value={value}>
                {name}
              </option>
            ))}
          </Select>
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
              >
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
