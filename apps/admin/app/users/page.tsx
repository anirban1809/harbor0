'use client';
import { Suspense, useEffect, useState, type FormEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useInfiniteQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, ArrowUpDown, Search } from 'lucide-react';
import type { AdminUserSort } from '../../../../packages/contracts/src/admin';
import { Button } from '../../../web/components/ui/button';
import { Input, InputGroup } from '../../../web/components/ui/input';
import { DataTable } from '../../../web/components/ui/table';
import { Skeleton } from '../../../web/components/ui/skeleton';
import { PageHeader, Shell } from '../../components/shell';
import { StatusBadges } from '../../components/status-badges';
import { StorageMeter } from '../../components/storage-meter';
import { api } from '../../lib/api';
import { date } from '../../lib/format';

type SortKey = AdminUserSort['sort'];

function readSort(params: URLSearchParams): AdminUserSort | null {
  const sort = params.get('sort');
  if (sort !== 'created' && sort !== 'storage') return null;
  return { sort, order: params.get('order') === 'asc' ? 'asc' : 'desc' };
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
  const [draft, setDraft] = useState(q);
  useEffect(() => setDraft(q), [q]);
  const users = useInfiniteQuery({
    queryKey: ['users', q, sort?.sort, sort?.order],
    queryFn: ({ pageParam }) => api.users(q, sort, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const go = (query: string, next: AdminUserSort | null) => {
    const search = new URLSearchParams({ ...(query ? { q: query } : {}), ...(next ?? {}) });
    router.replace(`/users${search.size ? `?${search}` : ''}`);
  };
  const search = (event: FormEvent) => {
    event.preventDefault();
    go(draft.trim(), sort);
  };
  const items = users.data?.pages.flatMap((p) => p.items) ?? [];
  const open = (id: string) => router.push(`/user?id=${encodeURIComponent(id)}`);
  return (
    <>
      <PageHeader
        title="Users"
        description="Search by email or username prefix, or paste an account ID."
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
      {users.isPending ? (
        <Skeleton className="admin-skeleton-block" />
      ) : users.error ? (
        <p className="admin-empty">{users.error.message}</p>
      ) : !items.length ? (
        <p className="admin-empty">No accounts match “{q}”.</p>
      ) : (
        <DataTable label="Accounts">
          <thead>
            <tr>
              <th>Account</th>
              <th>Username</th>
              <th>Status</th>
              <SortHeader
                column="storage"
                label="Storage"
                current={sort}
                onSort={(s) => go(q, s)}
              />
              <SortHeader
                column="created"
                label="Created"
                current={sort}
                onSort={(s) => go(q, s)}
              />
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
                  <div className="admin-muted">{u.email}</div>
                </td>
                <td>{u.username ? `@${u.username}` : '—'}</td>
                <td>
                  <StatusBadges
                    status={u.status}
                    enabled={u.enabled}
                    suspended={u.suspended}
                    deleted={u.deleted}
                  />
                </td>
                <td>
                  <StorageMeter used={u.usedBytes} quota={u.quotaBytes} compact />
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
