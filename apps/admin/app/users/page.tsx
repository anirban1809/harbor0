'use client';
import { Suspense, useEffect, useState, type FormEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { Button } from '../../../web/components/ui/button';
import { Input, InputGroup } from '../../../web/components/ui/input';
import { DataTable } from '../../../web/components/ui/table';
import { Skeleton } from '../../../web/components/ui/skeleton';
import { PageHeader, Shell } from '../../components/shell';
import { StatusBadges } from '../../components/status-badges';
import { StorageMeter } from '../../components/storage-meter';
import { api } from '../../lib/api';
import { date } from '../../lib/format';

function Users() {
  const router = useRouter();
  const params = useSearchParams();
  const q = params.get('q') ?? '';
  const [draft, setDraft] = useState(q);
  useEffect(() => setDraft(q), [q]);
  const users = useInfiniteQuery({
    queryKey: ['users', q],
    queryFn: ({ pageParam }) => api.users(q, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const search = (event: FormEvent) => {
    event.preventDefault();
    router.replace(`/users${draft.trim() ? `?q=${encodeURIComponent(draft.trim())}` : ''}`);
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
              <th>Storage</th>
              <th>Created</th>
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
