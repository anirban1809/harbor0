'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import type {
  Form,
  FormAnswer,
  FormQuestion,
  FormResponse,
} from '../../../packages/contracts/src/forms';
import { Button } from '../../web/components/ui/button';
import { Card } from '../../web/components/ui/card';
import { Segmented } from '../../web/components/ui/segmented';
import { Skeleton } from '../../web/components/ui/skeleton';
import { DataTable } from '../../web/components/ui/table';
import { api } from '../lib/api';
import { relative } from '../lib/format';
import { questionKinds } from './form-questions';

export const viaLabels: Record<FormResponse['via'], string> = {
  EMAIL: 'Email link',
  ACCOUNT: 'Signed in',
  BROWSER: 'Browser',
  ANONYMOUS: 'Anonymous',
};
/** Who sent a response, as the console shows it. */
function Respondent({ response: r }: { response: FormResponse }) {
  if (r.userId)
    return <Link href={`/user?id=${encodeURIComponent(r.userId)}`}>{r.email ?? r.userId}</Link>;
  return <>{r.email ?? (r.via === 'BROWSER' ? 'A browser' : 'Anonymous')}</>;
}

const percent = (part: number, whole: number) => (whole ? Math.round((part / whole) * 100) : 0);

/** An answer as words, for the text list and the CSV. */
function answerText(question: FormQuestion, answer: FormAnswer | undefined) {
  if (answer === undefined) return '';
  if (question.kind === 'RATING' || typeof answer === 'string') return String(answer);
  if (Array.isArray(answer)) return answer.map((i) => question.options[i] ?? `#${i}`).join('; ');
  return question.options[answer] ?? `#${answer}`;
}

function download(questions: FormQuestion[], items: FormResponse[], name: string) {
  // Answers are typed by recipients: a leading = + - or @ would run as a spreadsheet formula.
  const cell = (raw: string) => {
    const value = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
    return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  };
  const rows = [
    ['Email', 'Name', 'Answered as', 'Answered', ...questions.map((q) => q.prompt)],
    ...items.map((r) => [
      r.email ?? '',
      r.name ?? '',
      viaLabels[r.via],
      r.submittedAt,
      ...questions.map((q) => answerText(q, r.answers[q.id])),
    ]),
  ];
  const blob = new Blob([rows.map((row) => row.map(cell).join(',')).join('\n')], {
    type: 'text/csv',
  });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `${name.replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'form'}-responses.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

function Bars({ rows, total }: { rows: { label: string; count: number }[]; total: number }) {
  return (
    <div className="admin-survey-bars">
      {rows.map((row) => (
        <div key={row.label} className="admin-survey-bar">
          <span className="admin-survey-bar-label">{row.label}</span>
          <div className="admin-meter-track">
            <div className="admin-meter-fill" style={{ width: `${percent(row.count, total)}%` }} />
          </div>
          <span className="admin-survey-bar-count">
            {row.count} · {percent(row.count, total)}%
          </span>
        </div>
      ))}
    </div>
  );
}

function QuestionResult({ question, items }: { question: FormQuestion; items: FormResponse[] }) {
  const [shown, setShown] = useState(10);
  const answered = items.filter((r) => r.answers[question.id] !== undefined);
  let summary = `${answered.length} answered`;
  let body;
  if (question.kind === 'RATING') {
    const values = answered.map((r) => r.answers[question.id] as number);
    const average = values.reduce((a, b) => a + b, 0) / (values.length || 1);
    summary += values.length ? ` · average ${average.toFixed(1)}` : '';
    if (question.scale === 10 && values.length) {
      const promoters = values.filter((v) => v >= 9).length;
      const detractors = values.filter((v) => v <= 6).length;
      summary += ` · NPS ${percent(promoters, values.length) - percent(detractors, values.length)}`;
    }
    const scale = Array.from({ length: question.scale === 10 ? 11 : 5 }, (_, i) =>
      question.scale === 10 ? i : i + 1,
    );
    body = (
      <Bars
        rows={scale.map((v) => ({ label: String(v), count: values.filter((x) => x === v).length }))}
        total={values.length}
      />
    );
  } else if (question.kind === 'TEXT') {
    body = answered.length ? (
      <ul className="admin-survey-texts">
        {answered.slice(0, shown).map((r) => (
          <li key={r.id}>
            <p>{r.answers[question.id] as string}</p>
            <span className="admin-muted">
              <Respondent response={r} /> · {relative(r.submittedAt)}
            </span>
          </li>
        ))}
        {answered.length > shown && (
          <li>
            <Button variant="ghost" size="sm" onClick={() => setShown((n) => n + 20)}>
              Show more
            </Button>
          </li>
        )}
      </ul>
    ) : null;
  } else {
    body = (
      <Bars
        rows={question.options.map((label, i) => ({
          label,
          count: answered.filter((r) => {
            const a = r.answers[question.id];
            return Array.isArray(a) ? a.includes(i) : a === i;
          }).length,
        }))}
        total={answered.length}
      />
    );
  }
  return (
    <div className="admin-survey-result">
      <div>
        <strong>{question.prompt}</strong>
        <div className="admin-muted">
          {questionKinds[question.kind]} · {summary}
        </div>
      </div>
      {body}
    </div>
  );
}

/** A form's responses: a summary of each question, everyone who answered, and a CSV. */
export function FormResults({ form, live }: { form: Form; live: boolean }) {
  const results = useQuery({
    queryKey: ['form-responses', form.id],
    queryFn: () => api.formResponses(form.id),
    refetchInterval: live ? 15_000 : false,
  });
  const [tab, setTab] = useState<'summary' | 'people'>('summary');
  if (results.isPending) return <Skeleton className="admin-skeleton-block" />;
  if (results.error) return <p className="admin-empty">{results.error.message}</p>;
  const items = results.data.items;
  const questions = form.questions;
  return (
    <Card
      title="Responses"
      description={`${items.length.toLocaleString()} ${items.length === 1 ? 'response' : 'responses'}${
        form.lastResponseAt ? `, the latest ${relative(form.lastResponseAt)}` : ''
      }.`}
      action={
        <span className="admin-actions">
          <Segmented
            label="Show"
            value={tab}
            onValueChange={setTab}
            options={[
              { value: 'summary', label: 'Summary' },
              { value: 'people', label: 'Each response' },
            ]}
          />
          <Button
            variant="outline"
            size="sm"
            disabled={!items.length}
            onClick={() => download(questions, items, form.title)}
          >
            <Download aria-hidden="true" />
            Download CSV
          </Button>
        </span>
      }
    >
      {!items.length ? (
        <p className="admin-empty">
          {form.accepting ? 'No responses yet.' : 'No responses yet. Open the form to start taking answers.'}
        </p>
      ) : tab === 'summary' ? (
        <div className="admin-survey-results">
          {questions.map((q) => (
            <QuestionResult key={q.id} question={q} items={items} />
          ))}
        </div>
      ) : (
        <DataTable label="Responses">
          <thead>
            <tr>
              <th>From</th>
              {questions.map((q) => (
                <th key={q.id}>{q.prompt}</th>
              ))}
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            {items.map((r) => (
              <tr key={r.id}>
                <td>
                  <Respondent response={r} />
                  <div className="admin-muted">{viaLabels[r.via]}</div>
                </td>
                {questions.map((q) => (
                  <td key={q.id} className="admin-survey-cell">
                    {answerText(q, r.answers[q.id]) || '—'}
                  </td>
                ))}
                <td className="admin-nowrap">{relative(r.submittedAt)}</td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}
    </Card>
  );
}
