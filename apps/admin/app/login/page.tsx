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

export default function LoginPage() {
    const router = useRouter();
    const queries = useQueryClient();
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [newPassword, setNewPassword] = useState('');
    const [confirm, setConfirm] = useState('');
    const [step, setStep] = useState<Challenge | null>(null);
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);

    const next = (result: StaffLoginResult) => {
        if (result.status === 'SIGNED_IN') {
            queries.setQueryData(['me'], { staff: result.staff });
            router.replace('/');
            return;
        }
        setStep(result);
    };
    const submit = async (event: FormEvent) => {
        event.preventDefault();
        setError('');
        if (step && newPassword !== confirm) {
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
                        newPassword,
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
        ? ['Choose a password', 'Replace your temporary password. Use at least 14 characters.']
        : ['Staff sign-in', 'The harbor0 management console. Access is limited to staff.'];

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
                {step && (
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
                <Button type="submit" block disabled={busy}>
                    {step ? (
                        <>
                            <ShieldCheck aria-hidden="true" />
                            Set password
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
