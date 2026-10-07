import { useState, type FormEvent } from 'react';
import { Loader2 } from 'lucide-react';
import type { TwoFactorChallenge, TwoFactorMethod } from '@harbor/contracts';
import { Alert } from '../../web/components/ui/alert';
import { Button } from '../../web/components/ui/button';
import { Field } from '../../web/components/ui/field';
import { Input } from '../../web/components/ui/input';

const bridge = window.harbor;

/**
 * The code step of signing in, for accounts with two-step verification. The password stays in
 * memory only while this step is shown, to start a fresh sign-in for a new code or method.
 */
export function TwoFactorSignIn({
  credentials,
  challenge: first,
  onSignedIn,
  onCancel,
}: {
  credentials: { email: string; password: string };
  challenge: TwoFactorChallenge;
  onSignedIn: () => Promise<unknown>;
  onCancel: (message?: string) => void;
}) {
  const [challenge, setChallenge] = useState(first);
  // Every method the account offered, kept after one is chosen so the user can switch back.
  const offered = first.methods;
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const { email } = credentials;

  async function run(work: () => Promise<void>) {
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
  }
  /** A failed step that can't be continued sends the user back to the password. */
  const failed = (failure: { code?: string; message: string }) => {
    if (failure.code === 'AUTH_EXPIRED') onCancel(failure.message);
    else setError(failure.message);
  };

  const verify = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const method = challenge.method ?? 'TOTP';
      const result = await bridge.loginVerify({ email, session: challenge.session, method, code });
      setCode('');
      if (result.failed) {
        // Choosing a method replaces the session; a wrong code hands the new one back.
        if (result.failed.session)
          setChallenge({
            ...challenge,
            session: result.failed.session,
            method,
            methods: challenge.method ? challenge.methods : [method],
          });
        return failed(result.failed);
      }
      await onSignedIn();
    });
  };

  /** Moves to `method`, sending a new email code when it is EMAIL. */
  const switchTo = (method: TwoFactorMethod, message?: string) =>
    run(async () => {
      let session = challenge.session;
      // Once a method is chosen the session is fixed to it, so start a fresh sign-in.
      if (challenge.method !== null) {
        const restarted = await bridge.login(credentials);
        if (!restarted.twoFactor) return void (await onSignedIn());
        if (restarted.twoFactor.method !== null) {
          setChallenge(restarted.twoFactor);
          if (message) setNotice(message);
          return;
        }
        session = restarted.twoFactor.session;
      }
      const result = await bridge.loginMethod({ email, session, method });
      if (result.failed) return failed(result.failed);
      setCode('');
      setChallenge(result.twoFactor!);
      if (message) setNotice(message);
    });

  const byEmail = challenge.method === 'EMAIL';
  return (
    <>
      <h2>Two-step verification</h2>
      <p className="muted auth-intro">
        {byEmail ? (
          <>
            Enter the code we sent to <strong>{challenge.destination ?? email}</strong>.
          </>
        ) : (
          'Enter the 6-digit code from your authenticator app.'
        )}
      </p>
      {notice && <Alert tone="success">{notice}</Alert>}
      {error && <Alert tone="error">{error}</Alert>}
      <form className="form" onSubmit={verify}>
        <Field label={byEmail ? 'Email code' : 'Authenticator code'}>
          <Input
            size="lg"
            className="auth-code"
            name="code"
            autoComplete="one-time-code"
            inputMode="numeric"
            placeholder="000000"
            pattern="\d{6,8}"
            maxLength={8}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            disabled={busy}
            autoFocus
            required
          />
        </Field>
        <Button type="submit" size="lg" block disabled={busy || code.length < 6}>
          {busy && <Loader2 className="spin" aria-hidden="true" />}
          {busy ? 'Verifying…' : 'Verify'}
        </Button>
      </form>
      <p className="auth-resend">
        {byEmail ? (
          <>
            Didn’t get it?{' '}
            <Button
              variant="link"
              disabled={busy}
              onClick={() => void switchTo('EMAIL', 'A new code is on its way.')}
            >
              Send a new code
            </Button>
            {offered.includes('TOTP') && (
              <>
                {' · '}
                <Button variant="link" disabled={busy} onClick={() => void switchTo('TOTP')}>
                  Use my authenticator app
                </Button>
              </>
            )}
          </>
        ) : (
          offered.includes('EMAIL') && (
            <Button variant="link" disabled={busy} onClick={() => void switchTo('EMAIL')}>
              Email me a code instead
            </Button>
          )
        )}
      </p>
      <div className="auth-switch">
        <Button variant="link" disabled={busy} onClick={() => onCancel()}>
          Back to sign in
        </Button>
      </div>
    </>
  );
}
