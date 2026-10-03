'use client';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Button } from '../../../web/components/ui/button';
import { Card } from '../../../web/components/ui/card';
import { Skeleton } from '../../../web/components/ui/skeleton';
import { AuditList } from '../../components/audit-list';
import { PageHeader, Shell } from '../../components/shell';
import { api } from '../../lib/api';

function Audit() {
  const log = useInfiniteQuery({
    queryKey: ['audit'],
    queryFn: ({ pageParam }) => api.audit(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  return (
    <>
      <PageHeader
        title="Audit log"
        description="Every change staff make to an account, with who made it and why. Entries cannot be edited or removed."
      />
      <Card>
        {log.isPending ? (
          <Skeleton className="admin-skeleton-block" />
        ) : log.error ? (
          <p className="admin-empty">{log.error.message}</p>
        ) : (
          <AuditList items={log.data.pages.flatMap((p) => p.items)} showUser />
        )}
        {log.hasNextPage && (
          <div className="admin-more">
            <Button
              variant="outline"
              onClick={() => log.fetchNextPage()}
              disabled={log.isFetchingNextPage}
            >
              Load older entries
            </Button>
          </div>
        )}
      </Card>
    </>
  );
}

export default function Page() {
  return (
    <Shell>
      <Audit />
    </Shell>
  );
}
