'use client';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '../../web/components/ui/button';
import { Card } from '../../web/components/ui/card';
import { Dialog, DialogActions } from '../../web/components/ui/dialog';
import { Field } from '../../web/components/ui/field';
import { Input } from '../../web/components/ui/input';
import { Skeleton } from '../../web/components/ui/skeleton';
import { MAX_BETA_CAP } from '../../../packages/contracts/src/admin';
import { api } from '../lib/api';
import { ReasonDialog } from './reason-dialog';
import { useCan } from './shell';
import { Stat } from './storage-totals';

/**
 * Beta sign-up: seats taken, links not yet used, the waitlist, opening the next wave, and
 * single-use test links that work for any email and take no seat.
 */
export function BetaCard() {
  const queries = useQueryClient();
  const canOpen = useCan('beta');
  const beta = useQuery({ queryKey: ['beta'], queryFn: () => api.beta() });
  const [open, setOpen] = useState(false);
  const [cap, setCap] = useState('');
  const [testOpen, setTestOpen] = useState(false);
  const [testUrl, setTestUrl] = useState<string>();
  const [copied, setCopied] = useState(false);
  const wave = useMutation({
    mutationFn: (reason: string) => api.openWave(Number(cap), reason),
    onSuccess: (data) => {
      queries.setQueryData(['beta'], data);
      void queries.invalidateQueries({ queryKey: ['overview'] });
    },
  });
  const testInvite = useMutation({
    mutationFn: (reason: string) => api.testInvite(reason),
    onSuccess: ({ url }) => {
      setCopied(false);
      setTestUrl(url);
    },
  });
  const data = beta.data;
  const capValue = Number(cap);
  const capValid = Number.isInteger(capValue) && capValue >= (data?.used ?? 0) && capValue >= 1;
  const room = data ? Math.max(0, capValue - data.used - data.invited) : 0;
  return (
    <Card
      title="Beta sign-up"
      description={
        data && !data.inviteRequired
          ? 'Sign-up is open to everyone; invitations are off.'
          : 'Requests get a sign-up link at once while the wave has seats and nobody is waiting.'
      }
      action={
        canOpen && (
          <div className="admin-card-actions">
            <Button size="sm" variant="outline" onClick={() => setTestOpen(true)}>
              Test sign-up link
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!data}
              onClick={() => {
                setCap(String(data!.cap));
                setOpen(true);
              }}
            >
              Open next wave
            </Button>
          </div>
        )
      }
    >
      {beta.isPending ? (
        <Skeleton className="admin-skeleton-block" />
      ) : !data ? (
        <p className="admin-empty">{beta.error?.message}</p>
      ) : (
        <div className="admin-stats">
          <Stat
            label="Joined"
            value={`${data.used.toLocaleString()} of ${data.cap.toLocaleString()}`}
            hint={data.used >= data.cap ? 'This wave is full' : 'Seats taken in this wave'}
          />
          <Stat
            label="Links not yet used"
            value={data.invited.toLocaleString()}
            hint="Sent, but no account yet"
          />
          <Stat
            label="Waitlist"
            value={data.waitlisted.toLocaleString()}
            hint="Invited in order at the next wave"
          />
          <Stat
            label="Test accounts"
            value={data.testAccounts.toLocaleString()}
            hint="Joined with a test link; no seat taken"
          />
        </div>
      )}
      <ReasonDialog
        open={open}
        onOpenChange={setOpen}
        title="Open the next beta wave"
        description="Raises the seat limit and emails sign-up links to the front of the waitlist."
        confirmLabel="Open wave"
        canSubmit={capValid}
        onConfirm={(reason) => wave.mutateAsync(reason)}
      >
        <Field
          label="Total seats"
          hint={
            capValid
              ? `${Math.min(room, data?.waitlisted ?? 0).toLocaleString()} people on the waitlist will be invited now.`
              : `At least ${(data?.used ?? 0).toLocaleString()}, the number who have joined.`
          }
        >
          <Input
            type="number"
            min={Math.max(1, data?.used ?? 0)}
            max={MAX_BETA_CAP}
            value={cap}
            onChange={(e) => setCap(e.target.value)}
            required
          />
        </Field>
      </ReasonDialog>
      <ReasonDialog
        open={testOpen}
        onOpenChange={setTestOpen}
        title="Make a test sign-up link"
        description="The link works once, for any email. The account gets beta storage and takes no seat in the wave."
        confirmLabel="Make link"
        onConfirm={(reason) => testInvite.mutateAsync(reason)}
      />
      <Dialog
        open={!!testUrl}
        onOpenChange={(value) => !value && setTestUrl(undefined)}
        title="Test sign-up link"
        description="Anyone with this link can create one account, so share it only with the tester."
      >
        <Input readOnly value={testUrl ?? ''} onFocus={(e) => e.currentTarget.select()} />
        <DialogActions>
          <Button
            variant="outline"
            onClick={() =>
              void navigator.clipboard.writeText(testUrl!).then(() => setCopied(true))
            }
          >
            {copied ? 'Copied' : 'Copy link'}
          </Button>
          <Button onClick={() => setTestUrl(undefined)}>Done</Button>
        </DialogActions>
      </Dialog>
    </Card>
  );
}
