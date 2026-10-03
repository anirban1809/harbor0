'use client';
import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';
import { BrandLogo } from '../../../web/components/brand-logo';
import { Alert } from '../../../web/components/ui/alert';
import { Button } from '../../../web/components/ui/button';
import { Field } from '../../../web/components/ui/field';
import { Input, PasswordInput } from '../../../web/components/ui/input';
import type { StaffLoginResult } from '../../../../packages/contracts/src/admin';
import { api } from '../../lib/api';

type Challenge = Extract<StaffLoginResult, { status: 'CHALLENGE'; }>;
const titles: Record<Challenge['challenge'], [string, string]> = {
    NEW_PASSWORD: [
        'Choose a password',
        'Replace your temporary password. Use at least 14 characters.',
    ],
    MFA_SETUP: [
        'Add an authenticator',
        'The console requires a code from an authenticator app (1Password, Google Authenticator, Authy…).',
    ],
    MFA: ['Enter your code', 'Open your authenticator app and enter the 6-digit code for harbor0.'],
};

export default function LoginPage() {
    const router = useRouter();
    const queries = useQueryClient();
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [newPassword, setNewPassword] = useState('');
    const [confirm, setConfirm] = useState('');
    const [code, setCode] = useState('');
    const [step, setStep] = useState<Challenge | null>(null);
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);

    const next = (result: StaffLoginResult) => {
        if (result.status === 'SIGNED_IN') {
            queries.setQueryData(['me'], { staff: result.staff });
            router.replace('/');
            return;
        }
        setCode('');
        setStep(result);
    };
    const submit = async (event: FormEvent) => {
        event.preventDefault();
        setError('');
        if (step?.challenge === 'NEW_PASSWORD' && newPassword !== confirm) {
            setError('The passwords do not match.');
            return;
        }
        setBusy(true);
        try {
            next(
                step
                    ? await api.challenge({
                        email,
                        session: step.session,
                        challenge: step.challenge,
                        ...(step.challenge === 'NEW_PASSWORD' ? { newPassword } : { code }),
                    })
                    : await api.login(email, password),
            );
        } catch (e) {
            setError((e as Error).message);
            // An expired sign-in session cannot be continued; start again from the password.
            if ((e as { code?: string; }).code === 'AUTH_EXPIRED') setStep(null);
        } finally {
            setBusy(false);
        }
    };
    const [title, description] = step
        ? titles[step.challenge]
        : ['Staff sign-in', 'The harbor0 management console. Access is limited to staff.'];
    const otpauth = step?.secret
        ? `otpauth://totp/harbor0%20console:${encodeURIComponent(email)}?secret=${step.secret}&issuer=harbor0%20console`
        : '';

    return (
        <div className="admin-login">
            <form className="card admin-login-card" onSubmit={submit}>
                <div className="admin-brand">
                    <BrandLogo />
                    <span className="badge" data-tone="warning">
                        Console
                    </span>
                </div>
                <div className="admin-login-heading">
                    <h1>{title}</h1>
                    <p>{description}</p>
                </div>
                {error && <Alert tone="error">{error}</Alert>}
                {!step && (
                    <>
                        <Field label="Work email">
                            <Input
                                type="email"
                                autoComplete="username"
                                required
                                autoFocus
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                            />
                        </Field>
                        <Field label="Password">
                            <PasswordInput
                                autoComplete="current-password"
                                required
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                            />
                        </Field>
                    </>
                )}
                {step?.challenge === 'NEW_PASSWORD' && (
                    <>
                        <Field label="New password">
                            <PasswordInput
                                autoComplete="new-password"
                                required
                                minLength={14}
                                autoFocus
                                value={newPassword}
                                onChange={(e) => setNewPassword(e.target.value)}
                            />
                        </Field>
                        <Field label="Confirm new password">
                            <PasswordInput
                                autoComplete="new-password"
                                required
                                minLength={14}
                                value={confirm}
                                onChange={(e) => setConfirm(e.target.value)}
                            />
                        </Field>
                    </>
                )}
                {step?.challenge === 'MFA_SETUP' && (
                    <div className="admin-secret">
                        <span className="field-label">Setup key</span>
                        <code>{step.secret?.match(/.{1,4}/g)?.join(' ')}</code>
                        <span className="field-hint">
                            Enter this key in your authenticator app, or open{' '}
                            <a href={otpauth}>this setup link</a> on a device that has one.
                        </span>
                    </div>
                )}
                {(step?.challenge === 'MFA_SETUP' || step?.challenge === 'MFA') && (
                    <Field label="6-digit code">
                        <Input
                            inputMode="numeric"
                            autoComplete="one-time-code"
                            pattern="\d{6}"
                            maxLength={6}
                            required
                            autoFocus
                            value={code}
                            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                        />
                    </Field>
                )}
                <Button type="submit" block disabled={busy}>
                    {step ? (
                        <>
                            <ShieldCheck aria-hidden="true" />
                            {step.challenge === 'NEW_PASSWORD' ? 'Set password' : 'Verify'}
                        </>
                    ) : (
                        'Continue'
                    )}
                </Button>
                {step && (
                    <Button
                        type="button"
                        variant="ghost"
                        block
                        onClick={() => {
                            setStep(null);
                            setError('');
                        }}
                    >
                        Start over
                    </Button>
                )}
            </form>
        </div>
    );
}
