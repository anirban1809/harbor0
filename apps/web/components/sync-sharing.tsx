'use client';
import { useCallback, useEffect, useState } from 'react';
import { Folder, FolderSync, UserPlus, Users } from 'lucide-react';
import type { ShareGrant, SyncFolderItem } from '@harbor/contracts';
import { Button } from './ui/button';
import { Dialog, DialogActions } from './ui/dialog';
import { Alert } from './ui/alert';
import { Badge } from './ui/badge';
import { Card } from './ui/card';
import { RecipientPicker } from './recipient-picker';

/** A two-way sync invitation, as listed by `GET /v1/sync/shares`. */
export type SyncInvitation = ShareGrant & {
  name: string;
  direction: 'SENT' | 'RECEIVED';
  owner: { username: string; displayName: string };
  recipient: { username: string; displayName: string };
};
type Request = (path: string, init?: { method?: string; body?: unknown }) => Promise<any>;

const active = (item: SyncInvitation) => !item.revokedAt && item.syncState !== 'DECLINED';
const people = (value: number) => (value === 1 ? '1 person' : `${value} people`);

export function useSyncInvitations(request: Request) {
  const [items, setItems] = useState<SyncInvitation[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    try {
      const response: { items: SyncInvitation[] } = await request('/v1/sync/shares');
      setItems(response.items);
      setError('');
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setLoading(false);
    }
  }, [request]);
  useEffect(() => {
    void load();
  }, [load]);
  return { items, error, loading, load };
}

/** Invite other accounts to sync a folder both ways, and remove their access. Owner only. */
export function SyncShareDialog({
  request,
  folder,
  close,
  onChanged,
}: {
  request: Request;
  folder: { id: string; name: string };
  close: () => void;
  onChanged?: () => void;
}) {
  const { items, error: loadError, loading, load } = useSyncInvitations(request);
  const [form, setForm] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [removing, setRemoving] = useState<SyncInvitation | null>(null);
  async function act(task: () => Promise<unknown>, done: string) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await task();
      setNotice(done);
      await load();
      onChanged?.();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function invite(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = String(new FormData(event.currentTarget).get('recipient') ?? '')
      .trim()
      .replace(/^@/, '');
    if (!value) return;
    void act(async () => {
      await request('/v1/sync/shares', {
        method: 'POST',
        body: {
          operationId: crypto.randomUUID(),
          driveItemId: folder.id,
          recipient: { type: value.includes('@') ? 'EMAIL' : 'USERNAME', value },
        },
      });
      setForm((value) => value + 1);
    }, 'Invitation sent. Sync starts once they accept and choose a folder on their computer.');
  }
  function revoke(member: SyncInvitation) {
    void act(async () => {
      await request(`/v1/shares/${encodeURIComponent(member.id)}`, {
        method: 'DELETE',
        body: { operationId: crypto.randomUUID() },
      });
      setRemoving(null);
    }, 'Access removed. Files already on their devices stay there.');
  }
  const members = items.filter(
    (item) => item.direction === 'SENT' && item.driveItemId === folder.id && active(item),
  );
  return (
    <Dialog
      open
      title={`Share “${folder.name}”`}
      description="Everyone you invite can add, edit, rename, and delete files, and changes sync both ways across everyone’s devices. Only you can manage access."
      onOpenChange={(open) => {
        if (!open && !busy) close();
      }}
    >
      <div className="sync-dialog sync-sharing-dialog">
        <form className="sync-share-invite" onSubmit={invite}>
          <RecipientPicker key={form} autoFocus={!form} search={(path) => request(path)} />
          <Button type="submit" disabled={busy}>
            {busy ? 'Please wait…' : 'Send invitation'}
          </Button>
        </form>
        <p className="muted">
          Invite an existing harbor0 account. Shared files count against your storage.
        </p>
        {(error || loadError) && <Alert tone="error">{error || loadError}</Alert>}
        {notice && <Alert tone="success">{notice}</Alert>}
        <div className="sync-share-members">
          <h3>People with access</h3>
          {loading ? (
            <p className="muted">Loading access…</p>
          ) : !members.length ? (
            <p className="muted">Only you so far.</p>
          ) : (
            members.map((member) => (
              <div className="list-row sync-share-person" key={member.id}>
                <div className="list-row-text">
                  <strong>{member.recipient.displayName}</strong>
                  <span>
                    @{member.recipient.username} ·{' '}
                    {member.syncState === 'PENDING' ? 'Invited' : 'Can edit and sync'}
                  </span>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    setRemoving(member);
                    setNotice('');
                  }}
                >
                  Remove access
                </Button>
              </div>
            ))
          )}
        </div>
        {removing && (
          <div className="sync-share-confirm" role="group" aria-label="Confirm removal">
            <p>
              Remove access for <strong>{removing.recipient.displayName}</strong>? Sync stops on
              their devices when they reconnect. Files already downloaded stay.
            </p>
            <DialogActions>
              <Button variant="outline" disabled={busy} onClick={() => setRemoving(null)}>
                Keep access
              </Button>
              <Button variant="danger" disabled={busy} onClick={() => revoke(removing)}>
                Remove access
              </Button>
            </DialogActions>
          </div>
        )}
        <DialogActions>
          <Button variant="outline" disabled={busy} onClick={close}>
            Done
          </Button>
        </DialogActions>
      </div>
    </Dialog>
  );
}

/** The sync status and sharing of a synced folder, shown above its files in My Drive. */
export function SyncedFolderPanel({
  request,
  folder,
  userId,
}: {
  request: Request;
  folder: SyncFolderItem;
  userId: string;
}) {
  const { items, load } = useSyncInvitations(request);
  const [sharing, setSharing] = useState(false);
  const owned = folder.ownerUserId === userId;
  const members = items.filter((item) => item.driveItemId === folder.id && active(item));
  const owner = members.find((item) => item.direction === 'RECEIVED')?.owner;
  const devices = folder.syncDevices.map((device) => device.name);
  const invited = members.filter((item) => item.direction === 'SENT').length;
  return (
    <div className="folder-panel">
      <Card className="backup-summary" aria-label={`${folder.name} sync`}>
        <div className="backup-summary-main">
          <span className="icon-tile" aria-hidden="true">
            <FolderSync />
          </span>
          <div>
            <div className="backup-summary-title">
              <h2>Synced folder</h2>
              {!owned && <Badge>Shared with you</Badge>}
            </div>
            <p>
              {devices.length ? `Synced on ${devices.join(', ')}` : 'Not synced on any device'}
              {owned
                ? invited
                  ? ` · Shared with ${people(invited)}`
                  : ''
                : owner
                  ? ` · Owned by ${owner.displayName}`
                  : ''}
            </p>
          </div>
        </div>
        {owned && (
          <div className="backup-actions backup-summary-actions">
            <Button size="sm" variant="outline" onClick={() => setSharing(true)}>
              <UserPlus />
              Share
            </Button>
          </div>
        )}
      </Card>
      {sharing && (
        <SyncShareDialog
          request={request}
          folder={folder}
          close={() => setSharing(false)}
          onChanged={() => void load()}
        />
      )}
    </div>
  );
}

/**
 * Folders other accounts invited you to sync. Accepting here only answers the invitation;
 * a computer or phone then chooses where the folder lives on it.
 */
export function SyncInvitations({ request }: { request: Request }) {
  const { items, error: loadError, load } = useSyncInvitations(request);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const pending = items.filter(
    (item) => item.direction === 'RECEIVED' && item.syncState === 'PENDING' && !item.revokedAt,
  );
  async function respond(invitation: SyncInvitation, action: 'ACCEPTED' | 'DECLINED') {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await request(`/v1/sync/shares/${encodeURIComponent(invitation.id)}/respond`, {
        method: 'POST',
        body: { action },
      });
      setNotice(
        action === 'ACCEPTED'
          ? `Accepted. Open harbor0 on your computer or phone to choose where “${invitation.name}” syncs.`
          : `Declined “${invitation.name}”.`,
      );
      await load();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!pending.length && !error && !loadError && !notice) return null;
  return (
    <Card
      className="sync-shared-invitations"
      aria-label="Folders shared for sync"
      title={
        <span className="sync-shared-title">
          <Users size={16} aria-hidden="true" /> Folders to sync
        </span>
      }
    >
      {(error || loadError) && <Alert tone="error">{error || loadError}</Alert>}
      {notice && <Alert tone="success">{notice}</Alert>}
      {pending.map((invitation) => (
        <div className="list-row sync-share-person" key={invitation.id}>
          <span className="file-entry-icon" data-kind="folder">
            <Folder aria-hidden="true" />
          </span>
          <div className="list-row-text">
            <strong>{invitation.name}</strong>
            <span>
              From {invitation.owner.displayName} (@{invitation.owner.username}) · Two-way sync
            </span>
          </div>
          <div className="list-row-actions sync-share-buttons">
            <Button
              size="sm"
              disabled={busy}
              onClick={() => void respond(invitation, 'ACCEPTED')}
            >
              Accept
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void respond(invitation, 'DECLINED')}
            >
              Decline
            </Button>
          </div>
        </div>
      ))}
    </Card>
  );
}
