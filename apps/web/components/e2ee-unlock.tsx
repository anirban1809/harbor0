'use client';
import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { KeyRound, Loader2, Lock } from 'lucide-react';
import type { ApiClient } from '@harbor/api-client';
import { parseRecoveryKey } from '../../../packages/api-client/src/e2ee';
import { unlockWithPassphrase, unlockWithRecovery } from '../lib/e2ee-vault';
import { passphraseStrength } from '../lib/e2ee-passphrase';
import { AuthStory } from './auth-page';
import { e2eeQuery } from './e2ee-settings';
import { ThemeToggle } from './theme-toggle';
import { Alert } from './ui/alert';
import { Button } from './ui/button';
import { Checkbox } from './ui/checkbox';
import { Field } from './ui/field';
import { Input, PasswordInput } from './ui/input';

/**
 * Shown instead of the drive on an encrypted account until this browser has the key: the
 * passphrase, or the recovery key and a new passphrase if it was forgotten.
 */
export function E2eeUnlock({
  api,
  email,
  onSignOut,
}: {
  api: ApiClient;
  email: string;
  onSignOut: () => void;
}) {
  const state = useQuery(e2eeQuery(api));
  const [mode, setMode] = useState<'passphrase' | 'recovery'>('passphrase');
  const [passphrase, setPassphrase] = useState('');
  const [remember, setRemember] = useState(false);
  const [recovery, setRecovery] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const recoveryBytes = parseRecoveryKey(recovery);
  const switchTo = (next: typeof mode) => {
    setMode(next);
    setError('');
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!state.data) return;
    setError('');
    if (mode === 'recovery') {
      if (!recoveryBytes) return setError('Enter all 8 groups of your recovery key.');
      if (!passphraseStrength(next).ok) return setError('Use at least 12 characters.');
      if (next !== confirm) return setError('The passphrases don’t match.');
    }
    setBusy(true);
    try {
      if (mode === 'passphrase')
        await unlockWithPassphrase(api.request, state.data, passphrase, remember);
      else await unlockWithRecovery(api.request, state.data, recoveryBytes!, next, remember);
    } catch (err) {
      setError(
        (err as { code?: string }).code === 'WRONG_KEY'
          ? mode === 'passphrase'
            ? 'That passphrase isn’t right. Check it and try again.'
            : 'That recovery key isn’t right. Check it and try again.'
          : (err as Error).message,
      );
      setBusy(false);
    }
  }
  const rememberField = (
    <Field
      label="Remember this browser"
      hint="Stay unlocked until you sign out. Leave this off on shared computers."
      inline
    >
      <Checkbox checked={remember} onChange={(e) => setRemember(e.target.checked)} />
    </Field>
  );
  return (
    <main className="auth-page">
      <div className="auth-theme">
        <ThemeToggle />
      </div>
      <AuthStory />
      <section className="auth-form">
        <div>
          <span className="e2ee-tile" aria-hidden="true">
            {mode === 'passphrase' ? <Lock /> : <KeyRound />}
          </span>
          <h2>{mode === 'passphrase' ? 'Unlock your files' : 'Use your recovery key'}</h2>
          <p className="muted">
            {mode === 'passphrase' ? (
              <>
                Signed in as <strong>{email}</strong>. Enter your encryption passphrase to read your
                files in this browser.
              </>
            ) : (
              'Enter the recovery key you saved when you turned on encryption, then choose a new passphrase.'
            )}
          </p>
          {state.isError && <Alert tone="error">{(state.error as Error).message}</Alert>}
          <form className="form" onSubmit={submit}>
            {mode === 'passphrase' ? (
              <>
                <div className="field">
                  <div className="e2ee-label-row">
                    <label className="field-label" htmlFor="e2ee-unlock">
                      Encryption passphrase
                    </label>
                    <Button variant="link" type="button" onClick={() => switchTo('recovery')}>
                      Forgot it?
                    </Button>
                  </div>
                  <PasswordInput
                    id="e2ee-unlock"
                    size="lg"
                    autoComplete="current-password"
                    value={passphrase}
                    onChange={(e) => setPassphrase(e.target.value)}
                    autoFocus
                    required
                  />
                </div>
                {rememberField}
              </>
            ) : (
              <>
                <Field label="Recovery key">
                  <Input
                    size="lg"
                    className="e2ee-code"
                    placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
                    autoComplete="off"
                    spellCheck={false}
                    value={recovery}
                    onChange={(e) => setRecovery(e.target.value)}
                    autoFocus
                    required
                  />
                </Field>
                <Field label="New passphrase">
                  <PasswordInput
                    aria-label="New passphrase"
                    autoComplete="new-password"
                    value={next}
                    onChange={(e) => setNext(e.target.value)}
                    required
                  />
                </Field>
                <Field label="Confirm new passphrase">
                  <PasswordInput
                    aria-label="Confirm new passphrase"
                    autoComplete="new-password"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    required
                  />
                </Field>
                {rememberField}
                <Alert>
                  Your files stay as they are. Devices that are already unlocked stay unlocked, and
                  your recovery key keeps working.
                </Alert>
              </>
            )}
            {error && <Alert tone="error">{error}</Alert>}
            <Button type="submit" size="lg" block disabled={busy || !state.data}>
              {busy && <Loader2 className="spin" aria-hidden="true" />}
              {busy
                ? 'Unlocking…'
                : mode === 'passphrase'
                  ? 'Unlock'
                  : 'Unlock and save passphrase'}
            </Button>
          </form>
          {mode === 'passphrase' && (
            <p className="muted e2ee-note">
              Your passphrase is checked in this browser and never sent to harbor0.
            </p>
          )}
          <div className="auth-switch e2ee-switch">
            {mode === 'passphrase' ? (
              <Button variant="link" onClick={() => switchTo('recovery')}>
                Use recovery key instead
              </Button>
            ) : (
              <span>
                Remembered it?{' '}
                <Button variant="link" onClick={() => switchTo('passphrase')}>
                  Use your passphrase
                </Button>
              </span>
            )}
            <Button variant="link" onClick={onSignOut}>
              Sign out
            </Button>
          </div>
        </div>
      </section>
    </main>
  );
}
