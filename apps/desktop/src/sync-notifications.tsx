import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bell, Folder, X } from 'lucide-react';
import {
  ActivityNotifications,
  type useActivityFeed,
} from '../../web/components/activity-notifications';
import { Button } from '../../web/components/ui/button';
import { Alert } from '../../web/components/ui/alert';
import {
  AddSyncFolderDialog,
  ConflictDialog,
  FolderSettingsDialog,
  StopSyncDialog,
  SyncProblem,
} from './sync-page';
import { AcceptSyncDialog, useInvitations } from './sync-sharing';
import type { SyncInvitation } from './incoming';
import {
  syncRequirements,
  type SyncFolder,
  type SyncIssue,
  type SyncJob,
  type SyncRuntime,
} from './sync-state';

const bridge = window.harbor;

export { syncRequirements };

export function SyncNotifications({
  feed,
  roots,
  state,
  jobs,
  refresh,
  showBanner,
  manageFolders,
  manageStorage,
}: {
  feed: ReturnType<typeof useActivityFeed>;
  roots: SyncFolder[];
  state: SyncRuntime;
  jobs: SyncJob[];
  refresh: () => Promise<void>;
  showBanner: boolean;
  manageFolders: () => void;
  manageStorage: () => void;
}) {
  const invitations = useInvitations();
  const pending = invitations.items.filter(
    (item) =>
      item.direction === 'RECEIVED' &&
      ['PENDING', 'ACCEPTED'].includes(item.syncState ?? '') &&
      !roots.some((root) => root.remoteId === item.driveItemId),
  );
  const issues = syncRequirements(roots, state, jobs);
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<{ mode: string; root: SyncFolder } | null>(null);
  const [conflict, setConflict] = useState<SyncIssue | null>(null);
  const [invitation, setInvitation] = useState<SyncInvitation | null>(null);
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const publish = feed.publish;
  useEffect(() => {
    for (const item of state.recent ?? []) {
      publish({
        id: `sync:${item.id}`,
        message: `${item.direction === 'upload' ? 'Uploaded' : 'Downloaded'} ${item.relativePath}`,
        status: 'success',
        createdAt: item.at,
      });
    }
  }, [state.recent, publish]);
  function action(mode: string, root: SyncFolder) {
    setOpen(false);
    setDialog({ mode, root });
  }
  async function run(task: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await task();
      await refresh();
      await invitations.load();
    } catch (cause) {
      setError((cause as Error).message);
      setOpen(true);
    } finally {
      setBusy(false);
    }
  }
  const problem = (issue: SyncIssue) => (
    <SyncProblem
      key={issue.id}
      issue={issue}
      root={roots.find((root) => root.id === issue.rootId)}
      action={action}
      review={(item) => {
        setOpen(false);
        setConflict(item);
      }}
      storage={() => {
        setOpen(false);
        manageStorage();
      }}
      manageFolders={() => {
        setOpen(false);
        manageFolders();
      }}
    />
  );
  const invite = (item: SyncInvitation) => (
    <article className="sync-notification-invite" key={item.id}>
      <Folder size={16} aria-hidden="true" />
      <div>
        <h3>{item.name}</h3>
        <p>
          From {item.owner.displayName} (@{item.owner.username}) · Two-way sync
        </p>
        <div className="sync-problem-actions">
          {item.syncState === 'PENDING' && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() =>
                void run(() =>
                  bridge.request({
                    path: `/v1/sync/shares/${item.id}/respond`,
                    method: 'POST',
                    body: { action: 'DECLINED' },
                  }),
                )
              }
            >
              Reject
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => {
              setOpen(false);
              setInvitation(item);
            }}
          >
            {item.syncState === 'PENDING' ? 'Accept invitation' : 'Sync on this computer'}
          </Button>
        </div>
      </div>
    </article>
  );
  const count = issues.length + pending.length + (error || invitations.error ? 1 : 0);
  const bannerIssue = issues.find(
    (issue) => !dismissed.includes(`issue:${issue.id}:${issue.code}`),
  );
  const bannerInvite = pending.find(
    (item) => !dismissed.includes(`invite:${item.id}:${item.syncState}`),
  );
  const bannerKey = bannerIssue
    ? `issue:${bannerIssue.id}:${bannerIssue.code}`
    : bannerInvite
      ? `invite:${bannerInvite.id}:${bannerInvite.syncState}`
      : '';
  return (
    <>
      <ActivityNotifications
        feed={feed}
        open={open}
        onOpenChange={setOpen}
        actionCount={count}
        requiredActions={
          <>
            {(error || invitations.error) && (
              <Alert
                tone="error"
                className="sync-notification-error"
                action={
                  <Button variant="link" disabled={busy} onClick={() => void run(invitations.load)}>
                    Try again
                  </Button>
                }
              >
                {error || invitations.error}
              </Alert>
            )}
            {!!issues.length && (
              <section aria-label="Needs attention" className="sync-notification-requirements">
                <h2>Needs attention</h2>
                {issues.map(problem)}
              </section>
            )}
            {!!pending.length && (
              <section aria-label="Sync invitations" className="sync-notification-requirements">
                <h2>Sync invitations</h2>
                {pending.map(invite)}
              </section>
            )}
          </>
        }
      />
      {showBanner &&
        !open &&
        !dialog &&
        !conflict &&
        !invitation &&
        bannerKey &&
        createPortal(
          <section
            className="floating-card status-card sync-action-banner"
            aria-label="Sync action required"
          >
            <div className="status-card-heading">
              <Bell size={16} aria-hidden="true" />
              <strong>Sync needs your attention</strong>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Dismiss sync banner"
                onClick={() => setDismissed((previous) => [...previous, bannerKey])}
              >
                <X />
              </Button>
            </div>
            {bannerIssue ? problem(bannerIssue) : bannerInvite ? invite(bannerInvite) : null}
            <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
              View all notifications{count > 1 ? ` (${count})` : ''}
            </Button>
          </section>,
          document.body,
        )}
      {dialog?.mode === 'mapping' && (
        <AddSyncFolderDialog root={dialog.root} close={() => setDialog(null)} refresh={refresh} />
      )}
      {dialog?.mode === 'stop' && (
        <StopSyncDialog root={dialog.root} close={() => setDialog(null)} refresh={refresh} />
      )}
      {dialog && !['mapping', 'stop'].includes(dialog.mode) && (
        <FolderSettingsDialog
          root={dialog.root}
          mode={dialog.mode}
          close={() => setDialog(null)}
          refresh={refresh}
        />
      )}
      {conflict && (
        <ConflictDialog issue={conflict} close={() => setConflict(null)} refresh={refresh} />
      )}
      {invitation && (
        <AcceptSyncDialog
          invitation={invitation}
          close={() => setInvitation(null)}
          refresh={async () => {
            await refresh();
            await invitations.load();
          }}
        />
      )}
    </>
  );
}
