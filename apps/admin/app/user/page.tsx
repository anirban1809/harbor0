'use client';
import { Suspense, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Ban,
  Copy,
  HardDrive,
  KeyRound,
  LogOut,
  MailCheck,
  MailPlus,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import { Alert } from '../../../web/components/ui/alert';
import { Badge } from '../../../web/components/ui/badge';
import { Button } from '../../../web/components/ui/button';
import { Card } from '../../../web/components/ui/card';
import { Field } from '../../../web/components/ui/field';
import { Input, Textarea } from '../../../web/components/ui/input';
import { Select } from '../../../web/components/ui/select';
import { Checkbox } from '../../../web/components/ui/checkbox';
import { DataTable } from '../../../web/components/ui/table';
import { Skeleton } from '../../../web/components/ui/skeleton';
import type {
  AdminUserDetail,
  StaffDeletionReason,
} from '../../../../packages/contracts/src/admin';
import { MAX_ADMIN_QUOTA } from '../../../../packages/contracts/src/admin';
import { AuditList } from '../../components/audit-list';
import { ReasonDialog } from '../../components/reason-dialog';
import { PageHeader, Shell, useCan } from '../../components/shell';
import { StatusBadges } from '../../components/status-badges';
import { StorageMeter } from '../../components/storage-meter';
import { api, type UserAction } from '../../lib/api';
import { bytes, date, GB, relative, TB } from '../../lib/format';

type Dialog =
  | { kind: 'quota' }
  | { kind: 'delete' }
  | { kind: 'device'; deviceId: string; name: string }
  | { kind: 'action'; action: UserAction };

const actions: Record<
  UserAction,
  { title: string; description: string; confirm: string; danger?: boolean; done: string }
> = {
  'password-reset': {
    title: 'Reset password',
    description:
      'Emails the person a reset code. Their current password stops working; they set a new one with “Forgot password” and the code. Signed-in devices stay signed in.',
    confirm: 'Send reset email',
    done: 'Password reset email sent.',
  },
  'verification/resend': {
    title: 'Resend verification email',
    description: 'Sends a new verification code to the account email.',
    confirm: 'Resend email',
    done: 'Verification email sent.',
  },
  'verification/confirm': {
    title: 'Mark email as verified',
    description:
      'Use only when you have confirmed the person controls this address another way. They can then sign in without the code.',
    confirm: 'Mark verified',
    done: 'Email marked as verified.',
  },
  'sign-out': {
    title: 'Sign out everywhere',
    description:
      'Ends every session on every device. Sync and backups pause until the person signs in again; nothing is deleted.',
    confirm: 'Sign out everywhere',
    danger: true,
    done: 'Signed out of every device.',
  },
  suspend: {
    title: 'Suspend account',
    description:
      'Blocks sign-in and every app at once and signs all devices out. Files are kept and still count toward storage. You can restore the account later.',
    confirm: 'Suspend account',
    danger: true,
    done: 'Account suspended.',
  },
  unsuspend: {
    title: 'Restore account',
    description: 'Lets the person sign in and use harbor0 again.',
    confirm: 'Restore account',
    done: 'Account restored.',
  },
};

const presets = [50 * GB, 100 * GB, 500 * GB, TB, 3 * TB, 6 * TB];

function QuotaFields({
  current,
  used,
  value,
  onChange,
}: {
  current: number;
  used: number;
  value: string;
  onChange: (value: string) => void;
}) {
  const next = Math.round(Number(value) * GB);
  return (
    <>
      <div className="admin-presets" role="group" aria-label="Common limits">
        {presets.map((p) => (
          <Button
            key={p}
            type="button"
            size="sm"
            variant={next === p ? 'primary' : 'outline'}
            onClick={() => onChange(String(p / GB))}
          >
            {bytes(p)}
          </Button>
        ))}
      </div>
      <Field
        label="New limit (GB)"
        hint={`Currently ${bytes(current)}; ${bytes(used)} in use. 1 GB = 1,000,000,000 bytes.`}
      >
        <Input
          type="number"
          min={0}
          step="any"
          required
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      </Field>
      {Number.isFinite(next) && next < used && (
        <Alert tone="warning">
          This is below what the account already stores. Nothing is deleted, but uploads and new
          versions will fail until they free up {bytes(used - next)}.
        </Alert>
      )}
    </>
  );
}

// Each reason sends the account holder its own email (apps/backend/src/emails.ts).
const deletionReasons: [StaffDeletionReason, string, string][] = [
  ['USER_REQUEST', 'The account holder asked', 'Confirms we deleted the account as they asked.'],
  [
    'TERMS_VIOLATION',
    'Breaks the terms of use',
    'Says the account was closed for breaking the terms of use.',
  ],
  ['ABUSE', 'Spam, fraud or abuse', 'Says the account was closed for spam, fraud or abuse.'],
  [
    'DUPLICATE',
    'Duplicate account',
    "Says a duplicate was closed and their other account isn't affected.",
  ],
  ['OTHER', 'Other', 'Says the harbor0 team closed the account, without a reason.'],
];

function Detail({ id }: { id: string }) {
  const queries = useQueryClient();
  const detail = useQuery({ queryKey: ['user', id], queryFn: () => api.user(id) });
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [notice, setNotice] = useState('');
  const [quota, setQuota] = useState('');
  const [confirmEmail, setConfirmEmail] = useState('');
  const [deletionReason, setDeletionReason] = useState<StaffDeletionReason | ''>('');
  const [notifyDeletion, setNotifyDeletion] = useState(true);
  const [note, setNote] = useState('');
  const [allDevices, setAllDevices] = useState(false);
  const canQuota = useCan('quota');
  const canSuspend = useCan('suspend');
  const canConfirm = useCan('confirm');
  const canDelete = useCan('delete');
  const canReset = useCan('password-reset');
  const canSignOut = useCan('sign-out');
  const refresh = () => {
    void queries.invalidateQueries({ queryKey: ['user', id] });
    void queries.invalidateQueries({ queryKey: ['users'] });
    void queries.invalidateQueries({ queryKey: ['overview'] });
    void queries.invalidateQueries({ queryKey: ['audit'] });
  };
  const done = (message: string) => {
    setNotice(message);
    refresh();
  };
  const addNote = useMutation({
    mutationFn: (text: string) => api.note(id, text),
    onSuccess: () => {
      setNote('');
      refresh();
    },
  });

  if (detail.isPending)
    return (
      <div className="admin-loading">
        <Skeleton className="admin-skeleton-title" />
        <Skeleton className="admin-skeleton-block" />
      </div>
    );
  if (detail.error)
    return (
      <>
        <BackLink />
        <p className="admin-empty">{detail.error.message}</p>
      </>
    );
  const { account, profile, devices, backupCount, activity } = detail.data as AdminUserDetail;
  const deleted = !!profile?.deletedAt;
  const suspended = !!profile?.suspendedAt || (!account.enabled && !deleted);
  const unverified = account.status === 'UNCONFIRMED';
  const open = (d: Dialog) => {
    setNotice('');
    if (d.kind === 'quota') setQuota(String((profile?.storage.quotaBytes ?? 0) / GB));
    if (d.kind === 'delete') {
      setConfirmEmail('');
      setDeletionReason('');
      setNotifyDeletion(true);
    }
    setDialog(d);
  };
  const submitNote = (event: FormEvent) => {
    event.preventDefault();
    if (note.trim()) addNote.mutate(note.trim());
  };
  const action = dialog?.kind === 'action' ? actions[dialog.action] : null;
  // Active devices first, most recently seen first; ended sessions only on request.
  const sortedDevices = [...devices].sort(
    (a, b) =>
      Number(a.status !== 'ACTIVE') - Number(b.status !== 'ACTIVE') ||
      (b.lastSeenAt ?? '').localeCompare(a.lastSeenAt ?? ''),
  );
  const endedDevices = devices.filter((d) => d.status !== 'ACTIVE').length;
  const shownDevices = allDevices
    ? sortedDevices
    : sortedDevices.filter((d) => d.status === 'ACTIVE');
  const quotaBytes = Math.round(Number(quota) * GB);

  return (
    <>
      <BackLink />
      <PageHeader
        title={
          <span className="admin-title-row">
            {profile?.displayName ?? account.displayName ?? account.email}
            <StatusBadges
              status={account.status}
              enabled={account.enabled}
              suspended={!!profile?.suspendedAt}
              deleted={deleted}
            />
          </span>
        }
        description={
          <>
            {account.email}
            {(profile?.username ?? account.username) && (
              <> · @{profile?.username ?? account.username}</>
            )}
          </>
        }
      />
      {notice && (
        <Alert tone="success" onDismiss={() => setNotice('')}>
          {notice}
        </Alert>
      )}
      {profile?.suspendedAt && (
        <Alert tone="error" role="none">
          Suspended {relative(profile.suspendedAt)}: <q>{profile.suspendedReason}</q>
        </Alert>
      )}
      {deleted && (
        <Alert tone="warning" role="none">
          Deleted {relative(profile!.deletedAt)}.{' '}
          {profile!.purgeAt && profile!.purgeAt <= new Date().toISOString()
            ? `Files purged from ${date(profile!.purgeAt)}.`
            : `Files are purged after ${date(profile!.purgeAt)}.`}
        </Alert>
      )}
      {!profile && !deleted && (
        <Alert tone="info" role="none">
          This person has not verified their email yet, so there is no drive or storage yet.
        </Alert>
      )}

      <div className="admin-grid">
        <Card
          title="Storage"
          action={
            canQuota &&
            profile &&
            !deleted && (
              <Button size="sm" variant="outline" onClick={() => open({ kind: 'quota' })}>
                <HardDrive aria-hidden="true" />
                Change limit
              </Button>
            )
          }
        >
          {profile ? (
            <>
              <StorageMeter used={profile.storage.usedBytes} quota={profile.storage.quotaBytes} />
              <dl className="admin-facts">
                <dt>Limit</dt>
                <dd>{bytes(profile.storage.quotaBytes)}</dd>
                <dt>Used</dt>
                <dd>{bytes(profile.storage.usedBytes)}</dd>
                <dt>In trash</dt>
                <dd>{bytes(profile.storage.trashBytes)}</dd>
                <dt>Uploading (reserved)</dt>
                <dd>{bytes(profile.storage.reservedBytes)}</dd>
                <dt>Being deleted</dt>
                <dd>{bytes(profile.storage.purgingBytes)}</dd>
                <dt>Available</dt>
                <dd>{bytes(profile.storage.availableBytes)}</dd>
                <dt>Backups</dt>
                <dd>{backupCount}</dd>
              </dl>
            </>
          ) : (
            <p className="admin-empty">No storage yet.</p>
          )}
        </Card>

        <Card title="Account">
          <dl className="admin-facts">
            <dt>Account ID</dt>
            <dd className="admin-id">
              <code>{account.id}</code>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Copy account ID"
                onClick={() => void navigator.clipboard?.writeText(account.id)}
              >
                <Copy aria-hidden="true" />
              </Button>
            </dd>
            <dt>Email</dt>
            <dd>
              {account.email}{' '}
              {unverified ? <Badge tone="warning">Unverified</Badge> : <Badge>Verified</Badge>}
            </dd>
            <dt>Sign-in</dt>
            <dd>
              {deleted ? 'Removed' : account.enabled ? 'Enabled' : 'Disabled'}
              {account.status === 'RESET_REQUIRED' && ' · password reset pending'}
            </dd>
            <dt>Signed up</dt>
            <dd>{date(account.createdAt ?? profile?.createdAt)}</dd>
            {profile && (
              <>
                <dt>Last change</dt>
                <dd>{relative(profile.updatedAt)}</dd>
              </>
            )}
          </dl>
        </Card>
      </div>

      {!deleted && (
        <Card
          title="Support actions"
          description="Each action asks for a reason and is recorded in the audit log."
        >
          <div className="admin-actions">
            {unverified ? (
              <>
                <Button
                  variant="outline"
                  onClick={() => open({ kind: 'action', action: 'verification/resend' })}
                >
                  <MailPlus aria-hidden="true" />
                  Resend verification
                </Button>
                {canConfirm && (
                  <Button
                    variant="outline"
                    onClick={() => open({ kind: 'action', action: 'verification/confirm' })}
                  >
                    <MailCheck aria-hidden="true" />
                    Mark email verified
                  </Button>
                )}
              </>
            ) : (
              canReset && (
                <Button
                  variant="outline"
                  onClick={() => open({ kind: 'action', action: 'password-reset' })}
                >
                  <KeyRound aria-hidden="true" />
                  Reset password
                </Button>
              )
            )}
            {canSignOut && (
              <Button
                variant="outline"
                onClick={() => open({ kind: 'action', action: 'sign-out' })}
              >
                <LogOut aria-hidden="true" />
                Sign out everywhere
              </Button>
            )}
            {canSuspend &&
              (suspended ? (
                <Button
                  variant="outline"
                  onClick={() => open({ kind: 'action', action: 'unsuspend' })}
                >
                  <RotateCcw aria-hidden="true" />
                  Restore account
                </Button>
              ) : (
                <Button
                  variant="outline"
                  onClick={() => open({ kind: 'action', action: 'suspend' })}
                >
                  <Ban aria-hidden="true" />
                  Suspend
                </Button>
              ))}
            {canDelete && (
              <Button variant="danger" onClick={() => open({ kind: 'delete' })}>
                <Trash2 aria-hidden="true" />
                Delete account
              </Button>
            )}
          </div>
        </Card>
      )}

      <Card
        title="Devices"
        description="Each signed-in app installation."
        action={
          endedDevices > 0 && (
            <Button size="sm" variant="ghost" onClick={() => setAllDevices((v) => !v)}>
              {allDevices ? 'Hide signed-out devices' : `Show ${endedDevices} signed-out`}
            </Button>
          )
        }
      >
        {shownDevices.length ? (
          <DataTable label="Devices">
            <thead>
              <tr>
                <th>Device</th>
                <th>Status</th>
                <th>Last seen</th>
                <th>Added</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {shownDevices.map((d) => (
                <tr key={d.id}>
                  <td>
                    <strong>{d.name}</strong>
                    <div className="admin-muted">
                      {d.platform}
                      {d.appVersion && ` · ${d.appVersion}`}
                    </div>
                  </td>
                  <td>
                    {d.status === 'ACTIVE' ? (
                      <Badge tone="success">Active</Badge>
                    ) : d.status === 'REVOKED' ? (
                      <Badge tone="danger">Removed</Badge>
                    ) : (
                      <Badge>Signed out</Badge>
                    )}
                  </td>
                  <td className="admin-nowrap">{relative(d.lastSeenAt)}</td>
                  <td className="admin-nowrap">{date(d.createdAt)}</td>
                  <td className="admin-cell-action">
                    {canSignOut && d.status === 'ACTIVE' && !deleted && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => open({ kind: 'device', deviceId: d.id, name: d.name })}
                      >
                        Sign out
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        ) : (
          <p className="admin-empty">{devices.length ? 'No signed-in devices.' : 'No devices.'}</p>
        )}
      </Card>

      <Card title="Notes and activity" description="Internal only; the customer never sees these.">
        <form className="admin-note-form" onSubmit={submitNote}>
          <Textarea
            aria-label="Add a note"
            placeholder="Add a note for other staff…"
            rows={2}
            maxLength={2000}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <Button type="submit" variant="outline" disabled={!note.trim() || addNote.isPending}>
            Add note
          </Button>
        </form>
        {addNote.error && <Alert tone="error">{addNote.error.message}</Alert>}
        <AuditList items={activity} />
      </Card>

      {action && dialog?.kind === 'action' && (
        <ReasonDialog
          open
          onOpenChange={(o) => !o && setDialog(null)}
          title={action.title}
          description={action.description}
          confirmLabel={action.confirm}
          danger={action.danger}
          onConfirm={async (reason) => {
            await api.action(id, dialog.action, reason);
            done(action.done);
          }}
        />
      )}
      {dialog?.kind === 'device' && (
        <ReasonDialog
          open
          onOpenChange={(o) => !o && setDialog(null)}
          title={`Sign out ${dialog.name}`}
          description="Ends this device's session. Its sync folders and backups pause until someone signs in on it again."
          confirmLabel="Sign out device"
          danger
          onConfirm={async (reason) => {
            await api.signOutDevice(id, dialog.deviceId, reason);
            done(`${dialog.name} was signed out.`);
          }}
        />
      )}
      {dialog?.kind === 'quota' && profile && (
        <ReasonDialog
          open
          onOpenChange={(o) => !o && setDialog(null)}
          title="Change storage limit"
          description="The new limit applies at once in every app."
          confirmLabel="Save limit"
          canSubmit={
            quota !== '' &&
            Number.isFinite(quotaBytes) &&
            quotaBytes >= 0 &&
            quotaBytes <= MAX_ADMIN_QUOTA &&
            quotaBytes !== profile.storage.quotaBytes
          }
          onConfirm={async (reason) => {
            await api.setQuota(id, quotaBytes, reason);
            done(`Storage limit set to ${bytes(quotaBytes)}.`);
          }}
        >
          <QuotaFields
            current={profile.storage.quotaBytes}
            used={profile.storage.usedBytes}
            value={quota}
            onChange={setQuota}
          />
        </ReasonDialog>
      )}
      {dialog?.kind === 'delete' && (
        <ReasonDialog
          open
          onOpenChange={(o) => !o && setDialog(null)}
          title="Delete account"
          description={
            <>
              Removes the sign-in now and releases the email and username. Files are purged after 30
              days; there is no restore. Only do this on the account holder&apos;s verified request
              or for a policy violation.
            </>
          }
          confirmLabel="Delete account"
          danger
          canSubmit={
            !!deletionReason && confirmEmail.trim().toLowerCase() === account.email.toLowerCase()
          }
          onConfirm={async (reason) => {
            if (!deletionReason) return;
            const result = await api.deleteAccount(
              id,
              confirmEmail.trim(),
              reason,
              deletionReason,
              notifyDeletion,
            );
            done(`Account deleted. Files are purged after ${date(result.purgeAt)}.`);
          }}
        >
          <Field
            label="Why is this account being deleted?"
            hint={
              deletionReasons.find(([value]) => value === deletionReason)?.[2] ??
              'The account holder gets an email written for the reason you choose.'
            }
          >
            <Select
              block
              required
              value={deletionReason}
              onChange={(e) => setDeletionReason(e.target.value as StaffDeletionReason)}
            >
              <option value="" disabled>
                Choose a reason
              </option>
              {deletionReasons.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>
          <label className="admin-checkbox">
            <Checkbox
              checked={notifyDeletion}
              onChange={(e) => setNotifyDeletion(e.target.checked)}
            />
            Email the account holder at {account.email}
          </label>
          <Field
            label={
              <>
                Type <strong>{account.email}</strong> to confirm
              </>
            }
          >
            <Input
              autoComplete="off"
              value={confirmEmail}
              onChange={(e) => setConfirmEmail(e.target.value)}
            />
          </Field>
        </ReasonDialog>
      )}
    </>
  );
}

function BackLink() {
  return (
    <Link href="/users" className="admin-back">
      <ArrowLeft aria-hidden="true" />
      Users
    </Link>
  );
}

function UserPage() {
  const id = useSearchParams().get('id');
  if (!id) return <p className="admin-empty">No account selected.</p>;
  return <Detail key={id} id={id} />;
}

export default function Page() {
  return (
    <Shell>
      <Suspense>
        <UserPage />
      </Suspense>
    </Shell>
  );
}
