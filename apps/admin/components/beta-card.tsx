'use client';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '../../web/components/ui/button';
import { Card } from '../../web/components/ui/card';
import { Field } from '../../web/components/ui/field';
import { Input } from '../../web/components/ui/input';
import { Skeleton } from '../../web/components/ui/skeleton';
import { MAX_BETA_CAP } from '../../../packages/contracts/src/admin';
import { api } from '../lib/api';
import { ReasonDialog } from './reason-dialog';
import { useCan } from './shell';
import { Stat } from './storage-totals';

/** Beta sign-up: seats taken, links not yet used, the waitlist, and opening the next wave. */
export function BetaCard() {
  const queries = useQueryClient();
  const canOpen = useCan('beta');
  const beta = useQuery({ queryKey: ['beta'], queryFn: () => api.beta() });
  const [open, setOpen] = useState(false);
  const [cap, setCap] = useState('');
  const wave = useMutation({
    mutationFn: (reason: string) => api.openWave(Number(cap), reason),
    onSuccess: (data) => {
      queries.setQueryData(['beta'], data);
      void queries.invalidateQueries({ queryKey: ['overview'] });
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
    </Card>
  );
}
