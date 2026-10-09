'use client';
import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Copy, Plus, Trash2 } from 'lucide-react';
import type {
  Form,
  FormAudience,
  FormLimit,
  FormQuestion,
} from '../../../../packages/contracts/src/forms';
import { Alert } from '../../../web/components/ui/alert';
import { Badge } from '../../../web/components/ui/badge';
import { Button } from '../../../web/components/ui/button';
import { Card } from '../../../web/components/ui/card';
import { Dialog, DialogActions } from '../../../web/components/ui/dialog';
import { Field } from '../../../web/components/ui/field';
import { Input, Textarea } from '../../../web/components/ui/input';
import { Segmented } from '../../../web/components/ui/segmented';
import { Skeleton } from '../../../web/components/ui/skeleton';
import { DataTable } from '../../../web/components/ui/table';
import { AuditList } from '../../components/audit-list';
import {
  blankQuestions,
  cleanQuestions,
  QuestionsEditor,
  questionsIssue,
} from '../../components/form-questions';
import { FormResults } from '../../components/form-results';
import { PageHeader, Shell, useCan } from '../../components/shell';
import { api } from '../../lib/api';
import { relative } from '../../lib/format';

function StateBadge({ form }: { form: Form }) {
  return form.accepting ? <Badge tone="success">Open</Badge> : <Badge>Closed</Badge>;
}

/** A value with a Copy button, for the share link and the template snippet. */
function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="admin-form-link">
      <Input readOnly aria-label={label} value={value} onFocus={(e) => e.currentTarget.select()} />
      <Button
        variant="outline"
        size="sm"
        onClick={() =>
          void navigator.clipboard.writeText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
        }
      >
        <Copy aria-hidden="true" />
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  );
}

function FormList() {
  const router = useRouter();
  const canEdit = useCan('forms');
  const forms = useQuery({ queryKey: ['forms'], queryFn: api.forms });
  const open = (id: string) => router.push(`/forms?id=${encodeURIComponent(id)}`);
  return (
    <>
      <PageHeader
        title="Forms"
        description="Surveys and other forms, answered from a shared link or from a campaign email."
        action={
          canEdit && (
            <Button onClick={() => router.push('/forms?id=new')}>
              <Plus aria-hidden="true" />
              New form
            </Button>
          )
        }
      />
      {forms.isPending ? (
        <Skeleton className="admin-skeleton-block" />
      ) : forms.error ? (
        <p className="admin-empty">{forms.error.message}</p>
      ) : !forms.data.items.length ? (
        <p className="admin-empty">No forms yet.</p>
      ) : (
        <DataTable label="Forms">
          <thead>
            <tr>
              <th>Form</th>
              <th>Status</th>
              <th>Responses</th>
              <th>Last changed</th>
            </tr>
          </thead>
          <tbody>
            {forms.data.items.map((f) => (
              <tr
                key={f.id}
                tabIndex={0}
                className="admin-row-link"
                onClick={() => open(f.id)}
                onKeyDown={(e) => e.key === 'Enter' && open(f.id)}
              >
                <td>
                  <strong>{f.title}</strong>
                  <div className="admin-muted">
                    {f.questions.length} {f.questions.length === 1 ? 'question' : 'questions'}
                  </div>
                </td>
                <td>
                  <StateBadge form={f} />
                </td>
                <td className="admin-nowrap">
                  {f.responseCount.toLocaleString()}
                  {f.lastResponseAt && <div className="admin-muted">latest {relative(f.lastResponseAt)}</div>}
                </td>
                <td className="admin-nowrap">
                  {relative(f.updatedAt)}
                  <div className="admin-muted">{f.updatedBy}</div>
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}
    </>
  );
}

type Draft = {
  title: string;
  description: string;
  questions: FormQuestion[];
  audience: FormAudience;
  limit: FormLimit;
};
const blank = (): Draft => ({
  title: '',
  description: '',
  questions: blankQuestions(),
  audience: 'ANYONE',
  limit: 'ONE_PER_PERSON',
});

const audienceHints: Record<FormAudience, string> = {
  ANYONE:
    'Anyone with the link can answer. People signed in to harbor0, or opening their link from a campaign email, are recorded as themselves; others by their browser.',
  IDENTIFIED:
    'Only people signed in to harbor0, or opening their personal link from a campaign email, can answer. Every response is tied to an account or an email address.',
};
const limitHints: Record<FormLimit, Record<FormAudience, string>> = {
  ONE_PER_PERSON: {
    ANYONE:
      'Answering again replaces the earlier answers. Without a sign-in or an email link, a person is recognised by their browser, so a private window or another device can answer again.',
    IDENTIFIED: 'Answering again replaces the earlier answers. Each account or email address has one response.',
  },
  UNLIMITED: {
    ANYONE: 'Every submission is a new response.',
    IDENTIFIED: 'Every submission is a new response.',
  },
};

function Editor({ saved }: { saved: Form | null }) {
  const router = useRouter();
  const queries = useQueryClient();
  const canEdit = useCan('forms');
  const initial: Draft = saved
    ? {
        title: saved.title,
        description: saved.description,
        questions: saved.questions,
        audience: saved.audience,
        limit: saved.limit,
      }
    : blank();
  const [draft, setDraft] = useState<Draft>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [deleting, setDeleting] = useState(false);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const changed = JSON.stringify(initial) !== JSON.stringify(draft);
  const issue = questionsIssue(draft.questions);
  const complete = !!draft.title.trim() && !issue;
  const refresh = async (id: string) => {
    void queries.invalidateQueries({ queryKey: ['forms'] });
    void queries.invalidateQueries({ queryKey: ['audit'] });
    await queries.invalidateQueries({ queryKey: ['form', id] });
  };
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError('');
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
      const body = { ...draft, questions: cleanQuestions(draft.questions) };
      const result = saved
        ? await api.saveForm(saved.id, { ...body, expectedUpdatedAt: saved.updatedAt })
        : await api.createForm(body);
      await refresh(result.id);
      if (!saved) router.replace(`/forms?id=${encodeURIComponent(result.id)}`);
    });
  const toggle = () =>
    run(async () => {
      await api.setFormAccepting(saved!.id, !saved!.accepting);
      await refresh(saved!.id);
    });

  return (
    <>
      {error && <Alert tone="error">{error}</Alert>}
      {saved && (
        <Card
          title={saved.accepting ? 'Taking answers' : 'Not taking answers'}
          description={
            saved.accepting
              ? 'Anyone the settings allow can answer from the link.'
              : 'The link shows the questions but says the form is closed.'
          }
          action={
            canEdit && (
              <Button variant={saved.accepting ? 'outline' : 'primary'} disabled={busy || changed} onClick={() => void toggle()}>
                {saved.accepting ? 'Stop taking answers' : 'Start taking answers'}
              </Button>
            )
          }
        >
          <div className="admin-form">
            <Field label="Share link" hint="Works anywhere: a message, a post, a QR code.">
              <CopyField label="Share link" value={saved.link} />
            </Field>
            <Field
              label="In an email template"
              hint="Gives each recipient a personal link, so their answers are recorded with their email even without signing in."
            >
              <CopyField label="Template snippet" value={`[[Answer the survey]]({{form:${saved.id}}})`} />
            </Field>
          </div>
        </Card>
      )}
      <div className="admin-composer">
        <Card title="Form">
          <div className="admin-form">
            <Field label="Title" hint="Shown at the top of the form.">
              <Input value={draft.title} maxLength={120} disabled={!canEdit} onChange={(e) => set('title', e.target.value)} />
            </Field>
            <Field label="Description" hint="Optional. A line or two above the questions.">
              <Textarea
                rows={3}
                value={draft.description}
                maxLength={1000}
                disabled={!canEdit}
                onChange={(e) => set('description', e.target.value)}
              />
            </Field>
            <Field label="Who can answer" hint={audienceHints[draft.audience]}>
              <Segmented<FormAudience>
                label="Who can answer"
                value={draft.audience}
                disabled={!canEdit}
                onValueChange={(v) => set('audience', v)}
                options={[
                  { value: 'ANYONE', label: 'Anyone with the link' },
                  { value: 'IDENTIFIED', label: 'Members and email recipients' },
                ]}
              />
            </Field>
            <Field label="Responses" hint={limitHints[draft.limit][draft.audience]}>
              <Segmented<FormLimit>
                label="Responses"
                value={draft.limit}
                disabled={!canEdit}
                onValueChange={(v) => set('limit', v)}
                options={[
                  { value: 'ONE_PER_PERSON', label: 'One per person' },
                  { value: 'UNLIMITED', label: 'No limit' },
                ]}
              />
            </Field>
          </div>
        </Card>
        <Card
          title="Questions"
          description={
            saved?.responseCount
              ? 'This form has responses. Changing or reordering choices changes how earlier answers read.'
              : undefined
          }
        >
          <QuestionsEditor value={draft.questions} disabled={!canEdit} onChange={(q) => set('questions', q)} />
        </Card>
      </div>
      {canEdit && (
        <div className="admin-flag-save">
          <span className="admin-muted">
            {issue || (!saved ? 'Not saved yet. A new form starts closed.' : changed ? 'You have unsaved changes.' : 'Saved.')}
          </span>
          {saved && (
            <Button variant="ghost" onClick={() => setDeleting(true)}>
              <Trash2 aria-hidden="true" />
              Delete
            </Button>
          )}
          <Button disabled={busy || !complete || (!!saved && !changed)} onClick={() => void save()}>
            {saved ? 'Save changes' : 'Create form'}
          </Button>
        </div>
      )}
      <Dialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete ${saved?.title}`}
        description={`Its ${saved?.responseCount ?? 0} responses are deleted too, and its links stop working. This can't be undone.`}
      >
        <DialogActions>
          <Button variant="outline" onClick={() => setDeleting(false)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await api.deleteForm(saved!.id);
                setDeleting(false);
                void queries.invalidateQueries({ queryKey: ['forms'] });
                router.replace('/forms');
              })
            }
          >
            Delete form
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

function FormDetail({ id }: { id: string }) {
  const isNew = id === 'new';
  const detail = useQuery({ queryKey: ['form', id], queryFn: () => api.form(id), enabled: !isNew });
  const form = detail.data?.form;
  return (
    <>
      <Link href="/forms" className="admin-back">
        <ArrowLeft aria-hidden="true" />
        Forms
      </Link>
      {isNew ? (
        <>
          <PageHeader title="New form" />
          <Editor saved={null} />
        </>
      ) : detail.isPending ? (
        <div className="admin-loading">
          <Skeleton className="admin-skeleton-title" />
          <Skeleton className="admin-skeleton-block" />
        </div>
      ) : detail.error || !form ? (
        <p className="admin-empty">{detail.error?.message}</p>
      ) : (
        <>
          <PageHeader
            title={
              <span className="admin-title-row">
                {form.title}
                <StateBadge form={form} />
              </span>
            }
            description={`Changed ${relative(form.updatedAt)} by ${form.updatedBy}`}
          />
          {/* A save reloads the form; starting the editor afresh drops the saved draft. */}
          <Editor key={form.updatedAt} saved={form} />
          <FormResults form={form} live={form.accepting} />
          <Card title="History" description="Every change to this form, newest first.">
            <AuditList items={detail.data.history} />
          </Card>
        </>
      )}
    </>
  );
}

function FormsPage() {
  const id = useSearchParams().get('id');
  return id ? <FormDetail key={id} id={id} /> : <FormList />;
}

export default function Page() {
  return (
    <Shell>
      <Suspense>
        <FormsPage />
      </Suspense>
    </Shell>
  );
}
