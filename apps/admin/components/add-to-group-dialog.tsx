'use client';
import { useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { EmailGroupAddResult } from '../../../packages/contracts/src/campaigns';
import { MAX_GROUP_ADD } from '../../../packages/contracts/src/campaigns';
import { Alert } from '../../web/components/ui/alert';
import { Button } from '../../web/components/ui/button';
import { Dialog, DialogActions } from '../../web/components/ui/dialog';
import { Field } from '../../web/components/ui/field';
import { Input, Textarea } from '../../web/components/ui/input';
import { Select } from '../../web/components/ui/select';
import { api } from '../lib/api';
import { plural } from '../lib/format';

const NEW = 'new';

/** The accounts to add: chosen rows, or everything the list's search and filters match. */
export type GroupAddition =
  | { kind: 'selected'; users: { id: string; email: string; hasProfile: boolean }[] }
  | { kind: 'matching'; count: number; add: (groupId: string) => Promise<EmailGroupAddResult> };

/** Adds accounts from the user list to an email group, new or existing. */
export function AddToGroupDialog({
  open,
  onOpenChange,
  addition,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  addition: GroupAddition | null;
  onAdded?: () => void;
}) {
  const queries = useQueryClient();
  const groups = useQuery({
    queryKey: ['email-groups'],
    queryFn: api.groups,
    enabled: open,
  });
  const editable = (groups.data?.items ?? []).filter((g) => !g.builtIn);
  const [groupId, setGroupId] = useState(NEW);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{
    id: string;
    name: string;
    result: EmailGroupAddResult;
  } | null>(null);
  useEffect(() => {
    if (!open) return;
    setGroupId(NEW);
    setName('');
    setDescription('');
    setError('');
    setDone(null);
  }, [open]);
  const count = addition?.kind === 'selected' ? addition.users.length : (addition?.count ?? 0);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!addition) return;
    setBusy(true);
    setError('');
    try {
      const group =
        groupId === NEW
          ? await api.createGroup(name.trim(), description.trim())
          : editable.find((g) => g.id === groupId)!;
      let result: EmailGroupAddResult;
      if (addition.kind === 'matching') result = await addition.add(group.id);
      else {
        // Accounts that never signed in have no profile yet, so they join by their address.
        const total = { added: 0, addedEmails: 0, alreadyMembers: 0, unmatched: [] as string[] };
        let last: EmailGroupAddResult | undefined;
        for (let i = 0; i < addition.users.length; i += MAX_GROUP_ADD) {
          const chunk = addition.users.slice(i, i + MAX_GROUP_ADD);
          last = await api.addGroupMembers(group.id, {
            userIds: chunk.filter((u) => u.hasProfile).map((u) => u.id),
            identifiers: chunk.filter((u) => !u.hasProfile && u.email).map((u) => u.email),
          });
          total.added += last.added;
          total.addedEmails += last.addedEmails;
          total.alreadyMembers += last.alreadyMembers;
          total.unmatched.push(...last.unmatched);
        }
        result = { ...total, group: last!.group };
      }
      setDone({ id: group.id, name: group.name, result });
      void queries.invalidateQueries({ queryKey: ['email-groups'] });
      void queries.invalidateQueries({ queryKey: ['email-group', group.id] });
      void queries.invalidateQueries({ queryKey: ['email-group-members', group.id] });
      onAdded?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add to email group"
      description={
        addition?.kind === 'matching'
          ? `Adds the ${plural(count, 'account')} that match now. The group keeps them; it doesn't follow the filters later.`
          : `Adds the ${plural(count, 'selected account')}.`
      }
    >
      {done ? (
        <div className="admin-dialog-form">
          <Alert tone="success">
            Added {plural(done.result.added, 'account')} to {done.name}
            {done.result.alreadyMembers ? `; ${done.result.alreadyMembers} already in it` : ''}
            {done.result.unmatched.length ? `; ${done.result.unmatched.length} not found` : ''}. It
            now has {plural(done.result.group.memberCount, 'member')}.
          </Alert>
          <DialogActions>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Close
            </Button>
            <Link
              className="btn"
              data-variant="primary"
              data-size="md"
              href={`/email-groups?id=${encodeURIComponent(done.id)}`}
            >
              Open group
            </Link>
          </DialogActions>
        </div>
      ) : (
        <form className="admin-dialog-form" onSubmit={submit}>
          <Field label="Group">
            <Select block value={groupId} onChange={(e) => setGroupId(e.target.value)}>
              <option value={NEW}>New group…</option>
              {editable.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name} ({plural(g.memberCount, 'member')})
                </option>
              ))}
            </Select>
          </Field>
          {groupId === NEW && (
            <>
              <Field label="Name">
                <Input
                  required
                  maxLength={100}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoFocus
                />
              </Field>
              <Field label="Description" hint="Who is in it and why. Optional.">
                <Textarea
                  rows={2}
                  maxLength={500}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </Field>
            </>
          )}
          {error && <Alert tone="error">{error}</Alert>}
          <DialogActions>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !count || (groupId === NEW && !name.trim())}>
              Add {plural(count, 'account')}
            </Button>
          </DialogActions>
        </form>
      )}
    </Dialog>
  );
}
