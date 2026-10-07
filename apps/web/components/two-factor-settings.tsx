'use client';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Loader2, Mail, ShieldCheck, Smartphone } from 'lucide-react';
import QRCode from 'qrcode';
import type { ApiClient } from '@harbor/api-client';
import type { TotpSetup, TwoFactorMethod, TwoFactorStatus } from '@harbor/contracts';
import { useFeatureFlag } from '../lib/feature-flags';
import { Alert } from './ui/alert';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { Dialog, DialogActions } from './ui/dialog';
import { Field } from './ui/field';
import { Input } from './ui/input';

const path = '/v1/users/me/two-factor';
const names: Record<TwoFactorMethod, string> = {
  TOTP: 'authenticator app',
  EMAIL: 'email codes',
};

/**
 * Settings card for the sign-in second step. An account uses one method at a time: an
 * authenticator app or email codes. Turning one on replaces the other.
 */
export function TwoFactorSettings({ api, email }: { api: ApiClient; email: string }) {
  const enabled = useFeatureFlag('two-factor');
  const queries = useQueryClient();
  const status = useQuery<TwoFactorStatus>({
    queryKey: ['two-factor'],
    queryFn: async () => (await api.request(path)).twoFactor,
  });
  const [setup, setSetup] = useState<TotpSetup>();
  const [confirming, setConfirming] = useState<{ method: TwoFactorMethod; turnOn: boolean }>();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const on = status.data ?? { totp: false, email: false };
  const active: TwoFactorMethod | undefined = on.totp ? 'TOTP' : on.email ? 'EMAIL' : undefined;
  // Turning a method on is still being rolled out; anyone who already has one keeps the card,
  // so they can see and turn it off.
  if (!enabled && !active) return null;

  async function run(key: string, work: () => Promise<unknown>, done?: string) {
    setBusy(key);
    setError('');
    setNotice('');
    try {
      await work();
      if (done) setNotice(done);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  }
  const save = (next: TwoFactorStatus) => queries.setQueryData(['two-factor'], next);
  const startTotp = () =>
    void run('totp', async () =>
      setSetup(await api.request(`${path}/totp/setup`, { method: 'POST' })),
    );
  const turnOnEmail = () =>
    run(
      'email',
      async () => {
        save((await api.request(`${path}/email`, { method: 'POST' })).twoFactor);
        setConfirming(undefined);
      },
      active === 'TOTP'
        ? 'You now sign in with email codes. Your authenticator app no longer works for harbor0.'
        : 'Email codes are on. You’ll get one the next time you sign in.',
    );
  const turnOff = (method: TwoFactorMethod) =>
    run(
      'off',
      async () => {
        save(
          (await api.request(`${path}/disable`, { method: 'POST', body: { method } })).twoFactor,
        );
        setConfirming(undefined);
      },
      'Two-step verification is off.',
    );

  const methods: {
    method: TwoFactorMethod;
    icon: typeof Mail;
    title: string;
    text: ReactNode;
  }[] = [
    {
      method: 'TOTP',
      icon: Smartphone,
      title: 'Authenticator app',
      text: 'A 6-digit code from 1Password, Google Authenticator, Authy or a similar app.',
    },
    {
      method: 'EMAIL',
      icon: Mail,
      title: 'Email codes',
      text: (
        <>
          We email a code to <strong>{email}</strong> each time you sign in.
        </>
      ),
    },
  ];
  const isOn = (method: TwoFactorMethod) => (method === 'TOTP' ? on.totp : on.email);
  const dialog = confirming && {
    title: confirming.turnOn
      ? `Switch to ${names[confirming.method]}?`
      : `Turn off two-step verification?`,
    description: confirming.turnOn
      ? `Your ${names[confirming.method === 'TOTP' ? 'EMAIL' : 'TOTP']} will stop working for harbor0. You can only use one method at a time.`
      : 'Signing in will only need your password again.',
  };

  return (
    <Card
      className="panel"
      title="Two-step verification"
      description="Ask for a code as well as your password when you sign in, so a leaked password isn’t enough to get into your files. Choose one method."
      action={
        active && (
          <Badge tone="success">
            <ShieldCheck aria-hidden="true" />
            On
          </Badge>
        )
      }
    >
      {error && <Alert tone="error">{error}</Alert>}
      {notice && <Alert tone="success">{notice}</Alert>}
      {status.isPending ? (
        <Loader2 className="spin" aria-label="Loading" />
      ) : status.isError ? (
        <Alert tone="error">{(status.error as Error).message}</Alert>
      ) : (
        <ul className="two-factor-methods">
          {methods.map(({ method, icon: Icon, title, text }) => (
            <li key={method} data-active={isOn(method) || undefined}>
              <span className="two-factor-icon">
                <Icon aria-hidden="true" />
              </span>
              <div>
                <strong>
                  {title}
                  {isOn(method) && <Badge tone="success">In use</Badge>}
                </strong>
                <p className="muted">{text}</p>
              </div>
              {isOn(method) ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!!busy}
                  onClick={() => setConfirming({ method, turnOn: false })}
                >
                  Turn off
                </Button>
              ) : (
                enabled && (
                  <Button
                    size="sm"
                    variant={active ? 'outline' : undefined}
                    disabled={!!busy}
                    onClick={() =>
                      method === 'TOTP'
                        ? startTotp()
                        : active
                          ? setConfirming({ method, turnOn: true })
                          : void turnOnEmail()
                    }
                  >
                    {busy === (method === 'TOTP' ? 'totp' : 'email') && (
                      <Loader2 className="spin" aria-hidden="true" />
                    )}
                    {active ? 'Switch to this' : method === 'TOTP' ? 'Set up' : 'Turn on'}
                  </Button>
                )
              )}
            </li>
          ))}
        </ul>
      )}
      {setup && (
        <TotpSetupDialog
          api={api}
          setup={setup}
          replacing={on.email}
          onClose={() => setSetup(undefined)}
          onDone={(next) => {
            save(next);
            setSetup(undefined);
            setNotice(
              'Your authenticator app is set up. You’ll need a code from it when you sign in.',
            );
          }}
        />
      )}
      <Dialog
        open={!!confirming}
        onOpenChange={(open) => {
          if (!open && !busy) setConfirming(undefined);
        }}
        title={dialog?.title}
        description={dialog?.description}
      >
        <DialogActions>
          <Button
            type="button"
            variant="outline"
            disabled={!!busy}
            onClick={() => setConfirming(undefined)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant={confirming?.turnOn ? undefined : 'danger'}
            disabled={!!busy}
            onClick={() =>
              confirming && void (confirming.turnOn ? turnOnEmail() : turnOff(confirming.method))
            }
          >
            {busy
              ? 'Saving…'
              : confirming?.turnOn
                ? `Switch to ${confirming && names[confirming.method]}`
                : 'Turn off'}
          </Button>
        </DialogActions>
      </Dialog>
    </Card>
  );
}

function TotpSetupDialog({
  api,
  setup,
  replacing,
  onClose,
  onDone,
}: {
  api: ApiClient;
  setup: TotpSetup;
  /** Email codes are on now; the app replaces them once its first code is accepted. */
  replacing: boolean;
  onClose: () => void;
  onDone: (status: TwoFactorStatus) => void;
}) {
  const [qr, setQr] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    QRCode.toString(setup.uri, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }).then(
      (svg) => live && setQr(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`),
      () => live && setQr(''),
    );
    return () => {
      live = false;
    };
  }, [setup.uri]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      onDone(
        (await api.request(`${path}/totp/verify`, { method: 'POST', body: { code } })).twoFactor,
      );
    } catch (e) {
      setCode('');
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      title="Set up an authenticator app"
      description={`Scan the QR code with your authenticator app, then enter the 6-digit code it shows.${replacing ? ' Email codes stay on until the app is set up, then stop.' : ''}`}
    >
      <form className="form" onSubmit={submit}>
        <div className="totp-setup">
          {qr ? (
            <img className="totp-qr" src={qr} alt="QR code for your authenticator app" />
          ) : (
            <div className="totp-qr" />
          )}
          <div className="totp-key">
            <span className="field-label">
              <KeyRound aria-hidden="true" />
              Can’t scan it? Enter this key
            </span>
            <code>{setup.secret.match(/.{1,4}/g)?.join(' ')}</code>
          </div>
        </div>
        {error && <Alert tone="error">{error}</Alert>}
        <Field label="6-digit code">
          <Input
            className="auth-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="\d{6}"
            maxLength={6}
            placeholder="000000"
            required
            autoFocus
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          />
        </Field>
        <DialogActions>
          <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy || code.length !== 6}>
            {busy && <Loader2 className="spin" aria-hidden="true" />}
            {busy ? 'Checking…' : 'Turn on'}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}
