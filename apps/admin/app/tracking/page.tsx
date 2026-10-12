'use client';
import { Suspense, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Copy } from 'lucide-react';
import { TRACKING_ID_PATTERN } from '../../../../packages/contracts/src/index';
import type { AdminTrackerDetail } from '../../../../packages/contracts/src/admin';
import { Alert } from '../../../web/components/ui/alert';
import { Badge } from '../../../web/components/ui/badge';
import { Button } from '../../../web/components/ui/button';
import { Card } from '../../../web/components/ui/card';
import { Field } from '../../../web/components/ui/field';
import { Input, Textarea } from '../../../web/components/ui/input';
import { DataTable } from '../../../web/components/ui/table';
import { Skeleton } from '../../../web/components/ui/skeleton';
import { PageHeader, Shell, useCan } from '../../components/shell';
import { api } from '../../lib/api';
import { date, relative } from '../../lib/format';

const linkFor = (signupUrl: string, id: string) => `${signupUrl}?ref=${encodeURIComponent(id)}`;
const open = (id: string) => `/tracking?id=${encodeURIComponent(id)}`;

function CopyLink({ url }: { url: string }) {
  return (
    <span className="admin-id">
      <code>{url}</code>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Copy link"
        onClick={() => void navigator.clipboard?.writeText(url)}
      >
        <Copy aria-hidden="true" />
      </Button>
    </span>
  );
}

/** Names a new tracking id; saving opens its page. */
function NewTracker() {
  const router = useRouter();
  const queries = useQueryClient();
  const [id, setId] = useState('');
  const [source, setSource] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const cleanId = id.trim().toLowerCase();
  const badId = !!cleanId && !TRACKING_ID_PATTERN.test(cleanId);
  const create = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.saveTracker(cleanId, { source, notes: '', expectedUpdatedAt: null });
      void queries.invalidateQueries({ queryKey: ['trackers'] });
      void queries.invalidateQueries({ queryKey: ['audit'] });
      router.push(open(cleanId));
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Card
      title="New tracking link"
      description="Pick a short id for where you'll share the link, like reddit-oct or newsletter-1."
    >
      <form className="admin-tracker-new" onSubmit={create}>
        <Field
          label="Tracking id"
          hint={badId ? 'Use lowercase letters, numbers, - and _ (up to 64).' : undefined}
        >
          <Input value={id} placeholder="reddit-oct" onChange={(e) => setId(e.target.value)} />
        </Field>
        <Field label="Source">
          <Input
            value={source}
            placeholder="r/selfhosted launch post"
            onChange={(e) => setSource(e.target.value)}
          />
        </Field>
        <Button type="submit" disabled={busy || !cleanId || badId || !source.trim()}>
          Create
        </Button>
      </form>
      {error && <Alert tone="error">{error}</Alert>}
    </Card>
  );
}

function TrackerList() {
  const router = useRouter();
  const canEdit = useCan('tracking');
  const trackers = useQuery({ queryKey: ['trackers'], queryFn: api.trackers });
  return (
    <>
      <PageHeader
        title="Sign-up tracking"
        description="Add ?ref=<id> to a sign-up link (or any harbor0.com page) to see who signed up through it. Name each id with where you shared it."
      />
      {canEdit && <NewTracker />}
      {trackers.isPending ? (
        <Skeleton className="admin-skeleton-block" />
      ) : trackers.error ? (
        <p className="admin-empty">{trackers.error.message}</p>
      ) : !trackers.data.items.length ? (
        <p className="admin-empty">No tracking links yet.</p>
      ) : (
        <DataTable label="Tracking links">
          <thead>
            <tr>
              <th>Tracking id</th>
              <th>Source</th>
              <th>Requested a link</th>
              <th>Signed up</th>
              <th>Accounts</th>
              <th>Last used</th>
            </tr>
          </thead>
          <tbody>
            {trackers.data.items.map((t) => (
              <tr
                key={t.id}
                tabIndex={0}
                className="admin-row-link"
                onClick={() => router.push(open(t.id))}
                onKeyDown={(e) => e.key === 'Enter' && router.push(open(t.id))}
              >
                <td>
                  <code className="admin-flag-key">{t.id}</code>
                </td>
                <td>{t.source ?? <Badge tone="warning">Unnamed</Badge>}</td>
                <td>{t.requests.toLocaleString()}</td>
                <td>{t.signups.toLocaleString()}</td>
                <td>{t.accounts.toLocaleString()}</td>
                <td className="admin-nowrap">{t.lastAt ? relative(t.lastAt) : 'Never'}</td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}
    </>
  );
}

function Editor({ detail }: { detail: AdminTrackerDetail }) {
  const router = useRouter();
  const queries = useQueryClient();
  const canEdit = useCan('tracking');
  const { tracker } = detail;
  const [source, setSource] = useState(tracker.source ?? '');
  const [notes, setNotes] = useState(tracker.notes);
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string }>();
  const [busy, setBusy] = useState(false);
  const changed = source.trim() !== (tracker.source ?? '') || notes.trim() !== tracker.notes;
  const refresh = () => {
    void queries.invalidateQueries({ queryKey: ['trackers'] });
    void queries.invalidateQueries({ queryKey: ['audit'] });
    void queries.invalidateQueries({ queryKey: ['user'] });
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setMessage(undefined);
    try {
      const saved = await api.saveTracker(tracker.id, {
        source,
        notes,
        expectedUpdatedAt: tracker.updatedAt,
      });
      queries.setQueryData(['tracker', tracker.id], saved);
      refresh();
      setMessage({ tone: 'success', text: 'Saved.' });
    } catch (e) {
      setMessage({ tone: 'error', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!confirm(`Remove the name for ${tracker.id}? Sign-ups through it stay, unnamed.`)) return;
    setBusy(true);
    try {
      await api.deleteTracker(tracker.id);
      refresh();
      router.push('/tracking');
    } catch (e) {
      setMessage({ tone: 'error', text: (e as Error).message });
      setBusy(false);
    }
  };
  return (
    <Card
      title="Source"
      description={
        tracker.updatedAt
          ? `Changed ${relative(tracker.updatedAt)} by ${tracker.updatedBy}`
          : 'Sign-ups used this id, but nobody has named it yet.'
      }
    >
      <form className="admin-tracker-edit" onSubmit={save}>
        <Field label="Source">
          <Input
            value={source}
            disabled={!canEdit}
            placeholder="Where the link was shared"
            onChange={(e) => setSource(e.target.value)}
          />
        </Field>
        <Field label="Notes">
          <Textarea
            value={notes}
            disabled={!canEdit}
            rows={3}
            onChange={(e) => setNotes(e.target.value)}
          />
        </Field>
        {message && <Alert tone={message.tone}>{message.text}</Alert>}
        {canEdit && (
          <div className="admin-flag-save">
            {tracker.updatedAt && (
              <Button type="button" variant="outline" disabled={busy} onClick={remove}>
                Remove name
              </Button>
            )}
            <Button type="submit" disabled={busy || !changed || !source.trim()}>
              Save
            </Button>
          </div>
        )}
      </form>
    </Card>
  );
}

function TrackerDetail({ id }: { id: string }) {
  const detail = useQuery({ queryKey: ['tracker', id], queryFn: () => api.tracker(id) });
  return (
    <>
      <Link href="/tracking" className="admin-back">
        <ArrowLeft aria-hidden="true" />
        Sign-up tracking
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
                <code className="admin-flag-key">{detail.data.tracker.id}</code>
                {!detail.data.tracker.source && <Badge tone="warning">Unnamed</Badge>}
              </span>
            }
            description={detail.data.tracker.source ?? undefined}
          />
          <div className="admin-grid">
            <Card title="Link" description="Share this. The ref also works on harbor0.com pages.">
              <dl className="admin-facts">
                <dt>Sign-up</dt>
                <dd>
                  <CopyLink url={linkFor(detail.data.signupUrl, detail.data.tracker.id)} />
                </dd>
                <dt>Requested a link</dt>
                <dd>{detail.data.tracker.requests.toLocaleString()}</dd>
                <dt>Signed up</dt>
                <dd>{detail.data.tracker.signups.toLocaleString()}</dd>
                <dt>Accounts</dt>
                <dd>{detail.data.tracker.accounts.toLocaleString()}</dd>
              </dl>
            </Card>
            {/* A save reloads the tracker; starting the editor afresh drops the saved draft. */}
            <Editor key={detail.data.tracker.updatedAt ?? 'new'} detail={detail.data} />
          </div>
          <Card title="People" description="Everyone who arrived through this link, newest first.">
            {!detail.data.people.length ? (
              <p className="admin-empty">Nobody has used this link yet.</p>
            ) : (
              <DataTable label="People">
                <thead>
                  <tr>
                    <th>Email</th>
                    <th>Requested a link</th>
                    <th>Signed up</th>
                    <th>Account created</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.data.people.map((p) => (
                    <tr key={p.email}>
                      <td>
                        {p.userId ? (
                          <Link href={`/user?id=${encodeURIComponent(p.userId)}`}>{p.email}</Link>
                        ) : (
                          p.email
                        )}
                      </td>
                      <td className="admin-nowrap">{p.requestedAt ? date(p.requestedAt) : '—'}</td>
                      <td className="admin-nowrap">{p.signedUpAt ? date(p.signedUpAt) : '—'}</td>
                      <td className="admin-nowrap">{p.joinedAt ? date(p.joinedAt) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </DataTable>
            )}
          </Card>
        </>
      )}
    </>
  );
}

function TrackingPage() {
  const id = useSearchParams().get('id');
  return id ? <TrackerDetail key={id} id={id} /> : <TrackerList />;
}

export default function Page() {
  return (
    <Shell>
      <Suspense>
        <TrackingPage />
      </Suspense>
    </Shell>
  );
}
