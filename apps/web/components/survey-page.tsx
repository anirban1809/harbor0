'use client';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import type {
  SurveyAnswer,
  SurveyAnswers,
  SurveyForm,
  SurveyQuestion,
} from '../../../packages/contracts/src/campaigns';
import { BrandLogo } from './brand-logo';
import { Alert } from './ui/alert';
import { Button } from './ui/button';
import { Checkbox, Radio } from './ui/checkbox';
import { Textarea } from './ui/input';

type ApiError = { code: string; message: string };

async function call<T>(token: string, body?: unknown): Promise<T & { error?: ApiError }> {
  try {
    const response = await fetch(`/api/v1/email/survey?t=${encodeURIComponent(token)}`, {
      method: body ? 'POST' : 'GET',
      cache: 'no-store',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return await response.json();
  } catch {
    return { error: { code: 'NETWORK', message: 'harbor0 could not be reached. Try again.' } } as T & {
      error: ApiError;
    };
  }
}

/** The answer an email's one-click link carries, if it fits the first question. */
function clicked(question: SurveyQuestion | undefined, raw: string | null): SurveyAnswer | undefined {
  if (!question || raw === null || !/^\d{1,2}$/.test(raw)) return undefined;
  const value = Number(raw);
  if (question.kind === 'RATING')
    return value >= (question.scale === 10 ? 0 : 1) && value <= question.scale ? value : undefined;
  if (question.kind === 'CHOICE') return value < question.options.length ? value : undefined;
  return undefined;
}

const longDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { dateStyle: 'long' });

function Question({
  question,
  value,
  disabled,
  onChange,
}: {
  question: SurveyQuestion;
  value: SurveyAnswer | undefined;
  disabled: boolean;
  onChange: (value: SurveyAnswer | undefined) => void;
}) {
  const name = `q-${question.id}`;
  const legend = (
    <legend>
      {question.prompt}
      {question.required && (
        <span className="survey-required" aria-label="required">
          *
        </span>
      )}
    </legend>
  );
  if (question.kind === 'TEXT')
    return (
      <fieldset className="survey-question">
        {legend}
        <Textarea
          aria-label={question.prompt}
          rows={4}
          maxLength={2000}
          disabled={disabled}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
        />
      </fieldset>
    );
  if (question.kind === 'RATING') {
    const values = Array.from({ length: question.scale === 10 ? 11 : 5 }, (_, i) =>
      question.scale === 10 ? i : i + 1,
    );
    return (
      <fieldset className="survey-question">
        {legend}
        <div className="survey-scale" data-count={values.length}>
          {values.map((v) => (
            <label key={v} className="survey-scale-option">
              <input
                type="radio"
                name={name}
                aria-label={String(v)}
                disabled={disabled}
                checked={value === v}
                onChange={() => onChange(v)}
              />
              <span>{v}</span>
            </label>
          ))}
        </div>
        <div className="survey-scale-ends" aria-hidden="true">
          <span>{question.scale === 10 ? 'Not likely' : 'Poor'}</span>
          <span>{question.scale === 10 ? 'Very likely' : 'Great'}</span>
        </div>
      </fieldset>
    );
  }
  const chosen = Array.isArray(value) ? value : [];
  return (
    <fieldset className="survey-question">
      {legend}
      <div className="survey-options">
        {question.options.map((option, i) => (
          <label key={i} className="survey-option">
            {question.kind === 'CHOICE' ? (
              <Radio
                name={name}
                aria-label={option}
                disabled={disabled}
                checked={value === i}
                onChange={() => onChange(i)}
              />
            ) : (
              <Checkbox
                aria-label={option}
                disabled={disabled}
                checked={chosen.includes(i)}
                onChange={(e) =>
                  onChange(e.target.checked ? [...chosen, i] : chosen.filter((c) => c !== i))
                }
              />
            )}
            <span>{option}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/**
 * Where a campaign email's survey links land. A one-click answer from the email is filled in
 * but only saved when the person sends the form, so mail scanners that open every link can't
 * answer for anyone.
 */
export function SurveyPage() {
  const params = useSearchParams();
  const token = params.get('t') ?? '';
  const [form, setForm] = useState<SurveyForm>();
  const [answers, setAnswers] = useState<SurveyAnswers>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!token) return setError('This link is incomplete. Open it again from the email.');
    if (token === 'test') return;
    void call<{ form?: SurveyForm }>(token).then((result) => {
      if (!result.form) return setError(result.error?.message ?? 'This survey link is not valid.');
      const first = result.form.survey.questions[0];
      const fromEmail = clicked(first, params.get('a'));
      setForm(result.form);
      setAnswers({
        ...(result.form.answers ?? {}),
        ...(first && fromEmail !== undefined ? { [first.id]: fromEmail } : {}),
      });
    });
  }, [token, params]);

  async function submit() {
    setBusy(true);
    setError('');
    const result = await call<{ submittedAt?: string }>(token, { answers });
    setBusy(false);
    if (result.submittedAt) {
      setForm((f) => f && { ...f, answers, submittedAt: result.submittedAt! });
      setDone(true);
    } else setError(result.error?.message ?? 'That did not work. Try again.');
  }

  const missing = form?.survey.questions.some((q) => {
    const v = answers[q.id];
    return q.required && (v === undefined || v === '' || (Array.isArray(v) && !v.length));
  });
  return (
    <main className="standalone-page">
      <div className="brand">
        <BrandLogo />
      </div>
      <section className="standalone-card survey-card">
        {token === 'test' ? (
          <>
            <h1>This was a test email</h1>
            <p className="muted">
              Survey links only work in the emails a campaign sends, where each one is tied to its
              recipient. Nothing was saved.
            </p>
          </>
        ) : !form && !error ? (
          <Loader2 className="spin" aria-label="Loading" />
        ) : !form ? (
          <>
            <h1>Survey</h1>
            <Alert tone="error">{error}</Alert>
          </>
        ) : done ? (
          <>
            <h1>Thanks for your answers</h1>
            <p className="muted">
              They help us decide what to build next.
              {form.open && <> You can change them until {longDate(form.closesAt)}.</>}
            </p>
            <div className="standalone-actions">
              {form.open && (
                <Button variant="outline" onClick={() => setDone(false)}>
                  Change my answers
                </Button>
              )}
              <a href="/">Open harbor0</a>
            </div>
          </>
        ) : (
          <form
            className="survey-form"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <h1>{form.title}</h1>
            <p className="muted">
              {form.open
                ? form.submittedAt
                  ? `You answered on ${longDate(form.submittedAt)}. Change anything and send again.`
                  : 'A few quick questions from the harbor0 team.'
                : 'This survey has closed.'}{' '}
              {form.open && 'We see your answers with your email address.'}
            </p>
            {form.survey.questions.map((q) => (
              <Question
                key={q.id}
                question={q}
                value={answers[q.id]}
                disabled={!form.open || busy}
                onChange={(value) => setAnswers((a) => ({ ...a, [q.id]: value as SurveyAnswer }))}
              />
            ))}
            {error && <Alert tone="error">{error}</Alert>}
            {form.open && (
              <div className="standalone-actions">
                <Button type="submit" disabled={busy || missing}>
                  {busy && <Loader2 className="spin" />}
                  {form.submittedAt ? 'Update answers' : 'Send answers'}
                </Button>
                {missing && <span className="muted">* Required</span>}
              </div>
            )}
          </form>
        )}
      </section>
    </main>
  );
}
