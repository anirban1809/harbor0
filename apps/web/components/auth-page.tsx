'use client';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Check, HardDrive, Laptop, Loader2, Send, ShieldCheck } from 'lucide-react';
import { ApiError, type ApiClient } from '@harbor/api-client';
import { authRoutes, loginDestination, privacyUrl, termsUrl, type AuthMode } from '../lib/routes';
import { BrandLogo } from './brand-logo';
import { ThemeToggle } from './theme-toggle';
import { Alert } from './ui/alert';
import { Button } from './ui/button';
import { Field } from './ui/field';
import { Input, InputGroup, PasswordInput } from './ui/input';

const copy: Record<AuthMode, { title: string; lead: string; submit: string; busy: string }> = {
  login: {
    title: 'Welcome back',
    lead: 'Sign in to your files.',
    submit: 'Sign in',
    busy: 'Signing in…',
  },
  signup: {
    title: 'Create your account',
    lead: '50 GB of private storage, free.',
    submit: 'Create your account',
    busy: 'Creating account…',
  },
  confirm: {
    title: 'Check your email',
    lead: 'Enter the 6-digit code we sent you.',
    submit: 'Verify email',
    busy: 'Verifying…',
  },
  forgot: {
    title: 'Reset your password',
    lead: 'Enter your account email and we’ll send you a reset code.',
    submit: 'Send reset code',
    busy: 'Sending…',
  },
  reset: {
    title: 'Set a new password',
    lead: 'Enter the code from your email and choose a new password.',
    submit: 'Reset password',
    busy: 'Saving…',
  },
};

// Mirrors the Cognito pool policy in infra/app.ts.
const passwordRules = [
  { label: '12+ characters', test: (p: string) => p.length >= 12 },
  { label: 'Upper & lowercase', test: (p: string) => /[a-z]/.test(p) && /[A-Z]/.test(p) },
  { label: 'A number', test: (p: string) => /\d/.test(p) },
  { label: 'A symbol', test: (p: string) => /[^A-Za-z0-9]/.test(p) },
];

const features = [
  { icon: HardDrive, text: '50 GB of free storage for beta members' },
  { icon: Laptop, text: 'Sync folders across desktop and mobile' },
  { icon: Send, text: 'Send files to anyone by @username' },
];

const RESEND_COOLDOWN = 30;

const usernameFrom = (email: string) =>
  email
    .split('@')[0]
    .toLowerCase()
    .replace(/[^a-z0-9_.]/g, '')
    .slice(0, 32);

export function AuthPage({
  api,
  mode,
  onDone,
}: {
  api: ApiClient;
  mode: AuthMode;
  onDone: () => void;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = loginDestination(searchParams.get('next'));
  const authHref = (mode: AuthMode) => `${authRoutes[mode]}?next=${encodeURIComponent(next)}`;
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [username, setUsername] = useState('');
  const [usernameEdited, setUsernameEdited] = useState(false);
  const [error, setError] = useState<{ text: string; unverified?: boolean }>();
  // A notice belongs to the step it was written for, so it disappears when the user moves on.
  const [notice, setNotice] = useState<{ mode: AuthMode; text: string }>();
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    setError(undefined);
    setPassword('');
    // Focus the first empty field of each step.
    const fields = formRef.current?.querySelectorAll<HTMLInputElement>('input:not([type=hidden])');
    Array.from(fields ?? [])
      .find((f) => !f.value)
      ?.focus();
  }, [mode]);

  useEffect(() => {
    if (!cooldown) return;
    const timer = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  function go(target: AuthMode, text?: string) {
    setNotice(text ? { mode: target, text } : undefined);
    router.push(authHref(target));
  }

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    const values = Object.fromEntries(new FormData(e.currentTarget));
    try {
      if (mode === 'login') {
        await api.request('/v1/auth/login', {
          method: 'POST',
          body: { ...values, deviceName: 'Web browser', platform: 'WEB' },
        });
        onDone();
      } else {
        await api.request(`/v1/auth/${mode}`, { method: 'POST', body: values });
        if (mode === 'signup') {
          setCooldown(RESEND_COOLDOWN);
          go('confirm', `We sent a verification code to ${email}.`);
        } else if (mode === 'forgot') {
          setCooldown(RESEND_COOLDOWN);
          go('reset', `If ${email} has an account, a reset code is on its way.`);
        } else if (mode === 'confirm') go('login', 'Email verified. Sign in to continue.');
        else go('login', 'Password updated. Sign in with your new password.');
      }
    } catch (e) {
      setError({
        text: (e as Error).message,
        unverified: e instanceof ApiError && e.code === 'EMAIL_NOT_VERIFIED',
      });
    } finally {
      setBusy(false);
    }
  }

  async function resend() {
    setError(undefined);
    setNotice(undefined);
    if (!email) return setError({ text: 'Enter your email to get a new code.' });
    try {
      await api.request('/v1/auth/resend', { method: 'POST', body: { email } });
      setCooldown(RESEND_COOLDOWN);
      setNotice({ mode: 'confirm', text: `A new code is on its way to ${email}.` });
    } catch (e) {
      setError({ text: (e as Error).message });
    }
  }

  async function verifyInstead() {
    await resend();
    router.push(authHref('confirm'));
  }

  const { title, lead, submit: submitLabel, busy: busyLabel } = copy[mode];
  const newPassword = mode === 'signup' || mode === 'reset';
  const shownNotice = notice?.mode === mode ? notice.text : undefined;

  return (
    <main className="auth-page">
      <div className="auth-theme">
        <ThemeToggle />
      </div>
      <section className="auth-story">
        <div className="brand">
          <BrandLogo />
        </div>
        <div>
          <h1>Your files, everywhere.</h1>
          <p>Store, sync, and share files across every device you own.</p>
          <ul className="auth-features">
            {features.map(({ icon: Icon, text }) => (
              <li key={text}>
                <span className="auth-feature-icon">
                  <Icon aria-hidden="true" />
                </span>
                {text}
              </li>
            ))}
          </ul>
        </div>
        <div className="auth-foot">
          <ShieldCheck aria-hidden="true" />
          Files are private unless you share them.
        </div>
      </section>
      <section className="auth-form">
        <div>
          <h2>{title}</h2>
          <p className="muted">
            {mode === 'confirm' && email ? (
              <>
                Enter the 6-digit code we sent to <strong>{email}</strong>.
              </>
            ) : (
              lead
            )}
          </p>
          {shownNotice && <Alert tone="success">{shownNotice}</Alert>}
          <form ref={formRef} className="form" onSubmit={submit}>
            <Field label="Email">
              <Input
                size="lg"
                name="email"
                type="email"
                autoComplete="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  if (!usernameEdited) setUsername(usernameFrom(e.target.value));
                }}
                required
              />
            </Field>
            {mode === 'signup' && (
              <>
                <Field label="Display name">
                  <Input
                    size="lg"
                    name="displayName"
                    autoComplete="name"
                    placeholder="Your name"
                    required
                    maxLength={100}
                  />
                </Field>
                <Field label="Username" hint="People can send files directly to your @username.">
                  <InputGroup prefix="@">
                    <Input
                      size="lg"
                      name="username"
                      aria-label="Username"
                      autoComplete="username"
                      autoCapitalize="none"
                      spellCheck={false}
                      required
                      minLength={3}
                      maxLength={32}
                      pattern="[a-z0-9_.]{3,32}"
                      title="3–32 lowercase letters, numbers, dots, or underscores."
                      value={username}
                      onChange={(e) => {
                        setUsernameEdited(true);
                        setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_.]/g, ''));
                      }}
                    />
                  </InputGroup>
                </Field>
              </>
            )}
            {['confirm', 'reset'].includes(mode) && (
              <Field label="Verification code">
                <Input
                  size="lg"
                  className="auth-code"
                  name="code"
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  placeholder="000000"
                  maxLength={8}
                  required
                />
              </Field>
            )}
            {['login', 'signup', 'reset'].includes(mode) && (
              <Field
                label={
                  <span className="auth-label-row">
                    {mode === 'reset' ? 'New password' : 'Password'}
                    {mode === 'login' && (
                      <Link href={authHref('forgot')} className="auth-inline-link">
                        Forgot password?
                      </Link>
                    )}
                  </span>
                }
              >
                <PasswordInput
                  size="lg"
                  name="password"
                  aria-label="Password"
                  autoComplete={newPassword ? 'new-password' : 'current-password'}
                  required
                  minLength={newPassword ? 12 : 1}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                {newPassword && (
                  <ul className="password-rules" aria-label="Password requirements">
                    {passwordRules.map((rule) => {
                      const met = rule.test(password);
                      return (
                        <li key={rule.label} data-met={met}>
                          <Check aria-hidden="true" />
                          {rule.label}
                          <span className="sr-only">{met ? ' (met)' : ' (not met)'}</span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </Field>
            )}
            {error && (
              <Alert
                tone="error"
                action={
                  error.unverified && (
                    <Button variant="link" onClick={() => void verifyInstead()}>
                      Verify now
                    </Button>
                  )
                }
              >
                {error.text}
              </Alert>
            )}
            <Button disabled={busy} type="submit" size="lg" block>
              {busy && <Loader2 className="spin" aria-hidden="true" />}
              {busy ? busyLabel : submitLabel}
            </Button>
            {mode === 'signup' && (
              <p className="auth-terms">
                By creating an account, you agree to the{' '}
                <a href={termsUrl} target="_blank" rel="noreferrer">
                  Terms of Service
                </a>{' '}
                and acknowledge the{' '}
                <a href={privacyUrl} target="_blank" rel="noreferrer">
                  Privacy Policy
                </a>
                .
              </p>
            )}
          </form>
          {(mode === 'confirm' || mode === 'reset') && (
            <p className="auth-resend">
              Didn’t get it?{' '}
              {mode === 'confirm' ? (
                <Button
                  variant="link"
                  disabled={busy || cooldown > 0}
                  onClick={() => void resend()}
                >
                  {cooldown > 0 ? `Resend in ${cooldown}s` : 'Resend code'}
                </Button>
              ) : (
                <Link href={authHref('forgot')}>Send a new code</Link>
              )}
            </p>
          )}
          <div className="auth-switch">
            {mode === 'login' ? (
              <>
                New to harbor0? <Link href={authHref('signup')}>Create an account</Link>
              </>
            ) : mode === 'signup' ? (
              <>
                Already have an account? <Link href={authHref('login')}>Sign in</Link>
              </>
            ) : (
              <Link href={authHref('login')}>Back to sign in</Link>
            )}
          </div>
        </div>
      </section>
    </main>
  );
}
