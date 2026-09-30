import { useCallback, useEffect, useState } from 'react';
import { Users, Folder, RefreshCw } from 'lucide-react';
import type { SyncInvitation as Invitation } from './incoming';
import { Button } from '../../web/components/ui/button';
import { Input } from '../../web/components/ui/input';
import { Dialog, DialogActions } from '../../web/components/ui/dialog';
import { Alert } from '../../web/components/ui/alert';
import { Card } from '../../web/components/ui/card';
import type { SyncFolder } from './sync-state';

const bridge = window.harbor;
export function useInvitations() {
  const [items, setItems] = useState<Invitation[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    try {
      const response = await bridge.request({ path: '/v1/sync/shares' });
      setItems(response.items);
      setError('');
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 15000);
    return () => clearInterval(timer);
  }, [load]);
  return { items, error, loading, load };
}
export function ShareSyncFolderDialog({ root, close }: { root: SyncFolder; close: () => void }) {
  const { items, error: loadError, loading, load } = useInvitations();
  const [recipient, setRecipient] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [removing, setRemoving] = useState<Invitation | null>(null);
  async function invite(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const value = recipient.trim().replace(/^@/, '');
      await bridge.request({
        path: '/v1/sync/shares',
        method: 'POST',
        body: {
          operationId: crypto.randomUUID(),
          driveItemId: root.remoteId,
          recipient: { type: value.includes('@') ? 'EMAIL' : 'USERNAME', value },
        },
      });
      setRecipient('');
      setNotice('Invitation sent. Sync starts after they accept and choose a local folder.');
      await load();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function revoke() {
    if (!removing) return;
    setBusy(true);
    setError('');
    try {
      await bridge.request({
        path: `/v1/shares/${removing.id}`,
        method: 'DELETE',
        body: { operationId: crypto.randomUUID() },
      });
      setRemoving(null);
      setNotice('Access removed. Their existing local files are preserved.');
      await load();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const members = items.filter(
    (item) => item.direction === 'SENT' && item.driveItemId === root.remoteId,
  );
  return (
    <Dialog
      open
      title={`Share “${root.localPathDisplayName}”`}
      description="Everyone you invite can add, edit, rename, and delete files. Changes sync across linked devices. Only you can manage access."
      onOpenChange={(open) => {
        if (!open && !busy) close();
      }}
    >
      <div className="sync-dialog sync-sharing-dialog">
        <form className="field" onSubmit={(event) => void invite(event)}>
          <label className="field-label" htmlFor="sync-share-recipient">
            Email or username
          </label>
          <div className="sync-share-invite">
            <Input
              id="sync-share-recipient"
              value={recipient}
              onChange={(event) => setRecipient(event.target.value)}
              placeholder="name@example.com or username"
              required
              disabled={busy}
              maxLength={254}
            />
            <Button type="submit" disabled={busy || !recipient.trim()}>
              {busy ? 'Please wait…' : 'Send invitation'}
            </Button>
          </div>
        </form>
        <p className="muted">
          Invite an existing harbor0 account. Shared files use your storage allowance while waiting
          for delivery.
        </p>
        {(error || loadError) && <Alert tone="error">{error || loadError}</Alert>}
        {notice && <Alert tone="success">{notice}</Alert>}
        <div className="sync-share-members">
          <h3>People with access</h3>
          {loading ? (
            <p className="muted">Loading access…</p>
          ) : !members.length ? (
            <p className="muted">No invitations yet.</p>
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
              Remove access for <strong>{removing.recipient.displayName}</strong>? Sync will stop on
              their devices when they reconnect. Files already downloaded will remain.
            </p>
            <DialogActions>
              <Button variant="outline" disabled={busy} onClick={() => setRemoving(null)}>
                Keep access
              </Button>
              <Button variant="danger" disabled={busy} onClick={() => void revoke()}>
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
export function AcceptSyncDialog({
  invitation,
  close,
  refresh,
}: {
  invitation: Invitation;
  close: () => void;
  refresh: () => Promise<void>;
}) {
  const [local, setLocal] = useState<Awaited<ReturnType<typeof bridge.selectSyncLocal>>>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function reject() {
    setBusy(true);
    setError('');
    try {
      await bridge.request({
        path: `/v1/sync/shares/${invitation.id}/respond`,
        method: 'POST',
        body: { action: 'DECLINED' },
      });
      await refresh();
      close();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function choose() {
    setError('');
    setBusy(true);
    try {
      const selected = await bridge.selectSyncLocal();
      if (selected) setLocal(selected);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function start() {
    if (!local) return;
    setBusy(true);
    setError('');
    try {
      await bridge.request({
        path: `/v1/sync/shares/${invitation.id}/respond`,
        method: 'POST',
        body: { action: 'ACCEPTED' },
      });
      await bridge.addSyncRoot({
        selectionId: local.selectionId,
        cloudFolderId: invitation.driveItemId,
        shareId: invitation.id,
      });
      await refresh();
      close();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      title={`Sync “${invitation.name}”`}
      description={`Shared by ${invitation.owner.displayName}. Both of you can edit these files.`}
      onOpenChange={(open) => {
        if (!open && !busy) close();
      }}
    >
      <div className="sync-dialog sync-sharing-dialog">
        <div className="sync-location-picker">
          <div>
            <span>Local folder</span>
            <strong>{local?.path ?? 'Choose a folder on this computer'}</strong>
          </div>
          <Button variant="outline" disabled={busy} onClick={() => void choose()}>
            Choose local folder
          </Button>
        </div>
        <p className="muted">
          Files already in the local folder will be shared too. Use an empty folder to start with
          the owner's files. Additions, edits, renames, and deletions sync both ways. Conflicting
          edits are preserved.
        </p>
        <p className="muted">
          The first download may wait for another linked device to come online.
        </p>
        {error && <Alert tone="error">{error}</Alert>}
        <DialogActions>
          <Button variant="outline" disabled={busy} onClick={close}>
            Cancel
          </Button>
          {invitation.syncState === 'PENDING' && (
            <Button variant="outline" disabled={busy} onClick={() => void reject()}>
              Reject
            </Button>
          )}
          <Button disabled={busy || !local} onClick={() => void start()}>
            {busy
              ? 'Starting…'
              : invitation.syncState === 'PENDING'
                ? 'Accept and start syncing'
                : 'Start syncing'}
          </Button>
        </DialogActions>
      </div>
    </Dialog>
  );
}
export function SharedSyncInvitations({
  roots,
  refresh,
  hideWhenEmpty = false,
}: {
  roots: SyncFolder[];
  refresh: () => Promise<void>;
  hideWhenEmpty?: boolean;
}) {
  const { items, error: loadError, loading, load } = useInvitations();
  const [selected, setSelected] = useState<Invitation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const invitations = items.filter(
    (item) =>
      item.direction === 'RECEIVED' && !roots.some((root) => root.remoteId === item.driveItemId),
  );
  async function decline(invitation: Invitation) {
    setBusy(true);
    setError('');
    try {
      await bridge.request({
        path: `/v1/sync/shares/${invitation.id}/respond`,
        method: 'POST',
        body: { action: 'DECLINED' },
      });
      await load();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (hideWhenEmpty && !invitations.length && !error && !loadError && !selected) return null;
  return (
    <Card
      className="sync-shared-invitations"
      aria-label="Shared sync folders"
      title={
        <span className="sync-shared-title">
          <Users size={16} aria-hidden="true" /> Shared with you
        </span>
      }
      action={
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={busy}
          onClick={() => void load()}
          aria-label="Refresh shared folders"
        >
          <RefreshCw />
        </Button>
      }
    >
      {(error || loadError) && <Alert tone="error">{error || loadError}</Alert>}
      {loading ? (
        <p className="muted">Checking invitations…</p>
      ) : !invitations.length ? (
        <p className="muted sync-share-empty">
          {items.some((item) => item.direction === 'RECEIVED')
            ? 'Your shared folders are listed above.'
            : 'Folders shared with your account will appear here.'}
        </p>
      ) : (
        invitations.map((invitation) => (
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
              {invitation.syncState === 'PENDING' && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => void decline(invitation)}
                >
                  Reject
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => setSelected(invitation)}
              >
                {invitation.syncState === 'PENDING' ? 'Accept invitation' : 'Sync on this computer'}
              </Button>
            </div>
          </div>
        ))
      )}
      {selected && (
        <AcceptSyncDialog
          invitation={selected}
          close={() => setSelected(null)}
          refresh={async () => {
            await refresh();
            await load();
          }}
        />
      )}
    </Card>
  );
}
