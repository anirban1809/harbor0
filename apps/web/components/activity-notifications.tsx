'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Bell, CheckCircle2, CircleAlert, Clock3, LoaderCircle } from 'lucide-react';
import { EmptyState } from './empty-state';
import { Button } from './ui/button';
import { Drawer } from './ui/dialog';

export type ActivityUpdate = {
  id: string;
  message: string;
  status: 'info' | 'progress' | 'success' | 'error';
  createdAt?: string;
};
type Entry = ActivityUpdate & { owner: string; time: string; read: boolean };

export function useActivityFeed(accountId?: string) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const publish = useCallback(
    (update: ActivityUpdate) => {
      if (!accountId) return;
      setEntries((previous) => {
        const current = previous.find(
          (entry) => entry.owner === accountId && entry.id === update.id,
        );
        if (current?.message === update.message && current.status === update.status)
          return previous;
        const entry: Entry = {
          ...update,
          owner: accountId,
          time: update.createdAt ?? new Date().toISOString(),
          read: false,
        };
        return [
          entry,
          ...previous.filter((item) => item.owner === accountId && item.id !== update.id),
        ]
          .sort((a, b) => b.time.localeCompare(a.time))
          .slice(0, 100);
      });
    },
    [accountId],
  );
  const markRead = useCallback(() => {
    setEntries((previous) =>
      previous.some((entry) => entry.owner === accountId && !entry.read)
        ? previous.map((entry) => (entry.owner === accountId ? { ...entry, read: true } : entry))
        : previous,
    );
  }, [accountId]);
  return { entries: entries.filter((entry) => entry.owner === accountId), publish, markRead };
}

export function ActivityNotifications({
  feed,
  onAllNotifications,
  requiredActions,
  actionCount = 0,
  open: controlledOpen,
  onOpenChange,
}: {
  feed: ReturnType<typeof useActivityFeed>;
  onAllNotifications?: () => void;
  requiredActions?: ReactNode;
  actionCount?: number;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [localOpen, setLocalOpen] = useState(false);
  const open = controlledOpen ?? localOpen;
  const setOpen = onOpenChange ?? setLocalOpen;
  const unread = feed.entries.filter((entry) => !entry.read).length;
  useEffect(() => {
    if (open && unread) feed.markRead();
  }, [open, unread, feed.markRead]);
  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="activity-trigger"
        aria-label={`Activity notifications${unread ? `, ${unread} unread` : ''}${actionCount ? `, ${actionCount} requiring attention` : ''}`}
        onClick={() => setOpen(true)}
      >
        <Bell aria-hidden="true" />
        {(unread > 0 || actionCount > 0) && <span className="activity-unread" aria-hidden="true" />}
      </Button>
      <span className="sr-only" role="status">
        {unread ? `${unread} unread activity notifications` : ''}
      </span>
      <Drawer
        open={open}
        onOpenChange={setOpen}
        className="activity-drawer"
        title="Activity"
        description="File activity, invitations, and required actions."
        closeLabel="Close activity"
        footer={
          onAllNotifications && (
            <Button
              variant="outline"
              block
              onClick={() => {
                setOpen(false);
                onAllNotifications();
              }}
            >
              All notifications
            </Button>
          )
        }
      >
        {requiredActions}
        {!feed.entries.length && !actionCount ? (
          <EmptyState
            compact
            icon={<Bell />}
            title="No activity yet"
            description="File activity and cloud copy updates will appear here."
          />
        ) : (
          <ol className="activity-list">
            {feed.entries.map((entry) => {
              const Icon =
                entry.status === 'error'
                  ? CircleAlert
                  : entry.status === 'success'
                    ? CheckCircle2
                    : entry.status === 'progress'
                      ? LoaderCircle
                      : Clock3;
              return (
                <li key={entry.id} data-status={entry.status}>
                  <Icon size={17} aria-hidden="true" />
                  <div>
                    <p>{entry.message}</p>
                    <time dateTime={entry.time}>
                      {new Date(entry.time).toLocaleString(undefined, {
                        month: 'short',
                        day: 'numeric',
                        hour: 'numeric',
                        minute: '2-digit',
                      })}
                    </time>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </Drawer>
    </>
  );
}
