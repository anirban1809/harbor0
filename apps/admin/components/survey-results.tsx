'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import type {
  SurveyAnswer,
  SurveyQuestion,
  SurveyResponse,
} from '../../../packages/contracts/src/campaigns';
import { Button } from '../../web/components/ui/button';
import { Card } from '../../web/components/ui/card';
import { Skeleton } from '../../web/components/ui/skeleton';
import { api } from '../lib/api';
import { relative } from '../lib/format';
import { surveyKinds } from './survey-editor';

const percent = (part: number, whole: number) => (whole ? Math.round((part / whole) * 100) : 0);

/** An answer as words, for the text list and the CSV. */
function answerText(question: SurveyQuestion, answer: SurveyAnswer | undefined) {
  if (answer === undefined) return '';
  if (question.kind === 'RATING' || typeof answer === 'string') return String(answer);
  if (Array.isArray(answer)) return answer.map((i) => question.options[i] ?? `#${i}`).join('; ');
  return question.options[answer] ?? `#${answer}`;
}

function download(questions: SurveyQuestion[], items: SurveyResponse[], name: string) {
  // Answers are typed by recipients: a leading = + - or @ would run as a spreadsheet formula.
  const cell = (raw: string) => {
    const value = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
    return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  };
  const rows = [
    ['Email', 'Name', 'Answered', ...questions.map((q) => q.prompt)],
    ...items.map((r) => [
      r.email ?? '',
      r.name ?? '',
      r.submittedAt,
      ...questions.map((q) => answerText(q, r.answers[q.id])),
    ]),
  ];
  const blob = new Blob([rows.map((row) => row.map(cell).join(',')).join('\n')], {
    type: 'text/csv',
  });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `${name.replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'survey'}-answers.csv`;
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

function QuestionResult({ question, items }: { question: SurveyQuestion; items: SurveyResponse[] }) {
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
          <li key={r.userId ?? r.email}>
            <p>{r.answers[question.id] as string}</p>
            <span className="admin-muted">
              {r.userId ? (
                <Link href={`/user?id=${encodeURIComponent(r.userId)}`}>{r.email ?? r.userId}</Link>
              ) : (
                r.email
              )}{' '}
              · {relative(r.submittedAt)}
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
          {surveyKinds[question.kind]} · {summary}
        </div>
      </div>
      {body}
    </div>
  );
}

/** What a sent campaign's survey got back: a summary of each question, and a CSV of every answer. */
export function SurveyResults({ id, name, live }: { id: string; name: string; live: boolean }) {
  const results = useQuery({
    queryKey: ['campaign-survey', id],
    queryFn: () => api.surveyResults(id),
    refetchInterval: live ? 10_000 : 60_000,
  });
  const data = results.data;
  if (results.isPending) return <Skeleton className="admin-skeleton-block" />;
  if (results.error) return <p className="admin-empty">{results.error.message}</p>;
  if (!data?.survey) return null;
  const questions = data.survey.questions;
  return (
    <Card
      title="Survey answers"
      description={`${data.items.length.toLocaleString()} of ${data.sent.toLocaleString()} recipients answered (${percent(data.items.length, data.sent)}%).`}
      action={
        <Button
          variant="outline"
          size="sm"
          disabled={!data.items.length}
          onClick={() => download(questions, data.items, name)}
        >
          <Download aria-hidden="true" />
          Download CSV
        </Button>
      }
    >
      {data.items.length ? (
        <div className="admin-survey-results">
          {questions.map((q) => (
            <QuestionResult key={q.id} question={q} items={data.items} />
          ))}
        </div>
      ) : (
        <p className="admin-empty">No answers yet.</p>
      )}
    </Card>
  );
}
