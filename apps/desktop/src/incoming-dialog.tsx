import { useState } from 'react';
import { Button } from '../../web/components/ui/button';
import { Dialog, DialogActions } from '../../web/components/ui/dialog';
import { Alert } from '../../web/components/ui/alert';
import { AcceptSyncDialog } from './sync-sharing';
import type { IncomingContent } from './incoming';

export function IncomingDialog({
  content,
  close,
  refresh,
}: {
  content: IncomingContent;
  close: () => void;
  refresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (content.kind === 'sync')
    return <AcceptSyncDialog invitation={content.item} close={close} refresh={refresh} />;
  const transfer = content.item;
  const names = transfer.displayNames?.length
    ? transfer.displayNames
    : transfer.items.filter((entry) => !entry.parentEntryId).map((entry) => entry.displayName);
  async function respond(action: 'accept' | 'decline') {
    setBusy(true);
    setError('');
    try {
      await window.harbor.request({
        path: `/v1/transfers/${transfer.id}/${action}`,
        method: 'POST',
        body: { operationId: crypto.randomUUID() },
      });
      close();
      await refresh();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      title="Content received"
      description={`From ${transfer.sender.displayName} (@${transfer.sender.username})`}
      onOpenChange={(open) => {
        if (!open && !busy) close();
      }}
    >
      <div className="sync-dialog">
        <ul className="incoming-files">
          {names.map((name, index) => (
            <li key={index}>{name}</li>
          ))}
        </ul>
        <p className="muted">Accept to download these files or save them to My Drive.</p>
        {error && <Alert tone="error">{error}</Alert>}
        <DialogActions>
          <Button variant="ghost" disabled={busy} onClick={close}>
            Later
          </Button>
          <Button variant="outline" disabled={busy} onClick={() => void respond('decline')}>
            Reject
          </Button>
          <Button disabled={busy} onClick={() => void respond('accept')}>
            {busy ? 'Please wait…' : 'Accept'}
          </Button>
        </DialogActions>
      </div>
    </Dialog>
  );
}
