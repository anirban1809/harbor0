'use client';
import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Plus, Send, Trash2 } from 'lucide-react';
import {
  campaignVariables,
  type CampaignCategory,
  type EmailTemplate,
} from '../../../../packages/contracts/src/campaigns';
import { Alert } from '../../../web/components/ui/alert';
import { Button } from '../../../web/components/ui/button';
import { Card } from '../../../web/components/ui/card';
import { Dialog, DialogActions } from '../../../web/components/ui/dialog';
import { Field } from '../../../web/components/ui/field';
import { Input, Textarea } from '../../../web/components/ui/input';
import { Segmented } from '../../../web/components/ui/segmented';
import { Skeleton } from '../../../web/components/ui/skeleton';
import { DataTable } from '../../../web/components/ui/table';
import { AuditList } from '../../components/audit-list';
import { CategoryBadge, EmailNav } from '../../components/email-nav';
import { EmailPreview } from '../../components/email-preview';
import { PageHeader, Shell, useCan } from '../../components/shell';
import { api } from '../../lib/api';
import { relative } from '../../lib/format';

const starter = `# Hello {{firstName}}

Write your message here. **Bold**, *italic*, [links](https://harbor0.com) and lists work:

- One thing
- Another

[[Open harbor0]](https://app.harbor0.com)`;

function TemplateList() {
  const router = useRouter();
  const canEdit = useCan('campaigns');
  const templates = useQuery({ queryKey: ['email-templates'], queryFn: api.templates });
  const open = (id: string) => router.push(`/email-templates?id=${encodeURIComponent(id)}`);
  return (
    <>
      <PageHeader
        title="Email campaigns"
        description="Write an email once and send it to groups of accounts, now or at a set time."
        action={
          canEdit && (
            <Button onClick={() => router.push('/email-templates?id=new')}>
              <Plus aria-hidden="true" />
              New template
            </Button>
          )
        }
      />
      <EmailNav />
      {templates.isPending ? (
        <Skeleton className="admin-skeleton-block" />
      ) : templates.error ? (
        <p className="admin-empty">{templates.error.message}</p>
      ) : !templates.data.items.length ? (
        <p className="admin-empty">No templates yet. A campaign sends one of these.</p>
      ) : (
        <DataTable label="Templates">
          <thead>
            <tr>
              <th>Template</th>
              <th>Kind</th>
              <th>Last changed</th>
            </tr>
          </thead>
          <tbody>
            {templates.data.items.map((t) => (
              <tr
                key={t.id}
                tabIndex={0}
                className="admin-row-link"
                onClick={() => open(t.id)}
                onKeyDown={(e) => e.key === 'Enter' && open(t.id)}
              >
                <td>
                  <strong>{t.name}</strong>
                  <div className="admin-muted">{t.subject}</div>
                </td>
                <td>
                  <CategoryBadge category={t.category} />
                </td>
                <td className="admin-nowrap">
                  {relative(t.updatedAt)}
                  <div className="admin-muted">{t.updatedBy}</div>
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}
    </>
  );
}

type Draft = Pick<EmailTemplate, 'name' | 'category' | 'subject' | 'preheader' | 'markdown'>;
const blank: Draft = { name: '', category: 'PRODUCT', subject: '', preheader: '', markdown: starter };

function Editor({ saved, onSaved }: { saved: EmailTemplate | null; onSaved: (t: EmailTemplate) => void }) {
  const router = useRouter();
  const queries = useQueryClient();
  const canEdit = useCan('campaigns');
  // Only the editable fields: the save endpoints refuse the stored id and timestamps.
  const initial: Draft = saved
    ? {
        name: saved.name,
        category: saved.category,
        subject: saved.subject,
        preheader: saved.preheader,
        markdown: saved.markdown,
      }
    : blank;
  const [draft, setDraft] = useState<Draft>(initial);
  const [sampleEmail, setSampleEmail] = useState('');
  const [sample, setSample] = useState<{ id?: string; error?: string }>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [deleting, setDeleting] = useState(false);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));
  const changed = (Object.keys(initial) as (keyof Draft)[]).some((k) => initial[k] !== draft[k]);
  const complete = !!draft.name.trim() && !!draft.subject.trim() && !!draft.markdown.trim();

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
  const save = () =>
    run(async () => {
      const result = saved
        ? await api.saveTemplate(saved.id, { ...draft, expectedUpdatedAt: saved.updatedAt })
        : await api.createTemplate(draft);
      void queries.invalidateQueries({ queryKey: ['email-templates'] });
      void queries.invalidateQueries({ queryKey: ['audit'] });
      await queries.invalidateQueries({ queryKey: ['email-template', result.id] });
      onSaved(result);
      if (!saved) router.replace(`/email-templates?id=${encodeURIComponent(result.id)}`);
    });
  const test = () =>
    run(async () => {
      const { name: _, ...content } = draft;
      const { sentTo } = await api.sendTest({ ...content, sampleUserId: sample.id });
      setNotice(`Test sent to ${sentTo}. It arrives within a minute.`);
    });
  const pickSample = async () => {
    const wanted = sampleEmail.trim().toLowerCase();
    if (!wanted) return setSample({});
    try {
      const page = await api.users(wanted, null);
      const match = page.items.find((u) => u.email.toLowerCase() === wanted);
      setSample(match ? { id: match.id } : { error: 'No account uses this email.' });
    } catch (e) {
      setSample({ error: (e as Error).message });
    }
  };

  return (
    <>
      {notice && (
        <Alert tone="success" onDismiss={() => setNotice('')}>
          {notice}
        </Alert>
      )}
      {error && <Alert tone="error">{error}</Alert>}
      <div className="admin-composer">
        <Card title="Content">
          <div className="admin-form">
            <Field label="Template name" hint="Only staff see this.">
              <Input
                value={draft.name}
                maxLength={100}
                disabled={!canEdit}
                onChange={(e) => set('name', e.target.value)}
              />
            </Field>
            <Field
              label="Kind"
              hint={
                draft.category === 'PRODUCT'
                  ? 'Has an unsubscribe link and skips accounts that turned product updates off.'
                  : 'For terms, pricing and other changes every account must hear about. Sent to everyone, with no unsubscribe link.'
              }
            >
              <Segmented<CampaignCategory>
                label="Kind"
                value={draft.category}
                disabled={!canEdit}
                onValueChange={(v) => set('category', v)}
                options={[
                  { value: 'PRODUCT', label: 'Product update' },
                  { value: 'SERVICE', label: 'Service notice' },
                ]}
              />
            </Field>
            <Field label="Subject">
              <Input
                value={draft.subject}
                maxLength={200}
                disabled={!canEdit}
                onChange={(e) => set('subject', e.target.value)}
              />
            </Field>
            <Field label="Preview line" hint="Shown after the subject in most inboxes.">
              <Input
                value={draft.preheader}
                maxLength={200}
                disabled={!canEdit}
                onChange={(e) => set('preheader', e.target.value)}
              />
            </Field>
            <Field
              label="Message"
              hint={
                <>
                  Markdown: # headings, **bold**, *italic*, [links](https://…), - lists, --- for a
                  line, and [[Button]](https://…) for a button. Variables:{' '}
                  {Object.entries(campaignVariables).map(([key, description], i) => (
                    <span key={key} title={description}>
                      {i > 0 && ', '}
                      <code>{`{{${key}}}`}</code>
                    </span>
                  ))}
                  .
                </>
              }
            >
              <Textarea
                className="admin-markdown"
                rows={18}
                value={draft.markdown}
                maxLength={50_000}
                disabled={!canEdit}
                onChange={(e) => set('markdown', e.target.value)}
              />
            </Field>
          </div>
          {canEdit && (
            <div className="admin-flag-save">
              <span className="admin-muted">
                {!saved ? 'Not saved yet.' : changed ? 'You have unsaved changes.' : 'Saved.'}
              </span>
              {saved && (
                <Button variant="ghost" onClick={() => setDeleting(true)}>
                  <Trash2 aria-hidden="true" />
                  Delete
                </Button>
              )}
              <Button variant="outline" disabled={busy || !complete} onClick={() => void test()}>
                <Send aria-hidden="true" />
                Send me a test
              </Button>
              <Button disabled={busy || !complete || (!!saved && !changed)} onClick={() => void save()}>
                {saved ? 'Save changes' : 'Create template'}
              </Button>
            </div>
          )}
        </Card>
        <Card
          title="Preview"
          description="Exactly as recipients get it."
          action={
            <form
              className="admin-flag-add"
              onSubmit={(e) => {
                e.preventDefault();
                void pickSample();
              }}
            >
              <Input
                type="email"
                aria-label="Preview as account"
                placeholder="Preview as… (account email)"
                value={sampleEmail}
                onChange={(e) => {
                  setSampleEmail(e.target.value);
                  setSample({});
                }}
              />
              <Button type="submit" variant="outline" size="sm">
                Use
              </Button>
            </form>
          }
        >
          {sample.error && <Alert tone="error">{sample.error}</Alert>}
          <EmailPreview
            content={{
              subject: draft.subject,
              preheader: draft.preheader,
              markdown: draft.markdown,
              category: draft.category,
            }}
            sampleUserId={sample.id}
          />
        </Card>
      </div>
      <Dialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete ${saved?.name}`}
        description="Campaigns already scheduled or sent keep their own copy. Drafts using it must be changed first."
      >
        <DialogActions>
          <Button variant="outline" onClick={() => setDeleting(false)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={() =>
              void run(async () => {
                await api.deleteTemplate(saved!.id);
                setDeleting(false);
                void queries.invalidateQueries({ queryKey: ['email-templates'] });
                router.replace('/email-templates');
              }).then(() => setDeleting(false))
            }
          >
            Delete template
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

function TemplateDetail({ id }: { id: string }) {
  const isNew = id === 'new';
  const detail = useQuery({
    queryKey: ['email-template', id],
    queryFn: () => api.template(id),
    enabled: !isNew,
  });
  const [version, setVersion] = useState(0);
  return (
    <>
      <Link href="/email-templates" className="admin-back">
        <ArrowLeft aria-hidden="true" />
        Templates
      </Link>
      {isNew ? (
        <>
          <PageHeader title="New template" />
          <Editor saved={null} onSaved={() => setVersion((v) => v + 1)} />
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
                {detail.data.template.name}
                <CategoryBadge category={detail.data.template.category} />
              </span>
            }
            description={`Changed ${relative(detail.data.template.updatedAt)} by ${detail.data.template.updatedBy}`}
          />
          {/* A save reloads the template; starting the editor afresh drops the saved draft. */}
          <Editor
            key={`${detail.data.template.updatedAt}:${version}`}
            saved={detail.data.template}
            onSaved={() => setVersion((v) => v + 1)}
          />
          <Card title="History" description="Every change to this template, newest first.">
            <AuditList items={detail.data.history} />
          </Card>
        </>
      )}
    </>
  );
}

function TemplatesPage() {
  const id = useSearchParams().get('id');
  return id ? <TemplateDetail key={id} id={id} /> : <TemplateList />;
}

export default function Page() {
  return (
    <Shell>
      <Suspense>
        <TemplatesPage />
      </Suspense>
    </Shell>
  );
}
