'use client';
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { Alert } from '../../web/components/ui/alert';
import { Button } from '../../web/components/ui/button';
import { Card } from '../../web/components/ui/card';
import { Field } from '../../web/components/ui/field';
import { Input } from '../../web/components/ui/input';
import type { StorageTotals } from '../../../packages/contracts/src/admin';
import { api } from '../lib/api';
import { bytes } from '../lib/format';
import { ReasonDialog } from './reason-dialog';
import { useCan } from './shell';
import { Stat } from './storage-totals';

const CONFIRM = 'PURGE';

/**
 * Deleted accounts keep their files for a 30-day grace period. This ends it for all of them at
 * once, so the background worker purges their files now. Admins only; cannot be undone.
 */
export function PurgeDeletedCard({ totals }: { totals: StorageTotals | null }) {
  const queries = useQueryClient();
  const canPurge = useCan('delete');
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [done, setDone] = useState('');
  const purge = useMutation({
    mutationFn: (reason: string) => api.purgeDeletedAccounts(reason),
    onSuccess: (result) => {
      setDone(
        result.accounts
          ? `Purging ${result.accounts.toLocaleString()} account${result.accounts === 1 ? '' : 's'} (${bytes(result.usedBytes)}). Files are removed over the next few minutes.`
          : 'No deleted accounts were waiting to be purged.',
      );
      void queries.invalidateQueries({ queryKey: ['overview'] });
    },
  });
  const waiting = totals?.awaitingPurge;
  if (!canPurge || !waiting) return null;
  return (
    <Card
      title="Deleted accounts"
      description="Files of deleted accounts are kept for 30 days before they are purged."
      action={
        <Button
          size="sm"
          variant="danger"
          disabled={waiting.accounts === 0}
          onClick={() => {
            setTyped('');
            setOpen(true);
          }}
        >
          <Trash2 aria-hidden="true" />
          Purge all now
        </Button>
      }
    >
      <div className="admin-stats">
        <Stat
          label="Waiting to be purged"
          value={waiting.accounts.toLocaleString()}
          hint={`Of ${totals.deletedAccounts.toLocaleString()} deleted account${totals.deletedAccounts === 1 ? '' : 's'}`}
        />
        <Stat label="Their storage" value={bytes(waiting.usedBytes)} hint="Freed once purged" />
      </div>
      {done && (
        <Alert tone="success" role="status" className="admin-totals-note">
          {done}
        </Alert>
      )}
      <ReasonDialog
        open={open}
        onOpenChange={setOpen}
        danger
        title="Purge every deleted account now"
        description={`Ends the 30-day grace period for ${waiting.accounts.toLocaleString()} deleted account${waiting.accounts === 1 ? '' : 's'} and permanently removes their files (${bytes(waiting.usedBytes)}). Their deletion emails promised the files until the purge date. This cannot be undone.`}
        confirmLabel="Purge permanently"
        canSubmit={typed.trim() === CONFIRM}
        onConfirm={(reason) => purge.mutateAsync(reason)}
      >
        <Field label={`Type ${CONFIRM} to confirm`}>
          <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
        </Field>
      </ReasonDialog>
    </Card>
  );
}
