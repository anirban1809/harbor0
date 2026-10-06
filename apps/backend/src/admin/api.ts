import { Hono, type Context } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import * as c from '@harbor/contracts';
import {
    adminBetaSchema,
    adminDeleteBody,
    adminNoteBody,
    adminOverviewSchema,
    adminPurgeResultSchema,
    adminQuotaBody,
    adminReasonBody,
    adminUserDetailSchema,
    adminUserPageSchema,
    adminWaveBody,
    auditEntrySchema,
    auditPageSchema,
    can,
    staffLoginResultSchema,
    staffSchema,
    type Staff,
    type StaffPermission,
} from '../../../../packages/contracts/src/admin';
import { DomainError, assert } from '../errors';
import type { StorageService } from '../domain';
import type { UserDirectory } from './directory';
import { AdminService } from './service';
import { Beta } from '../beta';
import type { StaffAuth, StaffAuthStep, StaffTokens } from './staff-auth';

type Env = { Variables: { staff: Staff; requestId: string; }; };
const ACCESS = 'harbor_staff_access';
const REFRESH = 'harbor_staff_refresh';
// Staff sessions end after a working day; the staff pool's refresh tokens last no longer.
const STAFF_SESSION_SECONDS = 12 * 3600;
const email = z
    .email()
    .max(254)
    .transform((v) => v.toLowerCase());
const loginBody = z.object({ email, password: z.string().min(1).max(256) }).strict();
const challengeBody = z
    .object({
        email,
        session: z.string().min(1).max(4096),
        challenge: z.enum(['NEW_PASSWORD', 'MFA_SETUP', 'MFA']),
        newPassword: z.string().min(14).max(256).optional(),
        code: z
            .string()
            .regex(/^\d{6}$/)
            .optional(),
    })
    .strict();
const searchQuery = z.object({
    q: z.string().max(254).default(''),
    cursor: z.string().max(4096).optional(),
});

export type AdminAppOptions = {
    /** The console's own origins; state-changing requests from anywhere else are refused. */
    origins: string[];
    secureCookies: boolean;
    /** Whether customer sign-up is invite-only (the beta). */
    inviteRequired?: boolean;
};

/**
 * The management console API, separate from the customer API: its own Lambda, its own staff
 * sign-in, HTTP-only cookies scoped to `/api`, and no access to file bytes.
 */
export function createAdminApp(
    service: StorageService,
    directory: UserDirectory,
    auth: StaffAuth,
    options: AdminAppOptions,
) {
    const admin = new AdminService(service, directory);
    const beta = new Beta(service.repo, options.inviteRequired ?? false);
    const app = new Hono<Env>();
    const cookie = (ctx: Context<Env>, name: string, value: string, maxAge: number) =>
        setCookie(ctx, name, value, {
            path: '/api',
            httpOnly: true,
            sameSite: 'Strict',
            secure: options.secureCookies,
            maxAge,
        });
    const signIn = (ctx: Context<Env>, tokens: StaffTokens) => {
        cookie(ctx, ACCESS, tokens.accessToken, Math.max(1, tokens.expiresIn - 30));
        cookie(ctx, REFRESH, tokens.refreshToken, STAFF_SESSION_SECONDS);
    };
    const signOut = (ctx: Context<Env>) => {
        deleteCookie(ctx, ACCESS, { path: '/api', secure: options.secureCookies });
        deleteCookie(ctx, REFRESH, { path: '/api', secure: options.secureCookies });
    };
    async function rateLimit(key: string, max: number) {
        const bucket = Math.floor(Date.now() / 60000);
        const k = createHash('sha256').update(`admin:${key}`).digest('hex');
        assert(
            await service.repo.increment({ pk: 'RATE', sk: `${k}#${bucket}` }, max, (bucket + 2) * 60),
            'RATE_LIMITED',
            'Too many attempts. Wait a minute.',
            429,
        );
    }

    app.use('*', async (ctx, next) => {
        const requestId = crypto.randomUUID();
        ctx.set('requestId', requestId);
        ctx.header('X-Request-ID', requestId);
        ctx.header('Cache-Control', 'no-store');
        ctx.header('X-Robots-Tag', 'noindex, nofollow');
        const started = performance.now();
        await next();
        console.log(
            JSON.stringify({
                event: 'admin_request',
                requestId,
                method: ctx.req.method,
                path: ctx.req.routePath,
                status: ctx.res.status,
                ms: Math.round(performance.now() - started),
            }),
        );
    });
    app.use('*', secureHeaders());
    // Cookies are SameSite=Strict; checking Origin as well stops cross-site form posts outright.
    app.use('/api/*', async (ctx, next) => {
        if (!['GET', 'HEAD'].includes(ctx.req.method))
            assert(
                options.origins.includes(ctx.req.header('origin') ?? ''),
                'FORBIDDEN',
                'Request origin is not allowed.',
                403,
            );
        await next();
    });
    app.onError((error, ctx) => {
        let e: DomainError;
        if (error instanceof DomainError) e = error;
        else if (error instanceof z.ZodError)
            e = new DomainError(
                'VALIDATION_ERROR',
                'Check the request fields.',
                400,
                error.issues.map((i) => ({ path: i.path, message: i.message })),
            );
        else {
            const name = (error as { name?: string; }).name ?? 'Error';
            const known: Record<string, [string, string, number]> = {
                NotAuthorizedException: ['AUTH_INVALID', 'Email, password, or code is incorrect.', 401],
                CodeMismatchException: ['AUTH_INVALID', 'That code did not match. Try the next one.', 400],
                EnableSoftwareTokenMFAException: ['AUTH_INVALID', 'That code did not match.', 400],
                ExpiredCodeException: ['AUTH_EXPIRED', 'This sign-in step expired. Start again.', 400],
                InvalidPasswordException: ['VALIDATION_ERROR', 'Choose a stronger password.', 400],
                PasswordResetRequiredException: [
                    'PASSWORD_RESET_REQUIRED',
                    'Ask an administrator to reset your console password.',
                    403,
                ],
                UserNotFoundException: ['USER_NOT_FOUND', 'This sign-in account no longer exists.', 404],
                InvalidParameterException: [
                    'INVALID_STATE',
                    'The account is not in a state that allows this.',
                    409,
                ],
                TooManyRequestsException: ['RATE_LIMITED', 'Please wait before trying again.', 429],
                LimitExceededException: ['RATE_LIMITED', 'Please wait before trying again.', 429],
            };
            const mapped = known[name];
            e = mapped
                ? new DomainError(...mapped)
                : new DomainError('INTERNAL_ERROR', 'The request could not be completed.', 500);
            if (!mapped)
                console.error(
                    JSON.stringify({
                        event: 'admin_request_failed',
                        requestId: ctx.get('requestId'),
                        errorType: name,
                    }),
                );
        }
        if (e.status === 401) signOut(ctx);
        return ctx.json(
            {
                error: {
                    code: e.code,
                    message: e.message,
                    requestId: ctx.get('requestId'),
                    ...(e.details ? { details: e.details } : {}),
                },
            },
            e.status as 400,
        );
    });

    async function body<T extends z.ZodType>(ctx: Context<Env>, schema: T): Promise<z.output<T>> {
        const text = await ctx.req.text();
        assert(text.length <= 64 * 1024, 'VALIDATION_ERROR', 'Request body is too large.', 413);
        try {
            return schema.parse(JSON.parse(text || '{}'));
        } catch (error) {
            if (error instanceof SyntaxError)
                throw new DomainError('VALIDATION_ERROR', 'Request must contain valid JSON.');
            throw error;
        }
    }
    /** The signed-in staff member, renewing an expired access cookie from the refresh cookie. */
    async function staff(ctx: Context<Env>) {
        const access = getCookie(ctx, ACCESS);
        const refresh = getCookie(ctx, REFRESH);
        if (access)
            try {
                return await auth.identity(access);
            } catch (error) {
                if (!(error instanceof DomainError) || error.status !== 401 || !refresh) throw error;
            }
        assert(refresh, 'AUTH_REQUIRED', 'Sign in to the console.', 401);
        let tokens: StaffTokens;
        try {
            tokens = await auth.refresh(refresh);
        } catch {
            throw new DomainError('AUTH_INVALID', 'Your console session expired. Sign in again.', 401);
        }
        signIn(ctx, tokens);
        return auth.identity(tokens.accessToken);
    }
    const guard =
        (permission: StaffPermission) => async (ctx: Context<Env>, next: () => Promise<void>) => {
            const member = await staff(ctx);
            assert(can(member.role, permission), 'FORBIDDEN', 'Your role cannot do this.', 403);
            await rateLimit(`staff:${member.id}`, 300);
            ctx.set('staff', member);
            await next();
        };
    const userId = (ctx: Context<Env>) => c.id.parse(ctx.req.param('id'));
    /** Sets the session cookies once sign-in completes; tokens never appear in a response. */
    const step = async (ctx: Context<Env>, result: StaffAuthStep) => {
        if (result.status === 'CHALLENGE') return ctx.json(staffLoginResultSchema.parse(result));
        const member = await auth.identity(result.tokens.accessToken);
        signIn(ctx, result.tokens);
        return ctx.json(staffLoginResultSchema.parse({ status: 'SIGNED_IN', staff: member }));
    };

    app.get('/health', (ctx) => ctx.json({ status: 'ok' }));
    const v1 = new Hono<Env>();
    v1.post('/auth/login', async (ctx) => {
        const input = await body(ctx, loginBody);
        await rateLimit(`login:${input.email}`, 10);
        return step(ctx, await auth.login(input.email, input.password));
    });
    v1.post('/auth/challenge', async (ctx) => {
        const input = await body(ctx, challengeBody);
        await rateLimit(`login:${input.email}`, 10);
        return step(ctx, await auth.respond(input));
    });
    v1.post('/auth/logout', async (ctx) => {
        const refresh = getCookie(ctx, REFRESH);
        if (refresh) await auth.logout(refresh).catch(() => undefined);
        signOut(ctx);
        return ctx.json({ signedOut: true });
    });
    v1.get('/me', guard('read'), (ctx) => ctx.json({ staff: staffSchema.parse(ctx.get('staff')) }));
    v1.get('/overview', guard('read'), async (ctx) =>
        ctx.json(adminOverviewSchema.parse(await admin.overview(ctx.req.query('refresh') === '1'))),
    );
    v1.get('/audit', guard('read'), async (ctx) => {
        const { cursor } = searchQuery.parse(ctx.req.query());
        return ctx.json(auditPageSchema.parse(await admin.auditLog(cursor)));
    });
    v1.get('/users', guard('read'), async (ctx) => {
        const { q, cursor } = searchQuery.parse(ctx.req.query());
        return ctx.json(adminUserPageSchema.parse(await admin.search(q, cursor)));
    });
    v1.get('/users/:id', guard('read'), async (ctx) =>
        ctx.json(adminUserDetailSchema.parse(await admin.detail(userId(ctx)))),
    );
    v1.put('/users/:id/quota', guard('quota'), async (ctx) => {
        const i = await body(ctx, adminQuotaBody);
        return ctx.json(await admin.setQuota(ctx.get('staff'), userId(ctx), i.quotaBytes, i.reason));
    });
    const reasonAction = (
        path: string,
        permission: StaffPermission,
        run: (staff: Staff, id: string, reason: string) => Promise<unknown>,
    ) =>
        v1.post(`/users/:id/${path}`, guard(permission), async (ctx) => {
            const { reason } = await body(ctx, adminReasonBody);
            return ctx.json(await run(ctx.get('staff'), userId(ctx), reason));
        });
    reasonAction('password-reset', 'password-reset', (s, id, r) => admin.resetPassword(s, id, r));
    reasonAction('verification/resend', 'resend-verification', (s, id, r) =>
        admin.resendVerification(s, id, r),
    );
    reasonAction('verification/confirm', 'confirm', (s, id, r) => admin.confirm(s, id, r));
    reasonAction('sign-out', 'sign-out', (s, id, r) => admin.signOut(s, id, r));
    reasonAction('suspend', 'suspend', (s, id, r) => admin.suspend(s, id, r));
    reasonAction('unsuspend', 'suspend', (s, id, r) => admin.unsuspend(s, id, r));
    v1.post('/users/:id/devices/:deviceId/sign-out', guard('sign-out'), async (ctx) => {
        const { reason } = await body(ctx, adminReasonBody);
        const deviceId = c.id.parse(ctx.req.param('deviceId'));
        return ctx.json(await admin.signOutDevice(ctx.get('staff'), userId(ctx), deviceId, reason));
    });
    v1.post('/users/:id/notes', guard('note'), async (ctx) => {
        const { text } = await body(ctx, adminNoteBody);
        return ctx.json(auditEntrySchema.parse(await admin.note(ctx.get('staff'), userId(ctx), text)));
    });
    v1.post('/users/:id/delete', guard('delete'), async (ctx) => {
        const i = await body(ctx, adminDeleteBody);
        return ctx.json(
            await admin.deleteAccount(ctx.get('staff'), userId(ctx), i.confirmEmail, i.reason, {
                reason: i.category,
                notify: i.notify,
            }),
        );
    });
    v1.post('/deleted-accounts/purge', guard('delete'), async (ctx) => {
        const { reason } = await body(ctx, adminReasonBody);
        return ctx.json(
            adminPurgeResultSchema.parse(await admin.purgeDeletedAccounts(ctx.get('staff'), reason)),
        );
    });
    v1.get('/beta', guard('read'), async (ctx) =>
        ctx.json(adminBetaSchema.parse(await beta.summary())),
    );
    v1.post('/beta/wave', guard('beta'), async (ctx) => {
        const i = await body(ctx, adminWaveBody);
        const member = ctx.get('staff');
        const result = await beta.openWave(i.cap, (tx, invited) =>
            admin.audit(tx, member, {
                action: 'BETA_WAVE',
                reason: i.reason,
                details: { cap: i.cap, invited },
            }),
        );
        return ctx.json(
            adminBetaSchema.extend({ newlyInvited: z.number() }).parse(result),
        );
    });
    app.route('/api/v1/admin', v1);
    app.notFound((ctx) =>
        ctx.json({ error: { code: 'NOT_FOUND', message: 'Endpoint not found.' } }, 404),
    );
    return { app, admin };
}
