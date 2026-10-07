'use client';
import { Suspense, useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CalendarClock, Plus, Send, Trash2, X } from 'lucide-react';
import type {
  Campaign,
  CampaignAudience,
  CampaignDetail,
  RecipientStatus,
} from '../../../../packages/contracts/src/campaigns';
import { Alert } from '../../../web/components/ui/alert';
import { Badge } from '../../../web/components/ui/badge';
import { Button } from '../../../web/components/ui/button';
import { Card } from '../../../web/components/ui/card';
import { Checkbox } from '../../../web/components/ui/checkbox';
import { Field } from '../../../web/components/ui/field';
import { Input } from '../../../web/components/ui/input';
import { Segmented } from '../../../web/components/ui/segmented';
import { Select } from '../../../web/components/ui/select';
import { Skeleton } from '../../../web/components/ui/skeleton';
import { DataTable } from '../../../web/components/ui/table';
import { AuditList } from '../../components/audit-list';
import { CampaignStateBadge, CategoryBadge, EmailNav } from '../../components/email-nav';
import { EmailPreview } from '../../components/email-preview';
import { ReasonDialog } from '../../components/reason-dialog';
import { PageHeader, Shell, useCan } from '../../components/shell';
import { api } from '../../lib/api';
import { date, people, plural, relative, skipReasonLabels } from '../../lib/format';

const open = (id: string) => `/campaigns?id=${encodeURIComponent(id)}`;
const live = (c: Campaign) => c.state === 'SCHEDULED' || c.state === 'SENDING';

function Progress({ campaign }: { campaign: Campaign }) {
  const { counts } = campaign;
  if (campaign.state === 'DRAFT') return <span className="admin-muted">—</span>;
  if (!counts.total)
    return <span className="admin-muted">{campaign.state === 'SCHEDULED' ? 'Not started' : 'Preparing…'}</span>;
  return (
    <span>
      {counts.sent.toLocaleString()} of {counts.total.toLocaleString()} sent
      {(counts.skipped > 0 || counts.failed > 0) && (
        <div className="admin-muted">
          {[counts.skipped && `${counts.skipped} skipped`, counts.failed && `${counts.failed} failed`]
            .filter(Boolean)
            .join(', ')}
        </div>
      )}
    </span>
  );
}

function CampaignList() {
  const router = useRouter();
  const canEdit = useCan('campaigns');
  const campaigns = useQuery({
    queryKey: ['campaigns'],
    queryFn: api.campaigns,
    refetchInterval: (q) => (q.state.data?.items.some(live) ? 5000 : false),
  });
  const go = (id: string) => router.push(open(id));
  return (
    <>
      <PageHeader
        title="Email campaigns"
        description="Write an email once and send it to groups of accounts, now or at a set time."
        action={
          canEdit && (
            <Button onClick={() => router.push(open('new'))}>
              <Plus aria-hidden="true" />
              New campaign
            </Button>
          )
        }
      />
      <EmailNav />
      {campaigns.isPending ? (
        <Skeleton className="admin-skeleton-block" />
      ) : campaigns.error ? (
        <p className="admin-empty">{campaigns.error.message}</p>
      ) : !campaigns.data.items.length ? (
        <p className="admin-empty">
          No campaigns yet. Write a template and make a group first, then send it here.
        </p>
      ) : (
        <DataTable label="Campaigns">
          <thead>
            <tr>
              <th>Campaign</th>
              <th>Status</th>
              <th>Progress</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            {campaigns.data.items.map((c) => (
              <tr
                key={c.id}
                tabIndex={0}
                className="admin-row-link"
                onClick={() => go(c.id)}
                onKeyDown={(e) => e.key === 'Enter' && go(c.id)}
              >
                <td>
                  <strong>{c.name}</strong>
                  <div className="admin-muted">{c.templateName ?? 'Template deleted'}</div>
                </td>
                <td>
                  <CampaignStateBadge state={c.state} />
                </td>
                <td>
                  <Progress campaign={c} />
                </td>
                <td className="admin-nowrap">
                  {c.state === 'DRAFT'
                    ? `Edited ${relative(c.updatedAt)}`
                    : c.finishedAt
                      ? `Finished ${relative(c.finishedAt)}`
                      : date(c.scheduledAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}
    </>
  );
}

type Account = { id: string; email: string | null };

/** A draft being written: its template and who it goes to. Saved as a whole. */
function DraftEditor({ detail }: { detail: CampaignDetail | null }) {
  const router = useRouter();
  const queries = useQueryClient();
  const canEdit = useCan('campaigns');
  const saved = detail?.campaign ?? null;
  const [name, setName] = useState(saved?.name ?? '');
  const [templateId, setTemplateId] = useState(saved?.templateId ?? '');
  const [groupIds, setGroupIds] = useState<string[]>(saved?.audience.groupIds ?? []);
  const [accounts, setAccounts] = useState<Account[]>(detail?.users ?? []);
  const [email, setEmail] = useState('');
  const [lookup, setLookup] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [scheduling, setScheduling] = useState(false);
  const [when, setWhen] = useState<'now' | 'later'>('now');
  const [at, setAt] = useState('');
  const templates = useQuery({ queryKey: ['email-templates'], queryFn: api.templates });
  const groups = useQuery({ queryKey: ['email-groups'], queryFn: api.groups });
  const template = templates.data?.items.find((t) => t.id === templateId);
  const audience: CampaignAudience = { groupIds, userIds: accounts.map((a) => a.id) };
  const count = useQuery({
    queryKey: ['audience-count', audience, template?.category],
    queryFn: () => api.audienceCount(audience, template!.category),
    enabled: !!template && (groupIds.length > 0 || accounts.length > 0),
  });
  const changed =
    !saved ||
    name !== saved.name ||
    templateId !== saved.templateId ||
    groupIds.join() !== saved.audience.groupIds.join() ||
    audience.userIds.join() !== saved.audience.userIds.join();
  const complete = !!name.trim() && !!templateId;

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await work();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const refresh = (id: string) => {
    void queries.invalidateQueries({ queryKey: ['campaigns'] });
    void queries.invalidateQueries({ queryKey: ['audit'] });
    return queries.invalidateQueries({ queryKey: ['campaign', id] });
  };
  const save = async () => {
    const body = { name: name.trim(), templateId, audience };
    const result = saved
      ? await api.saveCampaign(saved.id, { ...body, expectedUpdatedAt: saved.updatedAt })
      : await api.createCampaign(body);
    await refresh(result.id);
    if (!saved) router.replace(open(result.id));
    return result;
  };
  const add = async (event: FormEvent) => {
    event.preventDefault();
    const wanted = email.trim().toLowerCase();
    if (accounts.some((a) => a.email?.toLowerCase() === wanted))
      return setLookup('This account is already added.');
    try {
      const page = await api.users(wanted, null);
      const match = page.items.find((u) => u.email.toLowerCase() === wanted && !u.deleted);
      if (!match) return setLookup('No account uses this email.');
      setAccounts((list) => [...list, { id: match.id, email: match.email }]);
      setEmail('');
      setLookup('');
    } catch (e) {
      setLookup((e as Error).message);
    }
  };
  const schedule = async (reason: string) => {
    // Unsaved edits are saved first, so what is scheduled is what's on screen.
    const current = changed ? await save() : saved!;
    await api.scheduleCampaign(
      current.id,
      when === 'now' ? null : new Date(at).toISOString(),
      reason,
      current.updatedAt,
    );
    await refresh(current.id);
  };
  const eligible = count.data?.eligible ?? 0;

  return (
    <>
      {notice && (
        <Alert tone="success" onDismiss={() => setNotice('')}>
          {notice}
        </Alert>
      )}
      {error && <Alert tone="error">{error}</Alert>}
      <div className="admin-composer">
        <div className="admin-stack">
          <Card title="Campaign">
            <div className="admin-form">
              <Field label="Name" hint="Only staff see this.">
                <Input
                  value={name}
                  maxLength={120}
                  disabled={!canEdit}
                  onChange={(e) => setName(e.target.value)}
                />
              </Field>
              <Field
                label="Template"
                hint={
                  <>
                    The template is copied when you schedule, so later edits to it don&apos;t change
                    this campaign. <Link href="/email-templates?id=new">New template</Link>
                  </>
                }
              >
                <Select
                  block
                  value={templateId}
                  disabled={!canEdit}
                  onChange={(e) => setTemplateId(e.target.value)}
                >
                  <option value="">Choose a template…</option>
                  {templates.data?.items.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} ({t.category === 'PRODUCT' ? 'product update' : 'service notice'})
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          </Card>
          <Card
            title="Recipients"
            description="Accounts in any of the chosen groups, plus any added one by one. Each gets one email."
          >
            {groups.data && !groups.data.items.length ? (
              <p className="admin-empty">
                No groups yet. <Link href="/email-groups">Make a group</Link> of accounts first.
              </p>
            ) : (
              <div className="admin-choices">
                {groups.data?.items.map((g) => (
                  <label key={g.id} className="choice">
                    <Checkbox
                      checked={groupIds.includes(g.id)}
                      disabled={!canEdit}
                      onChange={(e) =>
                        setGroupIds((ids) =>
                          e.target.checked ? [...ids, g.id] : ids.filter((id) => id !== g.id),
                        )
                      }
                    />
                    <span>
                      <strong>{g.name}</strong>
                      <span className="admin-muted">{plural(g.memberCount, 'account')}</span>
                    </span>
                  </label>
                ))}
              </div>
            )}
            {canEdit && (
              <form className="admin-flag-add" onSubmit={add}>
                <Input
                  type="email"
                  aria-label="Account email"
                  placeholder="Add one account by email"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    setLookup('');
                  }}
                />
                <Button type="submit" variant="outline" disabled={!email.trim()}>
                  Add
                </Button>
              </form>
            )}
            {lookup && <Alert tone="error">{lookup}</Alert>}
            {accounts.length > 0 && (
              <ul className="admin-flag-users">
                {accounts.map((a) => (
                  <li key={a.id}>
                    <Link href={`/user?id=${encodeURIComponent(a.id)}`}>{a.email ?? a.id}</Link>
                    {canEdit && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Remove ${a.email ?? a.id}`}
                        onClick={() => setAccounts((list) => list.filter((x) => x.id !== a.id))}
                      >
                        <X aria-hidden="true" />
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <div className="admin-count">
              {!template ? (
                <span className="admin-muted">Choose a template to count who gets it.</span>
              ) : !count.data && !count.isFetching ? (
                <span className="admin-muted">No one chosen yet.</span>
              ) : count.isFetching && !count.data ? (
                <span className="admin-muted">Counting…</span>
              ) : (
                <>
                  <strong>{people(eligible)} will get this email</strong>
                  {Object.entries(count.data!.skipped).length > 0 && (
                    <span className="admin-muted">
                      {' '}
                      · skipped:{' '}
                      {Object.entries(count.data!.skipped)
                        .map(([reason, n]) => `${n} ${skipReasonLabels[reason as keyof typeof skipReasonLabels].toLowerCase()}`)
                        .join(', ')}
                    </span>
                  )}
                </>
              )}
            </div>
          </Card>
          {canEdit && (
            <div className="admin-flag-save">
              <span className="admin-muted">
                {!saved ? 'Not saved yet.' : changed ? 'You have unsaved changes.' : 'Draft saved.'}
              </span>
              {saved && (
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await api.deleteCampaign(saved.id);
                      void queries.invalidateQueries({ queryKey: ['campaigns'] });
                      router.replace('/campaigns');
                    })
                  }
                >
                  <Trash2 aria-hidden="true" />
                  Delete draft
                </Button>
              )}
              <Button
                variant="outline"
                disabled={busy || !complete || !changed}
                onClick={() =>
                  void run(async () => {
                    await save();
                    setNotice('Draft saved.');
                  })
                }
              >
                Save draft
              </Button>
              <Button
                disabled={busy || !complete || !eligible}
                onClick={() => {
                  setWhen('now');
                  setAt('');
                  setScheduling(true);
                }}
              >
                <CalendarClock aria-hidden="true" />
                Send or schedule…
              </Button>
            </div>
          )}
        </div>
        <Card
          title="Email"
          description={template ? template.name : 'Choose a template to preview it.'}
          action={
            template &&
            canEdit && (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const { sentTo } = await api.sendTest({
                      subject: template.subject,
                      preheader: template.preheader,
                      markdown: template.markdown,
                      category: template.category,
                    });
                    setNotice(`Test sent to ${sentTo}. It arrives within a minute.`);
                  })
                }
              >
                <Send aria-hidden="true" />
                Send me a test
              </Button>
            )
          }
        >
          {template ? (
            <EmailPreview content={template} />
          ) : (
            <p className="admin-empty">No template chosen.</p>
          )}
        </Card>
      </div>
      <ReasonDialog
        open={scheduling}
        onOpenChange={setScheduling}
        title={`Send to ${people(eligible)}`}
        description={
          template?.category === 'SERVICE'
            ? 'A service notice goes to everyone in the audience, including people who turned product updates off.'
            : 'People who turned product updates off are skipped.'
        }
        confirmLabel={when === 'now' ? `Send to ${people(eligible)}` : 'Schedule'}
        canSubmit={when === 'now' || (!!at && new Date(at).getTime() > Date.now())}
        danger={when === 'now'}
        onConfirm={schedule}
      >
        <Segmented
          label="When"
          value={when}
          onValueChange={setWhen}
          options={[
            { value: 'now', label: 'Send now' },
            { value: 'later', label: 'Schedule' },
          ]}
        />
        {when === 'later' && (
          <Field
            label="Send at"
            hint={`Your time zone (${Intl.DateTimeFormat().resolvedOptions().timeZone}). Sending starts within a minute of this time; you can cancel until then.`}
          >
            <Input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />
          </Field>
        )}
      </ReasonDialog>
    </>
  );
}

const statuses: { value: RecipientStatus | 'ALL'; label: string }[] = [
  { value: 'ALL', label: 'All' },
  { value: 'SENT', label: 'Sent' },
  { value: 'PENDING', label: 'Waiting' },
  { value: 'SKIPPED', label: 'Skipped' },
  { value: 'FAILED', label: 'Failed' },
];

function Recipients({ id, live }: { id: string; live: boolean }) {
  const [status, setStatus] = useState<RecipientStatus | 'ALL'>('ALL');
  const recipients = useInfiniteQuery({
    queryKey: ['campaign-recipients', id, status],
    queryFn: ({ pageParam }) => api.recipients(id, status === 'ALL' ? undefined : status, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: live ? 5000 : false,
  });
  const all = recipients.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <Card
      title="Recipients"
      action={<Segmented label="Show" value={status} onValueChange={setStatus} options={statuses} />}
    >
      {recipients.isPending ? (
        <Skeleton className="admin-skeleton-block" />
      ) : !all.length ? (
        <p className="admin-empty">
          {live && status === 'ALL' ? 'The list is made when sending starts.' : 'No one here.'}
        </p>
      ) : (
        <>
          <DataTable label="Recipients">
            <thead>
              <tr>
                <th>Account</th>
                <th>Status</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {all.map((r) => (
                <tr key={r.userId}>
                  <td>
                    <Link href={`/user?id=${encodeURIComponent(r.userId)}`}>{r.email ?? r.userId}</Link>
                    {r.name && <div className="admin-muted">{r.name}</div>}
                  </td>
                  <td>
                    {r.status === 'SENT' ? (
                      <Badge tone="success">Sent</Badge>
                    ) : r.status === 'PENDING' ? (
                      <Badge>Waiting</Badge>
                    ) : r.status === 'FAILED' ? (
                      <Badge tone="danger">Failed</Badge>
                    ) : (
                      <Badge tone="warning">Skipped</Badge>
                    )}
                    {(r.reason || r.error) && (
                      <div className="admin-muted">{r.reason ? skipReasonLabels[r.reason] : r.error}</div>
                    )}
                  </td>
                  <td className="admin-nowrap">{r.at ? relative(r.at) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </DataTable>
          {recipients.hasNextPage && (
            <div className="admin-more">
              <Button
                variant="outline"
                disabled={recipients.isFetchingNextPage}
                onClick={() => void recipients.fetchNextPage()}
              >
                Show more
              </Button>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

/** A campaign that is scheduled, sending or done: progress, controls, and who got it. */
function SentView({ detail }: { detail: CampaignDetail }) {
  const queries = useQueryClient();
  const canEdit = useCan('campaigns');
  const c = detail.campaign;
  const [confirm, setConfirm] = useState<'cancel' | 'stop' | null>(null);
  const done = Math.max(0, c.counts.total - c.counts.pending);
  const refresh = () => {
    void queries.invalidateQueries({ queryKey: ['campaigns'] });
    void queries.invalidateQueries({ queryKey: ['audit'] });
    return queries.invalidateQueries({ queryKey: ['campaign', c.id] });
  };
  return (
    <>
      <div className="admin-stats">
        {(
          [
            ['Sent', c.counts.sent],
            ['Waiting', c.counts.pending],
            ['Skipped', c.counts.skipped],
            ['Failed', c.counts.failed],
          ] as const
        ).map(([label, value]) => (
          <div key={label} className="admin-stat">
            <span className="admin-stat-label">{label}</span>
            <span className="admin-stat-value">{value.toLocaleString()}</span>
          </div>
        ))}
      </div>
      {c.counts.total > 0 && (
        <progress className="progress admin-campaign-progress" max={c.counts.total} value={done} />
      )}
      <Card
        title="Sending"
        action={
          canEdit &&
          (c.state === 'SCHEDULED' ? (
            <Button variant="outline" onClick={() => setConfirm('cancel')}>
              Cancel schedule
            </Button>
          ) : c.state === 'SENDING' ? (
            <Button variant="danger" onClick={() => setConfirm('stop')}>
              Stop sending
            </Button>
          ) : null)
        }
      >
        <dl className="admin-facts">
          <dt>{c.state === 'SCHEDULED' ? 'Sends at' : 'Scheduled for'}</dt>
          <dd>
            {date(c.scheduledAt)} by {c.scheduledBy}
          </dd>
          {c.startedAt && (
            <>
              <dt>Started</dt>
              <dd>{date(c.startedAt)}</dd>
            </>
          )}
          {c.finishedAt && (
            <>
              <dt>Finished</dt>
              <dd>{date(c.finishedAt)}</dd>
            </>
          )}
          <dt>Audience</dt>
          <dd>
            {[
              ...detail.groups.map((g) => g.name ?? 'Deleted group'),
              ...detail.users.map((u) => u.email ?? u.id),
            ].join(', ') || '—'}
          </dd>
        </dl>
      </Card>
      <div className="admin-composer">
        <Recipients id={c.id} live={live(c)} />
        <Card title="Email" description="The copy taken when the campaign was scheduled.">
          {c.content && <EmailPreview content={c.content} />}
        </Card>
      </div>
      <ReasonDialog
        open={confirm === 'cancel'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Cancel the schedule"
        description="Nothing has been sent. The campaign goes back to a draft you can change and schedule again."
        confirmLabel="Cancel schedule"
        onConfirm={async (reason) => {
          await api.cancelCampaign(c.id, reason);
          await refresh();
        }}
      />
      <ReasonDialog
        open={confirm === 'stop'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Stop sending"
        description={`${plural(c.counts.sent, 'email')} already sent can't be recalled. Everyone not yet sent to is skipped, within about 25 emails.`}
        confirmLabel="Stop sending"
        danger
        onConfirm={async (reason) => {
          await api.stopCampaign(c.id, reason);
          await refresh();
        }}
      />
    </>
  );
}

function CampaignPage({ id }: { id: string }) {
  const isNew = id === 'new';
  const detail = useQuery({
    queryKey: ['campaign', id],
    queryFn: () => api.campaign(id),
    enabled: !isNew,
    refetchInterval: (q) => (q.state.data && live(q.state.data.campaign) ? 5000 : false),
  });
  const c = detail.data?.campaign;
  // A draft editor starts afresh when the saved draft changes (e.g. after a save).
  const [editorKey, setEditorKey] = useState('');
  useEffect(() => setEditorKey(c?.updatedAt ?? ''), [c?.updatedAt]);
  return (
    <>
      <Link href="/campaigns" className="admin-back">
        <ArrowLeft aria-hidden="true" />
        Campaigns
      </Link>
      {isNew ? (
        <>
          <PageHeader title="New campaign" />
          <DraftEditor detail={null} />
        </>
      ) : detail.isPending ? (
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
                {c!.name}
                <CampaignStateBadge state={c!.state} />
                {c!.content && <CategoryBadge category={c!.content.category} />}
              </span>
            }
            description={`Created ${relative(c!.createdAt)} by ${c!.createdBy}`}
          />
          {c!.state === 'DRAFT' ? (
            <DraftEditor key={editorKey} detail={detail.data} />
          ) : (
            <SentView detail={detail.data} />
          )}
          <Card title="History" description="Every change to this campaign, newest first.">
            <AuditList items={detail.data.history} />
          </Card>
        </>
      )}
    </>
  );
}

function CampaignsPage() {
  const id = useSearchParams().get('id');
  return id ? <CampaignPage key={id} id={id} /> : <CampaignList />;
}

export default function Page() {
  return (
    <Shell>
      <Suspense>
        <CampaignsPage />
      </Suspense>
    </Shell>
  );
}
