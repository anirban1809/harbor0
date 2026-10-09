'use client';
import { Suspense, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Plus, Trash2, UserPlus } from 'lucide-react';
import type { EmailGroup } from '../../../../packages/contracts/src/campaigns';
import { EVERYONE_GROUP, MAX_GROUP_ADD } from '../../../../packages/contracts/src/campaigns';
import { Badge } from '../../../web/components/ui/badge';
import { Alert } from '../../../web/components/ui/alert';
import { Button } from '../../../web/components/ui/button';
import { Card } from '../../../web/components/ui/card';
import { Dialog, DialogActions } from '../../../web/components/ui/dialog';
import { Field } from '../../../web/components/ui/field';
import { Input, Textarea } from '../../../web/components/ui/input';
import { Skeleton } from '../../../web/components/ui/skeleton';
import { DataTable } from '../../../web/components/ui/table';
import { AuditList } from '../../components/audit-list';
import { EmailNav } from '../../components/email-nav';
import { PageHeader, Shell, useCan } from '../../components/shell';
import { api } from '../../lib/api';
import { plural, relative } from '../../lib/format';
import { describeRule, usersHref } from '../../lib/user-filters';

function GroupForm({
  group,
  onDone,
  onCancel,
}: {
  group?: EmailGroup;
  onDone: (group: EmailGroup) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(group?.name ?? '');
  const [description, setDescription] = useState(group?.description ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      onDone(
        group
          ? await api.saveGroup(group.id, name.trim(), description.trim(), group.updatedAt)
          : await api.createGroup(name.trim(), description.trim()),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="admin-dialog-form" onSubmit={submit}>
      <Field label="Name">
        <Input required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Description" hint="Who is in it and why. Optional.">
        <Textarea
          rows={2}
          maxLength={500}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </Field>
      {error && <Alert tone="error">{error}</Alert>}
      <DialogActions>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy || !name.trim()}>
          {group ? 'Save' : 'Create group'}
        </Button>
      </DialogActions>
    </form>
  );
}

function GroupList() {
  const router = useRouter();
  const queries = useQueryClient();
  const canEdit = useCan('campaigns');
  const [creating, setCreating] = useState(false);
  const groups = useQuery({ queryKey: ['email-groups'], queryFn: api.groups });
  const open = (id: string) => router.push(`/email-groups?id=${encodeURIComponent(id)}`);
  return (
    <>
      <PageHeader
        title="Email campaigns"
        description="Write an email once and send it to groups of accounts, now or at a set time."
        action={
          canEdit && (
            <Button onClick={() => setCreating(true)}>
              <Plus aria-hidden="true" />
              New group
            </Button>
          )
        }
      />
      <EmailNav />
      {groups.isPending ? (
        <Skeleton className="admin-skeleton-block" />
      ) : groups.error ? (
        <p className="admin-empty">{groups.error.message}</p>
      ) : !groups.data.items.length ? (
        <p className="admin-empty">No groups yet. A group is a named list of accounts to email.</p>
      ) : (
        <DataTable label="Groups">
          <thead>
            <tr>
              <th>Group</th>
              <th>Accounts</th>
              <th>Last changed</th>
            </tr>
          </thead>
          <tbody>
            {groups.data.items.map((g) => (
              <tr
                key={g.id}
                tabIndex={0}
                className="admin-row-link"
                onClick={() => open(g.id)}
                onKeyDown={(e) => e.key === 'Enter' && open(g.id)}
              >
                <td>
                  <span className="admin-title-row">
                    <strong>{g.name}</strong>
                    {g.builtIn && <Badge>Built in</Badge>}
                    {g.rule && <Badge>Follows filters</Badge>}
                  </span>
                  {g.description && <div className="admin-muted">{g.description}</div>}
                </td>
                <td>{g.memberCount.toLocaleString()}</td>
                <td className="admin-nowrap">
                  {relative(g.updatedAt)}
                  <div className="admin-muted">{g.updatedBy}</div>
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}
      <Dialog open={creating} onOpenChange={setCreating} title="New group">
        <GroupForm
          onCancel={() => setCreating(false)}
          onDone={(group) => {
            void queries.invalidateQueries({ queryKey: ['email-groups'] });
            setCreating(false);
            open(group.id);
          }}
        />
      </Dialog>
    </>
  );
}

/** Splits pasted text (lines, commas, spaces, semicolons) into emails or usernames. */
const identifiers = (text: string) => [
  ...new Set(
    text
      .split(/[\s,;]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  ),
];

function AddMembers({ groupId, onAdded }: { groupId: string; onAdded: (message: string) => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [unmatched, setUnmatched] = useState<string[]>([]);
  const list = identifiers(text);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = await api.addGroupMembers(groupId, { identifiers: list });
      setUnmatched(result.unmatched);
      setText(result.unmatched.join('\n'));
      onAdded(
        [
          `Added ${plural(result.added - result.addedEmails, 'account')}${
            result.addedEmails
              ? ` and ${plural(result.addedEmails, 'email')} without an account`
              : ''
          }.`,
          result.alreadyMembers ? `${plural(result.alreadyMembers, 'member')} already in it.` : '',
        ]
          .filter(Boolean)
          .join(' '),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="admin-form" onSubmit={submit}>
      <Field
        label="Emails or usernames"
        hint={`One per line, or separated by commas. Up to ${MAX_GROUP_ADD.toLocaleString()} at a time.`}
      >
        <Textarea
          rows={4}
          value={text}
          placeholder={'alice@example.com\nbob'}
          onChange={(e) => {
            setText(e.target.value);
            setUnmatched([]);
          }}
        />
      </Field>
      {unmatched.length > 0 && (
        <Alert tone="warning" role="none">
          {unmatched.length === 1 ? '1 entry is' : `${unmatched.length} entries are`} not an email
          and {unmatched.length === 1 ? 'matches' : 'match'} no username, so{' '}
          {unmatched.length === 1 ? 'it is' : 'they are'} left above:{' '}
          {unmatched.slice(0, 10).join(', ')}
          {unmatched.length > 10 && '…'}
        </Alert>
      )}
      {error && <Alert tone="error">{error}</Alert>}
      <div>
        <Button
          type="submit"
          variant="outline"
          disabled={busy || !list.length || list.length > MAX_GROUP_ADD}
        >
          <UserPlus aria-hidden="true" />
          {list.length ? `Add ${plural(list.length, 'account')}` : 'Add accounts'}
        </Button>
      </div>
    </form>
  );
}

function GroupDetail({ id }: { id: string }) {
  const router = useRouter();
  const queries = useQueryClient();
  const canChange = useCan('campaigns');
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const detail = useQuery({ queryKey: ['email-group', id], queryFn: () => api.group(id) });
  // Built-in groups (other than Everyone, which has its own page) list members but can't change.
  const builtIn = !!detail.data?.group.builtIn;
  const rule = detail.data?.group.rule;
  const canEdit = canChange && !builtIn;
  // A dynamic group's members come from its filters, never by hand.
  const canEditMembers = canEdit && !rule;
  const members = useInfiniteQuery({
    queryKey: ['email-group-members', id],
    queryFn: ({ pageParam }) => api.groupMembers(id, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const refresh = () => {
    void queries.invalidateQueries({ queryKey: ['email-group', id] });
    void queries.invalidateQueries({ queryKey: ['email-group-members', id] });
    void queries.invalidateQueries({ queryKey: ['email-groups'] });
    void queries.invalidateQueries({ queryKey: ['user'] });
    void queries.invalidateQueries({ queryKey: ['audit'] });
  };
  const remove = async (userId: string | null, email: string | null) => {
    setError('');
    try {
      await api.removeGroupMembers(id, userId ? { userIds: [userId] } : { emails: [email!] });
      setNotice(`Removed ${email ?? userId}.`);
      refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const all = members.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <>
      <Link href="/email-groups" className="admin-back">
        <ArrowLeft aria-hidden="true" />
        Groups
      </Link>
      {detail.isPending ? (
        <div className="admin-loading">
          <Skeleton className="admin-skeleton-title" />
          <Skeleton className="admin-skeleton-block" />
        </div>
      ) : detail.error ? (
        <p className="admin-empty">{detail.error.message}</p>
      ) : (
        <>
          <PageHeader
            title={
              builtIn || rule ? (
                <span className="admin-title-row">
                  {detail.data.group.name}
                  <Badge>{builtIn ? 'Built in' : 'Follows filters'}</Badge>
                </span>
              ) : (
                detail.data.group.name
              )
            }
            description={
              <>
                {detail.data.group.description && <>{detail.data.group.description} · </>}
                {plural(detail.data.group.memberCount, 'member')}
              </>
            }
            action={
              canEdit && (
                <div className="admin-actions">
                  <Button variant="outline" onClick={() => setEditing(true)}>
                    Rename
                  </Button>
                  <Button variant="ghost" onClick={() => setDeleting(true)}>
                    <Trash2 aria-hidden="true" />
                    Delete
                  </Button>
                </div>
              )
            }
          />
          {notice && (
            <Alert tone="success" onDismiss={() => setNotice('')}>
              {notice}
            </Alert>
          )}
          {error && <Alert tone="error">{error}</Alert>}
          {builtIn && (
            <Card title="Who is in it">
              <p>
                Every account that has signed in to the Mac app, or to harbor0 in a browser on macOS
                (Safari, Chrome, Firefox or Edge), even if it has since signed out. It is worked out
                again when a campaign starts sending, so new Mac users are included. As with any
                group, deleted, suspended and unverified accounts are skipped, and product updates
                skip people who unsubscribed.
              </p>
              <p className="admin-muted">
                The list below is refreshed every 15 minutes. It can&apos;t be renamed, edited or
                deleted.
              </p>
            </Card>
          )}
          {rule && (
            <Card
              title="Who is in it"
              action={
                <Link className="btn" data-variant="outline" data-size="sm" href={usersHref(rule)}>
                  Open in Users
                </Link>
              }
            >
              <p>{describeRule(rule)}.</p>
              <p className="admin-muted">
                Accounts join and leave as they start or stop matching, and the list is worked out
                again when a campaign starts sending. Deleted, suspended and unverified accounts are
                skipped, and product updates skip people who unsubscribed. To change the filters,
                open them in Users, adjust them, then choose Make an email group and replace this
                group&apos;s filters. The list below is at most 2 minutes old.
              </p>
            </Card>
          )}
          {canEditMembers && (
            <Card
              title="Add members"
              description="Paste emails or usernames. An email with no account is added as an address on its own."
            >
              <AddMembers
                groupId={id}
                onAdded={(message) => {
                  setNotice(message);
                  refresh();
                }}
              />
            </Card>
          )}
          <Card title="Members">
            {members.isPending ? (
              <Skeleton className="admin-skeleton-block" />
            ) : !all.length ? (
              <p className="admin-empty">
                {rule ? 'No accounts match these filters right now.' : 'No one in this group yet.'}
              </p>
            ) : (
              <>
                <DataTable label="Members of the group">
                  <thead>
                    <tr>
                      <th>Member</th>
                      <th>Added</th>
                      <th aria-label="Actions" />
                    </tr>
                  </thead>
                  <tbody>
                    {all.map((m) => (
                      <tr key={m.userId ?? m.email}>
                        <td>
                          {m.userId ? (
                            <Link href={`/user?id=${encodeURIComponent(m.userId)}`}>
                              {m.email ?? m.userId}
                            </Link>
                          ) : (
                            <>
                              {m.email}
                              <div className="admin-muted">No account</div>
                            </>
                          )}
                          {m.name && <div className="admin-muted">{m.name}</div>}
                        </td>
                        <td className="admin-nowrap">
                          {relative(m.addedAt)}
                          <div className="admin-muted">{m.addedBy}</div>
                        </td>
                        <td className="admin-cell-action">
                          {canEditMembers && (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => void remove(m.userId, m.email)}
                            >
                              Remove
                            </Button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </DataTable>
                {members.hasNextPage && (
                  <div className="admin-more">
                    <Button
                      variant="outline"
                      disabled={members.isFetchingNextPage}
                      onClick={() => void members.fetchNextPage()}
                    >
                      Show more
                    </Button>
                  </div>
                )}
              </>
            )}
          </Card>
          <Card title="History" description="Every change to this group, newest first.">
            <AuditList items={detail.data.history} />
          </Card>
          <Dialog open={editing} onOpenChange={setEditing} title="Rename group">
            <GroupForm
              group={detail.data.group}
              onCancel={() => setEditing(false)}
              onDone={() => {
                setEditing(false);
                refresh();
              }}
            />
          </Dialog>
          <Dialog
            open={deleting}
            onOpenChange={setDeleting}
            title={`Delete ${detail.data.group.name}`}
            description="The accounts themselves are not affected. Campaigns already sent keep their recipient lists."
          >
            {error && <Alert tone="error">{error}</Alert>}
            <DialogActions>
              <Button variant="outline" onClick={() => setDeleting(false)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                onClick={async () => {
                  setError('');
                  try {
                    await api.deleteGroup(id);
                    void queries.invalidateQueries({ queryKey: ['email-groups'] });
                    router.replace('/email-groups');
                  } catch (e) {
                    setError((e as Error).message);
                  }
                }}
              >
                Delete group
              </Button>
            </DialogActions>
          </Dialog>
        </>
      )}
    </>
  );
}

/** The built-in group of every account: nothing to edit, so it only explains itself. */
function EveryoneGroup() {
  const detail = useQuery({
    queryKey: ['email-group', EVERYONE_GROUP],
    queryFn: () => api.group(EVERYONE_GROUP),
  });
  return (
    <>
      <Link href="/email-groups" className="admin-back">
        <ArrowLeft aria-hidden="true" />
        Groups
      </Link>
      <PageHeader
        title={
          <span className="admin-title-row">
            Everyone
            <Badge>Built in</Badge>
          </span>
        }
        description={
          detail.data
            ? `About ${plural(detail.data.group.memberCount, 'account')} today`
            : undefined
        }
      />
      <Card title="Who is in it">
        <p>
          Every account, worked out when a campaign starts sending. People who sign up after you
          schedule a campaign are included. As with any group, deleted, suspended and unverified
          accounts are skipped, and product updates skip people who unsubscribed.
        </p>
        <p className="admin-muted">
          It can&apos;t be renamed, edited or deleted. To see the accounts, open{' '}
          <Link href="/users">Users</Link>.
        </p>
      </Card>
    </>
  );
}

function GroupsPage() {
  const id = useSearchParams().get('id');
  if (id === EVERYONE_GROUP) return <EveryoneGroup />;
  return id ? <GroupDetail key={id} id={id} /> : <GroupList />;
}

export default function Page() {
  return (
    <Shell>
      <Suspense>
        <GroupsPage />
      </Suspense>
    </Shell>
  );
}
