'use client';
import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { Button } from '../../web/components/ui/button';
import { Card } from '../../web/components/ui/card';
import { Input, InputGroup } from '../../web/components/ui/input';
import { AuditList } from '../components/audit-list';
import { StorageTotalsCard } from '../components/storage-totals';
import { Skeleton } from '../../web/components/ui/skeleton';
import { PageHeader, Shell } from '../components/shell';
import { api } from '../lib/api';

function Overview() {
  const router = useRouter();
  const [q, setQ] = useState('');
  const queries = useQueryClient();
  const overview = useQuery({ queryKey: ['overview'], queryFn: () => api.overview() });
  const refresh = useMutation({
    mutationFn: () => api.overview(true),
    onSuccess: (data) => queries.setQueryData(['overview'], data),
  });
  const find = (event: FormEvent) => {
    event.preventDefault();
    router.push(`/users?q=${encodeURIComponent(q.trim())}`);
  };
  return (
    <>
      <PageHeader
        title="Overview"
        description="Find an account to help someone, or review recent staff activity."
      />
      <form className="admin-search" onSubmit={find} role="search">
        <InputGroup icon={<Search aria-hidden="true" />}>
          <Input
            size="lg"
            placeholder="Email, username or account ID"
            aria-label="Find an account"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            autoFocus
          />
        </InputGroup>
        <Button type="submit" size="lg">
          Find
        </Button>
      </form>
      <StorageTotalsCard
        totals={overview.data?.storage ?? null}
        estimatedUsers={overview.data?.estimatedUsers ?? null}
        pending={overview.isPending}
        refreshing={refresh.isPending}
        onRefresh={() => refresh.mutate()}
      />
      <Card
        title="Recent activity"
        description="Changes made by staff, newest first."
        action={
          <Link className="btn" data-variant="outline" data-size="sm" href="/audit">
            Full audit log
          </Link>
        }
      >
        {overview.isPending ? (
          <Skeleton className="admin-skeleton-block" />
        ) : overview.error ? (
          <p className="admin-empty">{overview.error.message}</p>
        ) : (
          <AuditList items={overview.data.recent} showUser />
        )}
      </Card>
    </>
  );
}

export default function Page() {
  return (
    <Shell>
      <Overview />
    </Shell>
  );
}
