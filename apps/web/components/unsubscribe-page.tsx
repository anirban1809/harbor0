'use client';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import type { EmailSubscription } from '@harbor/contracts';
import { BrandLogo } from './brand-logo';
import { Alert } from './ui/alert';
import { Button } from './ui/button';

type Result = { subscription?: EmailSubscription; error?: { code: string; message: string } };

async function call(path: string, token: string, method = 'GET'): Promise<Result> {
  try {
    const response = await fetch(`/api/v1/email/${path}?t=${encodeURIComponent(token)}`, {
      method,
      cache: 'no-store',
    });
    return await response.json();
  } catch {
    return { error: { code: 'NETWORK', message: 'harbor0 could not be reached. Try again.' } };
  }
}

/**
 * Where an email's unsubscribe link lands. Unsubscribing takes a click rather than happening on
 * load, so mail scanners that open links can't unsubscribe anyone; mail apps' own unsubscribe
 * button uses the one-click endpoint instead.
 */
export function UnsubscribePage() {
  const token = useSearchParams().get('t') ?? '';
  const [subscription, setSubscription] = useState<EmailSubscription>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [changed, setChanged] = useState(false);

  useEffect(() => {
    if (!token) {
      setError('This link is incomplete. Open it again from the email.');
      return;
    }
    void call('unsubscribe', token).then((result) => {
      if (result.subscription) setSubscription(result.subscription);
      else
        setError(
          result.error?.code === 'USER_NOT_FOUND'
            ? 'The account this link was sent to no longer exists.'
            : (result.error?.message ?? 'This link is not valid.'),
        );
    });
  }, [token]);

  async function change(productUpdates: boolean) {
    setBusy(true);
    setError('');
    const result = await call(productUpdates ? 'resubscribe' : 'unsubscribe', token, 'POST');
    setBusy(false);
    if (result.subscription) {
      setSubscription(result.subscription);
      setChanged(true);
    } else setError(result.error?.message ?? 'That did not work. Try again.');
  }

  const on = subscription?.productUpdates;
  return (
    <main className="standalone-page">
      <div className="brand">
        <BrandLogo />
      </div>
      <section className="standalone-card">
        {!subscription && !error && <Loader2 className="spin" aria-label="Loading" />}
        {error && !subscription && (
          <>
            <h1>Email preferences</h1>
            <Alert tone="error">{error}</Alert>
            <p className="muted">
              You can also manage email in <a href="/settings">Settings</a> after signing in.
            </p>
          </>
        )}
        {subscription && (
          <>
            <h1>
              {on
                ? changed
                  ? 'Product updates are back on'
                  : 'Unsubscribe from product updates?'
                : 'You’re unsubscribed'}
            </h1>
            <p className="muted">
              {on ? (
                <>
                  <strong>{subscription.email}</strong> gets emails about new features and changes
                  to harbor0.
                </>
              ) : (
                <>
                  <strong>{subscription.email}</strong> won’t get product update emails anymore.
                </>
              )}{' '}
              Emails about your account’s security, storage and billing are always sent.
            </p>
            {error && <Alert tone="error">{error}</Alert>}
            <div className="standalone-actions">
              {on ? (
                <Button disabled={busy} onClick={() => void change(false)}>
                  {busy && <Loader2 className="spin" />}
                  Unsubscribe
                </Button>
              ) : (
                <Button variant="outline" disabled={busy} onClick={() => void change(true)}>
                  {busy && <Loader2 className="spin" />}
                  Resubscribe
                </Button>
              )}
              <a href="/settings">Manage email in Settings</a>
            </div>
          </>
        )}
      </section>
    </main>
  );
}
