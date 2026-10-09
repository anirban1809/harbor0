'use client';
import { useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AdminUserFilters } from '../../../packages/contracts/src/admin';
import type { EmailGroupAddResult } from '../../../packages/contracts/src/campaigns';
import {
  DYNAMIC_GROUP_EXCLUDED_STATES,
  MAX_GROUP_ADD,
} from '../../../packages/contracts/src/campaigns';
import { Alert } from '../../web/components/ui/alert';
import { Button } from '../../web/components/ui/button';
import { Dialog, DialogActions } from '../../web/components/ui/dialog';
import { Field } from '../../web/components/ui/field';
import { Input, Textarea } from '../../web/components/ui/input';
import { Radio } from '../../web/components/ui/checkbox';
import { Select } from '../../web/components/ui/select';
import { api } from '../lib/api';
import { plural } from '../lib/format';
import { describeRule } from '../lib/user-filters';

const NEW = 'new';

/** The accounts to add: chosen rows, or everything the list's search and filters match. */
export type GroupAddition =
  | { kind: 'selected'; users: { id: string; email: string; hasProfile: boolean }[] }
  | { kind: 'matching'; count: number; rule: { q: string; filters: AdminUserFilters } };

type Done = { id: string; name: string; message: string };

/**
 * Adds accounts from the user list to an email group, new or existing. Everything the
 * filters match can instead become a dynamic group that follows them from then on.
 */
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
  const [follow, setFollow] = useState(true);
  const canFollow =
    addition?.kind === 'matching' &&
    !DYNAMIC_GROUP_EXCLUDED_STATES.includes(addition.rule.filters.state ?? '');
  const dynamic = follow && canFollow;
  // A dynamic group can take new filters; members can only be added to a fixed group.
  const choices = (groups.data?.items ?? []).filter((g) => !g.builtIn && !!g.rule === dynamic);
  const [groupId, setGroupId] = useState(NEW);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Done | null>(null);
  useEffect(() => {
    if (!open) return;
    setFollow(true);
    setGroupId(NEW);
    setName('');
    setDescription('');
    setError('');
    setDone(null);
  }, [open]);
  useEffect(() => setGroupId(NEW), [dynamic]);
  const count = addition?.kind === 'selected' ? addition.users.length : (addition?.count ?? 0);
  const added = (result: EmailGroupAddResult) =>
    `Added ${plural(result.added, 'account')}` +
    (result.alreadyMembers ? `; ${result.alreadyMembers} already in it` : '') +
    (result.unmatched.length ? `; ${result.unmatched.length} not found` : '') +
    `. It now has ${plural(result.group.memberCount, 'member')}.`;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!addition) return;
    setBusy(true);
    setError('');
    try {
      const existing = choices.find((g) => g.id === groupId);
      let next: Done;
      if (dynamic && addition.kind === 'matching') {
        const group = existing
          ? await api.saveGroup(
              existing.id,
              existing.name,
              existing.description,
              existing.updatedAt,
              addition.rule,
            )
          : await api.createGroup(name.trim(), description.trim(), addition.rule);
        next = {
          id: group.id,
          name: group.name,
          message: `${group.name} now follows these filters and has ${plural(group.memberCount, 'member')}. New matches join it as they appear.`,
        };
      } else {
        const group = existing ?? (await api.createGroup(name.trim(), description.trim()));
        let result: EmailGroupAddResult;
        if (addition.kind === 'matching')
          result = await api.addMatchingToGroup(group.id, addition.rule.q, addition.rule.filters);
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
        next = { id: group.id, name: group.name, message: `${group.name}: ${added(result)}` };
      }
      setDone(next);
      void queries.invalidateQueries({ queryKey: ['email-groups'] });
      void queries.invalidateQueries({ queryKey: ['email-group', next.id] });
      void queries.invalidateQueries({ queryKey: ['email-group-members', next.id] });
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
      title={addition?.kind === 'matching' ? 'Make an email group' : 'Add to email group'}
      description={
        addition?.kind === 'matching'
          ? `${plural(count, 'account')} match: ${describeRule(addition.rule)}.`
          : `Adds the ${plural(count, 'selected account')}.`
      }
    >
      {done ? (
        <div className="admin-dialog-form">
          <Alert tone="success">{done.message}</Alert>
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
          {addition?.kind === 'matching' && (
            <div className="admin-choices-stack" role="radiogroup" aria-label="Kind of group">
              <label className="admin-checkbox">
                <Radio
                  name="group-kind"
                  checked={dynamic}
                  disabled={!canFollow}
                  onChange={() => setFollow(true)}
                />
                <span>
                  Follow these filters
                  <span className="admin-muted">
                    {canFollow
                      ? ' — accounts join and leave as they start or stop matching, up to when a campaign sends.'
                      : " — not for unverified, disabled or never-signed-in accounts; they can't get campaigns."}
                  </span>
                </span>
              </label>
              <label className="admin-checkbox">
                <Radio name="group-kind" checked={!dynamic} onChange={() => setFollow(false)} />
                <span>
                  Only the {plural(count, 'account')} that match now
                  <span className="admin-muted"> — a fixed list you can edit by hand.</span>
                </span>
              </label>
            </div>
          )}
          <Field label="Group">
            <Select block value={groupId} onChange={(e) => setGroupId(e.target.value)}>
              <option value={NEW}>New group…</option>
              {choices.map((g) => (
                <option key={g.id} value={g.id}>
                  {`${dynamic ? `Replace the filters of ${g.name}` : g.name} (${plural(g.memberCount, 'member')})`}
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
            <Button
              type="submit"
              disabled={busy || (!count && !dynamic) || (groupId === NEW && !name.trim())}
            >
              {dynamic
                ? groupId === NEW
                  ? 'Create dynamic group'
                  : 'Replace filters'
                : `Add ${plural(count, 'account')}`}
            </Button>
          </DialogActions>
        </form>
      )}
    </Dialog>
  );
}
