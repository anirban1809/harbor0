'use client';
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import type {
  FormAnswer,
  FormAnswers,
  FormQuestion,
  FormView,
} from '../../../packages/contracts/src/forms';
import { BrandLogo } from './brand-logo';
import { Alert } from './ui/alert';
import { Button } from './ui/button';
import { Checkbox, Radio } from './ui/checkbox';
import { Textarea } from './ui/input';

type ApiError = { code: string; message: string };
type Result<T> = T & { error?: ApiError };

async function call<T>(path: string, body?: unknown): Promise<Result<T>> {
  try {
    const response = await fetch(`/api/v1${path}`, {
      method: body ? 'POST' : 'GET',
      cache: 'no-store',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return await response.json();
  } catch {
    return { error: { code: 'NETWORK', message: 'harbor0 could not be reached. Try again.' } } as Result<T>;
  }
}

/**
 * A random ID this browser keeps for itself, so a one-per-person form can recognise it when it
 * comes back. It names no one, and clearing site data starts afresh.
 */
function browserId() {
  const key = 'harbor0-form-browser';
  try {
    const known = localStorage.getItem(key);
    if (known && /^[A-Za-z0-9_-]{16,64}$/.test(known)) return known;
    const made = Array.from(crypto.getRandomValues(new Uint8Array(18)), (b) =>
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'.charAt(b & 63),
    ).join('');
    localStorage.setItem(key, made);
    return made;
  } catch {
    return undefined;
  }
}

const longDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { dateStyle: 'long' });

function Question({
  question,
  value,
  disabled,
  onChange,
}: {
  question: FormQuestion;
  value: FormAnswer | undefined;
  disabled: boolean;
  onChange: (value: FormAnswer | undefined) => void;
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

/** Who the answers are recorded as, in a sentence. */
function respondentNote(view: FormView) {
  const who = view.respondent;
  if (who?.via === 'EMAIL' || who?.via === 'ACCOUNT')
    return `Your answers are recorded with ${who.label ?? 'your account'}.`;
  return view.form.limit === 'ONE_PER_PERSON'
    ? 'One response per person. Answering again from this browser replaces your answers.'
    : '';
}

/**
 * A form from the console, opened from a shared link or a campaign email. A personal link
 * (`r`) or a signed-in session says who is answering; otherwise this browser's own ID does.
 */
export function FormPage() {
  const params = useSearchParams();
  const id = params.get('id') ?? '';
  const r = params.get('r') ?? undefined;
  const [browser] = useState(() => (typeof window === 'undefined' ? undefined : browserId()));
  const [view, setView] = useState<FormView>();
  const [answers, setAnswers] = useState<FormAnswers>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const load = useCallback(async () => {
    const query = new URLSearchParams({ ...(r ? { r } : {}), ...(browser ? { b: browser } : {}) });
    return call<{ view?: FormView }>(`/forms/${encodeURIComponent(id)}?${query}`);
  }, [id, r, browser]);

  useEffect(() => {
    if (!/^[\w-]{1,128}$/.test(id)) return setError('This link is incomplete. Open it again from where you found it.');
    void (async () => {
      let result = await load();
      // A signed-in visitor whose access cookie lapsed is renewed once, so they answer as themselves.
      const known = result.view?.respondent?.via === 'EMAIL' || result.view?.respondent?.via === 'ACCOUNT';
      if (result.view && !known && !r) {
        const renewed = await fetch('/api/v1/auth/renew', { method: 'POST', cache: 'no-store' }).catch(() => null);
        if (renewed?.ok) result = await load();
      }
      if (!result.view) return setError(result.error?.message ?? 'This form could not be opened.');
      setView(result.view);
      setAnswers(result.view.response?.answers ?? {});
    })();
  }, [id, r, load]);

  async function submit() {
    setBusy(true);
    setError('');
    const result = await call<{ submittedAt?: string }>(`/forms/${encodeURIComponent(id)}/responses`, {
      answers,
      ...(r ? { r } : {}),
      ...(browser ? { browser } : {}),
    });
    setBusy(false);
    if (result.submittedAt) {
      setView((v) => v && { ...v, response: { answers, submittedAt: result.submittedAt! } });
      setDone(true);
    } else setError(result.error?.message ?? 'That did not work. Try again.');
  }

  const form = view?.form;
  const missing = form?.questions.some((q) => {
    const v = answers[q.id];
    return q.required && (v === undefined || v === '' || (Array.isArray(v) && !v.length));
  });
  const oneEach = form?.limit === 'ONE_PER_PERSON';
  const signIn = `/login?next=${encodeURIComponent(`/form?id=${id}`)}`;
  return (
    <main className="standalone-page">
      <div className="brand">
        <BrandLogo />
      </div>
      <section className="standalone-card survey-card">
        {!view && !error ? (
          <Loader2 className="spin" aria-label="Loading" />
        ) : !view || !form ? (
          <>
            <h1>Form</h1>
            <Alert tone="error">{error}</Alert>
          </>
        ) : done ? (
          <>
            <h1>Thanks for your answers</h1>
            <p className="muted">
              {oneEach && form.accepting
                ? 'You can change them while the form is open.'
                : 'They’ve been recorded.'}
            </p>
            <div className="standalone-actions">
              {oneEach && (
                <Button variant="outline" onClick={() => setDone(false)}>
                  Change my answers
                </Button>
              )}
              {!oneEach && (
                <Button
                  variant="outline"
                  onClick={() => {
                    setAnswers({});
                    setDone(false);
                  }}
                >
                  Send another response
                </Button>
              )}
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
            {form.description && <p className="muted survey-description">{form.description}</p>}
            {view.blocked === 'CLOSED' ? (
              <Alert tone="info">This form isn’t taking answers now.</Alert>
            ) : view.blocked === 'TEST' ? (
              <Alert tone="info">
                This link came from a test email. You can look through the questions, but answers
                aren’t saved.
              </Alert>
            ) : view.blocked === 'SIGN_IN' ? (
              <Alert tone="info">
                Only harbor0 members can answer this form. <a href={signIn}>Sign in</a>, or open
                your link from the email we sent you.
              </Alert>
            ) : (
              <p className="muted">
                {view.response
                  ? `You answered on ${longDate(view.response.submittedAt)}. Change anything and send again.`
                  : respondentNote(view)}
              </p>
            )}
            {form.questions.map((q) => (
              <Question
                key={q.id}
                question={q}
                value={answers[q.id]}
                disabled={!!view.blocked || busy}
                onChange={(value) => setAnswers((a) => ({ ...a, [q.id]: value as FormAnswer }))}
              />
            ))}
            {error && <Alert tone="error">{error}</Alert>}
            {!view.blocked && (
              <div className="standalone-actions">
                <Button type="submit" disabled={busy || missing}>
                  {busy && <Loader2 className="spin" />}
                  {view.response && oneEach ? 'Update answers' : 'Send answers'}
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
