'use client';
import { ArrowRight, X } from 'lucide-react';
import { useRef, useState, type FormEvent } from 'react';

// The custom-plan request is a form made in the staff console; its answers show up there.
const apiUrl = (process.env.NEXT_PUBLIC_API_URL ?? '').replace(/\/$/, '');
const formId = process.env.NEXT_PUBLIC_CUSTOM_PLAN_FORM ?? '';
const contactEmail = 'contact@harbor0.com';
const mailto = `mailto:${contactEmail}?subject=Custom%20plan`;

type Question = {
  id: string;
  kind: 'RATING' | 'CHOICE' | 'MULTI' | 'TEXT';
  prompt: string;
  options: string[];
  required: boolean;
};
type State =
  | { step: 'loading' }
  | { step: 'ready'; questions: Question[]; sending?: boolean; error?: string }
  | { step: 'sent' }
  | { step: 'failed'; message: string };

// Each browser sends its own random ID, so one visitor's retries don't use up everyone's limit.
const browserId = () => {
  try {
    const saved = localStorage.getItem('harbor0.browser');
    if (saved) return saved;
    const made = crypto.randomUUID().replaceAll('-', '');
    localStorage.setItem('harbor0.browser', made);
    return made;
  } catch {
    return undefined;
  }
};

async function call(path: string, init?: RequestInit) {
  let response: Response;
  try {
    response = await fetch(`${apiUrl}${path}`, {
      ...init,
      headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    });
  } catch {
    throw new Error('We couldn’t reach harbor0.');
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error?.message ?? 'Something went wrong.');
  return body;
}

/** "Contact us" for needs the plans don't cover: a short form in a modal. */
export function CustomPlanButton() {
  const dialog = useRef<HTMLDialogElement>(null);
  const [state, setState] = useState<State>({ step: 'loading' });

  // Without the API settings (or a form to answer) it stays a plain email link.
  if (!apiUrl || !formId)
    return (
      <a href={mailto} className="btn" data-variant="outline" data-size="lg">
        Contact us
        <ArrowRight />
      </a>
    );

  const open = async () => {
    dialog.current?.showModal();
    if (state.step === 'ready') return;
    setState({ step: 'loading' });
    try {
      const { view } = await call(`/v1/forms/${encodeURIComponent(formId)}`);
      if (view.blocked) throw new Error('This form isn’t taking requests right now.');
      setState({
        step: 'ready',
        questions: (view.form.questions as Question[]).filter(
          (q) => q.kind === 'TEXT' || q.kind === 'CHOICE',
        ),
      });
    } catch (error) {
      setState({ step: 'failed', message: (error as Error).message });
    }
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (state.step !== 'ready') return;
    const data = new FormData(event.currentTarget);
    const answers: Record<string, string | number> = {};
    for (const q of state.questions) {
      const value = String(data.get(q.id) ?? '').trim();
      if (!value) continue;
      answers[q.id] = q.kind === 'CHOICE' ? Number(value) : value;
    }
    setState({ ...state, sending: true, error: undefined });
    try {
      await call(`/v1/forms/${encodeURIComponent(formId)}/responses`, {
        method: 'POST',
        body: JSON.stringify({ answers, browser: browserId() }),
      });
      setState({ step: 'sent' });
    } catch (error) {
      setState({ ...state, sending: false, error: (error as Error).message });
    }
  };

  return (
    <>
      <button type="button" className="btn" data-variant="outline" data-size="lg" onClick={open}>
        Contact us
        <ArrowRight />
      </button>
      <dialog
        ref={dialog}
        className="custom-dialog"
        aria-labelledby="custom-title"
        // A click on the backdrop lands on the dialog itself, outside its content.
        onClick={(event) => event.target === dialog.current && dialog.current?.close()}
      >
        <div className="custom-dialog-body">
          <header>
            <h2 id="custom-title">Tell us what you need</h2>
            <button
              type="button"
              className="btn"
              data-variant="ghost"
              data-size="icon"
              aria-label="Close"
              onClick={() => dialog.current?.close()}
            >
              <X />
            </button>
          </header>

          {state.step === 'loading' && <p className="custom-note">Loading…</p>}

          {state.step === 'failed' && (
            <p className="custom-note">
              {state.message} Email us at <a href={mailto}>{contactEmail}</a> instead.
            </p>
          )}

          {state.step === 'sent' && (
            <>
              <p className="custom-note">
                <strong>Thanks — we’ve got it.</strong> We’ll reply by email, usually within a
                couple of days.
              </p>
              <button
                type="button"
                className="btn"
                data-variant="primary"
                data-size="lg"
                onClick={() => dialog.current?.close()}
              >
                Done
              </button>
            </>
          )}

          {state.step === 'ready' && (
            <form onSubmit={submit}>
              <p className="custom-note">
                More than 5 TB, a team, or something else these plans don’t cover — we’ll put a plan
                together and reply by email.
              </p>
              {state.questions.map((q) => {
                const id = `custom-${q.id}`;
                const email = /e-?mail/i.test(q.prompt);
                // Short answers get one line; requirements and details get room to write.
                const long = /requirement|detail|describe|message|anything/i.test(q.prompt);
                return (
                  <label key={q.id} htmlFor={id}>
                    <span>
                      {q.prompt}
                      {!q.required && <small> (optional)</small>}
                    </span>
                    {q.kind === 'CHOICE' ? (
                      <select id={id} name={q.id} className="input" required={q.required}>
                        <option value="">Choose…</option>
                        {q.options.map((option, index) => (
                          <option key={option} value={index}>
                            {option}
                          </option>
                        ))}
                      </select>
                    ) : email ? (
                      <input
                        id={id}
                        name={q.id}
                        type="email"
                        className="input"
                        autoComplete="email"
                        maxLength={254}
                        required={q.required}
                      />
                    ) : !long ? (
                      <input
                        id={id}
                        name={q.id}
                        className="input"
                        maxLength={2000}
                        required={q.required}
                      />
                    ) : (
                      <textarea
                        id={id}
                        name={q.id}
                        className="input"
                        rows={4}
                        maxLength={2000}
                        required={q.required}
                      />
                    )}
                  </label>
                );
              })}
              {state.error && (
                <p className="custom-error" role="alert">
                  {state.error}
                </p>
              )}
              <button
                type="submit"
                className="btn"
                data-variant="primary"
                data-size="lg"
                disabled={state.sending}
              >
                {state.sending ? 'Sending…' : 'Send request'}
              </button>
            </form>
          )}
        </div>
      </dialog>
    </>
  );
}
