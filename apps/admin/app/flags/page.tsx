'use client';
import { Suspense, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, X } from 'lucide-react';
import type { FlagClient, FlagMode } from '../../../../packages/contracts/src/flags';
import type { AdminFlag, AdminFlagDetail } from '../../../../packages/contracts/src/admin';
import { Alert } from '../../../web/components/ui/alert';
import { Button } from '../../../web/components/ui/button';
import { Card } from '../../../web/components/ui/card';
import { Field } from '../../../web/components/ui/field';
import { Input } from '../../../web/components/ui/input';
import { Segmented } from '../../../web/components/ui/segmented';
import { DataTable } from '../../../web/components/ui/table';
import { Skeleton } from '../../../web/components/ui/skeleton';
import { AuditList } from '../../components/audit-list';
import { FlagModeBadge } from '../../components/flag-badge';
import { ReasonDialog } from '../../components/reason-dialog';
import { UsageLog } from '../../components/usage-log';
import { PageHeader, Shell, useCan } from '../../components/shell';
import { api } from '../../lib/api';
import { flagReach, relative } from '../../lib/format';

const clients: [FlagClient, string][] = [
  ['DESKTOP', 'Desktop'],
  ['IOS', 'iOS'],
  ['ANDROID', 'Android'],
];
const versionPattern = /^\d+(\.\d+){0,3}$/;

function FlagList() {
  const router = useRouter();
  const flags = useQuery({ queryKey: ['flags'], queryFn: api.flags });
  const open = (key: string) => router.push(`/flags?key=${encodeURIComponent(key)}`);
  return (
    <>
      <PageHeader
        title="Feature flags"
        description="Features still being rolled out. Each is off until you turn it on for chosen accounts, a share of everyone, or all accounts. Apps pick up changes within a minute."
      />
      {flags.isPending ? (
        <Skeleton className="admin-skeleton-block" />
      ) : flags.error ? (
        <p className="admin-empty">{flags.error.message}</p>
      ) : !flags.data.items.length ? (
        <p className="admin-empty">No features are being rolled out.</p>
      ) : (
        <DataTable label="Feature flags">
          <thead>
            <tr>
              <th>Flag</th>
              <th>Mode</th>
              <th>Reaches</th>
              <th>Last changed</th>
            </tr>
          </thead>
          <tbody>
            {flags.data.items.map((f) => (
              <tr
                key={f.key}
                tabIndex={0}
                className="admin-row-link"
                onClick={() => open(f.key)}
                onKeyDown={(e) => e.key === 'Enter' && open(f.key)}
              >
                <td>
                  <code className="admin-flag-key">{f.key}</code>
                  <div className="admin-muted">{f.description}</div>
                </td>
                <td>
                  <FlagModeBadge mode={f.mode} />
                </td>
                <td>{flagReach(f, flags.data.accounts)}</td>
                <td className="admin-nowrap">
                  {f.updatedAt ? relative(f.updatedAt) : 'Never'}
                  {f.updatedBy && <div className="admin-muted">{f.updatedBy}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}
    </>
  );
}

type User = { id: string; email: string | null };
/** The rule being edited; saved as a whole, with a reason, over the version it started from. */
function Editor({
  detail,
  onSaved,
}: {
  detail: AdminFlagDetail;
  onSaved: (message: string) => void;
}) {
  const queries = useQueryClient();
  const canEdit = useCan('flags');
  const saved = detail.flag;
  const [mode, setMode] = useState<FlagMode>(saved.mode);
  const [users, setUsers] = useState<User[]>(saved.users);
  const [percent, setPercent] = useState(saved.percent);
  const [versions, setVersions] = useState<Record<FlagClient, string>>({
    DESKTOP: saved.minVersions.DESKTOP ?? '',
    IOS: saved.minVersions.IOS ?? '',
    ANDROID: saved.minVersions.ANDROID ?? '',
  });
  const [email, setEmail] = useState('');
  const [lookup, setLookup] = useState<{ busy: boolean; error: string }>({
    busy: false,
    error: '',
  });
  const [confirming, setConfirming] = useState(false);

  const minVersions = Object.fromEntries(
    clients.map(([c]) => [c, versions[c].trim()]).filter(([, v]) => v),
  ) as AdminFlag['minVersions'];
  const badVersion = clients.some(
    ([c]) => versions[c].trim() && !versionPattern.test(versions[c].trim()),
  );
  const draft = { mode, userIds: users.map((u) => u.id), percent };
  const changed =
    mode !== saved.mode ||
    percent !== saved.percent ||
    draft.userIds.join() !== saved.userIds.join() ||
    JSON.stringify(minVersions) !==
      JSON.stringify(
        Object.fromEntries(clients.map(([c]) => [c, saved.minVersions[c]]).filter(([, v]) => v)),
      );

  const add = async (event: FormEvent) => {
    event.preventDefault();
    const wanted = email.trim().toLowerCase();
    if (!wanted.includes('@')) return setLookup({ busy: false, error: 'Enter an account email.' });
    if (users.some((u) => u.email?.toLowerCase() === wanted))
      return setLookup({ busy: false, error: 'This account is already on the list.' });
    setLookup({ busy: true, error: '' });
    try {
      const page = await api.users(wanted, null);
      const match = page.items.find((u) => u.email.toLowerCase() === wanted && !u.deleted);
      if (!match) return setLookup({ busy: false, error: 'No account uses this email.' });
      setUsers((list) => [...list, { id: match.id, email: match.email }]);
      setEmail('');
      setLookup({ busy: false, error: '' });
    } catch (e) {
      setLookup({ busy: false, error: (e as Error).message });
    }
  };
  const save = async (reason: string) => {
    const result = await api.saveFlag(saved.key, {
      ...draft,
      minVersions,
      reason,
      expectedUpdatedAt: saved.updatedAt,
    });
    onSaved(`Saved. It now reaches ${flagReach(result, detail.accounts).toLowerCase()}.`);
    void queries.invalidateQueries({ queryKey: ['flags'] });
    void queries.invalidateQueries({ queryKey: ['audit'] });
    void queries.invalidateQueries({ queryKey: ['user'] });
    await queries.invalidateQueries({ queryKey: ['flag', saved.key] });
  };

  return (
    <>
      <Card
        title="Rollout"
        description={
          mode === 'TARGETED'
            ? 'On for the accounts listed, plus a share of everyone else.'
            : mode === 'ON'
              ? 'On for every account, on app builds new enough below.'
              : 'Off for every account. Use this to switch the feature off at once.'
        }
      >
        <div className="admin-flag-mode">
          <Segmented
            label="Mode"
            value={mode}
            onValueChange={setMode}
            disabled={!canEdit}
            options={[
              { value: 'OFF', label: 'Off' },
              { value: 'TARGETED', label: 'Targeted' },
              { value: 'ON', label: 'On for everyone' },
            ]}
          />
          <span className="admin-muted">
            Reaches {flagReach({ ...draft }, detail.accounts).toLowerCase()}
          </span>
        </div>
      </Card>

      {mode === 'TARGETED' && (
        <div className="admin-grid">
          <Card
            title="Specific accounts"
            description="Always on for these accounts, whatever the percentage."
          >
            {canEdit && (
              <form className="admin-flag-add" onSubmit={add}>
                <Input
                  type="email"
                  aria-label="Account email"
                  placeholder="name@example.com"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    setLookup((l) => ({ ...l, error: '' }));
                  }}
                />
                <Button type="submit" variant="outline" disabled={lookup.busy || !email.trim()}>
                  Add
                </Button>
              </form>
            )}
            {lookup.error && <Alert tone="error">{lookup.error}</Alert>}
            {users.length ? (
              <ul className="admin-flag-users">
                {users.map((u) => (
                  <li key={u.id}>
                    <Link href={`/user?id=${encodeURIComponent(u.id)}`}>{u.email ?? u.id}</Link>
                    {canEdit && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Remove ${u.email ?? u.id}`}
                        onClick={() => setUsers((list) => list.filter((x) => x.id !== u.id))}
                      >
                        <X aria-hidden="true" />
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="admin-empty">No accounts listed.</p>
            )}
          </Card>
          <Card
            title="Everyone else"
            description="Each account has a fixed place, so raising the share only adds people."
          >
            <div className="admin-flag-percent">
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={percent}
                disabled={!canEdit}
                aria-label="Share of other accounts"
                onChange={(e) => setPercent(Number(e.target.value))}
              />
              <strong>{percent}%</strong>
            </div>
            <div className="admin-presets" role="group" aria-label="Common shares">
              {[0, 5, 10, 25, 50, 100].map((p) => (
                <Button
                  key={p}
                  type="button"
                  size="sm"
                  variant={percent === p ? 'primary' : 'outline'}
                  disabled={!canEdit}
                  onClick={() => setPercent(p)}
                >
                  {p}%
                </Button>
              ))}
            </div>
          </Card>
        </div>
      )}

      {mode !== 'OFF' && (
        <Card
          title="Minimum app version"
          description="Older builds don't have the feature, so they see it as off. The web app is always current."
        >
          <div className="admin-flag-versions">
            {clients.map(([client, label]) => (
              <Field
                key={client}
                label={label}
                hint={
                  versions[client].trim() && !versionPattern.test(versions[client].trim())
                    ? 'Use a version like 1.4.0.'
                    : undefined
                }
              >
                <Input
                  placeholder="Any version"
                  value={versions[client]}
                  disabled={!canEdit}
                  onChange={(e) => setVersions((v) => ({ ...v, [client]: e.target.value }))}
                />
              </Field>
            ))}
          </div>
        </Card>
      )}

      {canEdit && (
        <div className="admin-flag-save">
          <span className="admin-muted">
            {changed ? 'You have unsaved changes.' : 'No changes.'}
          </span>
          <Button
            variant="outline"
            disabled={!changed}
            onClick={() => {
              setMode(saved.mode);
              setUsers(saved.users);
              setPercent(saved.percent);
              setVersions({
                DESKTOP: saved.minVersions.DESKTOP ?? '',
                IOS: saved.minVersions.IOS ?? '',
                ANDROID: saved.minVersions.ANDROID ?? '',
              });
            }}
          >
            Discard
          </Button>
          <Button disabled={!changed || badVersion} onClick={() => setConfirming(true)}>
            Save changes
          </Button>
        </div>
      )}

      <Card title="History" description="Every change to this flag, newest first.">
        <AuditList items={detail.history} showUser />
      </Card>

      <UsageLog flagKey={saved.key} />

      <ReasonDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Save ${saved.key}`}
        description={`After saving, it reaches ${flagReach(draft, detail.accounts).toLowerCase()}. Apps pick up the change within a minute.`}
        confirmLabel="Save changes"
        danger={mode === 'ON' && saved.mode !== 'ON'}
        onConfirm={save}
      />
    </>
  );
}

function FlagDetail({ flagKey }: { flagKey: string }) {
  const detail = useQuery({ queryKey: ['flag', flagKey], queryFn: () => api.flag(flagKey) });
  const [notice, setNotice] = useState('');
  return (
    <>
      <Link href="/flags" className="admin-back">
        <ArrowLeft aria-hidden="true" />
        Feature flags
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
              <span className="admin-title-row">
                <code className="admin-flag-key">{detail.data.flag.key}</code>
                <FlagModeBadge mode={detail.data.flag.mode} />
              </span>
            }
            description={
              <>
                {detail.data.flag.description}
                {detail.data.flag.updatedAt &&
                  ` · changed ${relative(detail.data.flag.updatedAt)} by ${detail.data.flag.updatedBy}`}
              </>
            }
          />
          {notice && (
            <Alert tone="success" onDismiss={() => setNotice('')}>
              {notice}
            </Alert>
          )}
          {/* A save reloads the flag; starting the editor afresh drops the saved draft. */}
          <Editor
            key={detail.data.flag.updatedAt ?? 'new'}
            detail={detail.data}
            onSaved={setNotice}
          />
        </>
      )}
    </>
  );
}

function FlagsPage() {
  const key = useSearchParams().get('key');
  return key ? <FlagDetail key={key} flagKey={key} /> : <FlagList />;
}

export default function Page() {
  return (
    <Shell>
      <Suspense>
        <FlagsPage />
      </Suspense>
    </Shell>
  );
}
