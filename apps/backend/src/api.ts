import { Hono, type Context } from 'hono';
import { routePath } from 'hono/route';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import * as c from '@harbor/contracts';
import { ArchiveWorkflows } from './archives';
import { Backups } from './backups';
import {
  backupEntrySchema,
  backupRootSchema,
  backupRunSchema,
  backupRestoreSchema,
} from '../../../packages/contracts/src/backups';
import {
  browserId,
  formSubmitBody,
  formSubmitResultSchema,
  formViewSchema,
} from '../../../packages/contracts/src/forms';
import { formView, submitForm } from './forms';
import { SyncRelay } from './sync-relay';
import { SyncSharing } from './sync-sharing';
import { UsageService } from './usage';
import { StorageService, userPK } from './domain';
import { DomainError, assert } from './errors';
import { transact } from './repository';
import { assertDeviceMayRegister, assertInboxFree } from './signup-guard';
import { needsSecondStep, type AuthProvider, type Tokens } from './auth';
import type { Realtime } from './realtime';
import { PushRegistrations } from './push';
import { responseSchema, queryParameters } from './responses';
import { storageAudit } from './storage-audit';
import { Beta } from './beta';
import { featureFlagsFor, recordFlagUsage, type FeatureFlags, type UsageInput } from './flags';
import {
  linkSubscription,
  setLinkProductUpdates,
  unsubscribeSubject,
  type EmailLinks,
} from './email-preferences';
type Env = {
  Variables: {
    identity: c.Identity;
    requestId: string;
    timing?: Record<string, number>;
    /** The calling app's device, once the session is registered. */
    device?: c.Device;
  };
};
type Handler = (ctx: Context<Env>, input: any) => Promise<unknown>;
type Definition = {
  method: string;
  path: string;
  summary: string;
  body?: z.ZodType;
  response: z.ZodType;
  public?: boolean;
  handler: Handler;
};
const pageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  cursor: z.string().max(4096).optional(),
});
const op = z.object({ operationId: c.operationId }).strict();
const email = z
  .email()
  .max(254)
  .transform((v) => v.toLowerCase());
const password = z.string().min(12).max(256);
const anyObject = z.record(z.string(), z.unknown());
const folderBody = z
  .object({ operationId: c.operationId, parentId: c.id.nullable().default(null), name: c.filename })
  .strict();
const deleteAccountPath = '/v1/users/me/delete';
const sessionChallengePath = '/v1/auth/session/challenge';
const bearer = (ctx: Context<Env>) => ctx.req.header('Authorization')?.match(/^Bearer (.+)$/)?.[1];
const userId = (ctx: Context<Env>) => ctx.get('identity').id;
const p = (ctx: Context<Env>, name: string) => c.id.parse(ctx.req.param(name));
/**
 * Guards a route for a feature still being rolled out: accounts without the flag, or on an app
 * build older than the flag allows, are refused as if the feature were not there yet. Use it as
 * `add('post', path, summary, body, response, flagged(flags, 'key', handler))`.
 */
export const flagged =
  (flags: FeatureFlags, key: c.FlagKey, handler: Handler): Handler =>
  async (ctx, input) => {
    assert(
      await flags.enabled(key, userId(ctx), ctx.get('device')),
      'FEATURE_UNAVAILABLE',
      "This feature isn't available on your account yet.",
      403,
    );
    return handler(ctx, input);
  };
export function createApp(
  service: StorageService,
  auth: AuthProvider,
  origins: string[] = [],
  wakeArchives?: () => Promise<void>,
  realtime?: Pick<Realtime, 'ticket'>,
  beta = new Beta(service.repo, false),
  /** Signs and checks unsubscribe links; without it every link is refused. */
  emailLinks?: EmailLinks,
) {
  // A scheduled invocation also resumes background work if an immediate wake-up fails.
  const wakeWorker = async () => {
    await wakeArchives?.().catch(() => console.error('Background worker wake-up failed'));
  };
  const app = new Hono<Env>();
  const definitions: Definition[] = [];
  app.use('*', async (ctx, next) => {
    const requestId = crypto.randomUUID();
    ctx.set('requestId', requestId);
    ctx.header('X-Request-ID', requestId);
    ctx.header('Cache-Control', 'no-store');
    const started = performance.now();
    await next();
    // One line per request for the operations dashboard. The route is the matched
    // pattern, never the concrete path, so no resource ids reach the logs.
    const matched = routePath(ctx, -1);
    console.log(
      JSON.stringify({
        event: 'request',
        requestId,
        method: ctx.req.method,
        route: matched === '/*' ? '(no route)' : matched,
        status: ctx.res.status,
        ms: Math.round(performance.now() - started),
        // Milliseconds spent on each sign-in check before the route itself runs.
        ...(ctx.get('timing') ? { timing: ctx.get('timing') } : {}),
      }),
    );
  });
  app.use('*', secureHeaders());
  app.use(
    '*',
    cors({
      origin: (origin) => (origins.includes(origin) ? origin : undefined),
      allowHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'X-Request-ID'],
      exposeHeaders: ['X-Request-ID'],
      allowMethods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    }),
  );
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
      const name = (error as { name: string }).name;
      const known: Record<string, [string, string, number]> = {
        NotAuthorizedException: ['AUTH_INVALID', 'Email, password, or session is invalid.', 401],
        UserNotConfirmedException: ['EMAIL_NOT_VERIFIED', 'Verify your email to sign in.', 403],
        UsernameExistsException: [
          'EMAIL_ALREADY_REGISTERED',
          'This email is already registered.',
          409,
        ],
        UserLambdaValidationException: [
          'VALIDATION_ERROR',
          'Registration could not be completed. Choose an available username.',
          400,
        ],
        CodeMismatchException: ['AUTH_INVALID', 'The verification code is incorrect.', 400],
        ExpiredCodeException: ['AUTH_EXPIRED', 'The verification code expired.', 400],
        // The refresh token was already rotated (by another client or a lost response).
        RefreshTokenReuseException: ['AUTH_INVALID', 'Your session expired. Sign in again.', 401],
        TooManyRequestsException: ['RATE_LIMITED', 'Please wait before trying again.', 429],
        LimitExceededException: ['RATE_LIMITED', 'Please wait before trying again.', 429],
        InvalidPasswordException: ['VALIDATION_ERROR', 'Use a stronger password.', 400],
        // Support reset the password from the management console and emailed a code.
        PasswordResetRequiredException: [
          'PASSWORD_RESET_REQUIRED',
          'Your password was reset. Use "Forgot password" with the code we emailed you.',
          403,
        ],
      };
      // A sign-up trigger's own message (the username is taken, the beta wave is full) is
      // clearer than a generic one; Cognito wraps it as "PreSignUp failed with error <message>."
      const triggerMessage =
        name === 'UserLambdaValidationException'
          ? (error as Error).message.match(/failed with error (.+?)\.?$/s)?.[1]
          : undefined;
      const mapped = known[name];
      e = triggerMessage
        ? new DomainError('VALIDATION_ERROR', triggerMessage, 400)
        : mapped
          ? new DomainError(...mapped)
          : new DomainError(
              'INTERNAL_ERROR',
              'The request could not be completed. Retry with the same operation ID.',
              500,
            );
      if (!mapped)
        console.error(
          JSON.stringify({
            event: 'request_failed',
            requestId: ctx.get('requestId'),
            errorType: name,
          }),
        );
    }
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
  async function rateLimit(key: string, max: number) {
    const bucket = Math.floor(Date.now() / 60000);
    const k = createHash('sha256').update(key).digest('hex');
    assert(
      await service.repo.increment({ pk: 'RATE', sk: `${k}#${bucket}` }, max, (bucket + 2) * 60),
      'RATE_LIMITED',
      'Too many requests. Please try again shortly.',
      429,
    );
  }
  function route(d: Definition) {
    definitions.push(d);
    app.on(d.method.toUpperCase(), d.path, async (ctx) => {
      if (!d.public) {
        const token = bearer(ctx);
        assert(token, 'AUTH_REQUIRED', 'Sign in to continue.', 401);
        const timing: Record<string, number> = {};
        ctx.set('timing', timing);
        const timed = async <T>(name: string, work: Promise<T>) => {
          const start = performance.now();
          try {
            return await work;
          } finally {
            timing[name] = Math.round(performance.now() - start);
          }
        };
        const identity = await timed('auth', auth.identity(token));
        assert(identity.emailVerified, 'EMAIL_NOT_VERIFIED', 'Verify your email first.', 403);
        ctx.set('identity', identity);
        // Registration (and its key challenge) is how a session becomes a checked device.
        const registering = d.path === '/v1/auth/session' || d.path === sessionChallengePath;
        if (!registering)
          assert(identity.deviceId, 'AUTH_INVALID', 'Register this session first.', 401);
        // These checks are independent reads, so they run together rather than adding a
        // database round trip each to every request. Failures report in their usual order.
        const checks = await Promise.allSettled([
          // A retried deletion must get past its own tombstone to finish removing the sign-in.
          timed('profile', service.ensureUser(identity, d.path === deleteAccountPath)),
          !registering && timed('device', service.checkDevice(identity.id, identity.deviceId!)),
          timed('rate', rateLimit(`user:${identity.id}`, 600)),
        ]);
        for (const check of checks) if (check.status === 'rejected') throw check.reason;
        if (checks[1].status === 'fulfilled' && checks[1].value) ctx.set('device', checks[1].value);
      }
      let input: unknown = {};
      if (d.body) {
        assert(
          Number(ctx.req.header('content-length') ?? 0) <= 1024 * 1024,
          'VALIDATION_ERROR',
          'Request body is too large.',
          413,
        );
        try {
          const text = await ctx.req.text();
          assert(text.length <= 1024 * 1024, 'VALIDATION_ERROR', 'Request body is too large.', 413);
          input = d.body.parse(JSON.parse(text || '{}'));
        } catch (error) {
          if (error instanceof SyntaxError)
            throw new DomainError('VALIDATION_ERROR', 'Request must contain valid JSON.');
          throw error;
        }
      }
      if (d.public && d.path.startsWith('/v1/auth/')) {
        const data = input as { email?: string; refreshToken?: string };
        await rateLimit(
          `auth:${
            data.email ??
            createHash('sha256')
              .update(data.refreshToken ?? '')
              .digest('hex')
          }`,
          20,
        );
      }
      const result = await d.handler(ctx, input);
      const validated = d.response.safeParse(result);
      if (!validated.success)
        throw new DomainError('INTERNAL_ERROR', 'The server response could not be validated.', 500);
      return ctx.json(validated.data as object);
    });
  }
  const flags = featureFlagsFor(service.repo);
  const add = (
    method: string,
    path: string,
    summary: string,
    body: z.ZodType | undefined,
    response: z.ZodType,
    handler: Handler,
    isPublic = false,
  ) =>
    route({
      method,
      path,
      summary,
      body,
      response: responseSchema(method, path, response),
      handler,
      public: isPublic,
    });
  add(
    'get',
    '/health',
    'Health',
    undefined,
    z.object({ status: z.string() }),
    async () => ({ status: 'ok' }),
    true,
  );
  add(
    'post',
    '/v1/auth/signup',
    'Create a Cognito account',
    z
      .object({
        email,
        password,
        username: c.username,
        displayName: z.string().min(1).max(100),
        // The code from a beta sign-up link; required while the beta is invite-only.
        inviteCode: z.string().min(1).max(64).optional(),
        // This browser's device public key (SPKI, base64url), to limit accounts per browser.
        deviceKey: z
          .string()
          .regex(/^[A-Za-z0-9_-]{40,400}$/)
          .optional(),
      })
      .strict(),
    anyObject,
    async (_, { deviceKey, ...input }) => {
      const existing = await service.lookup(input.username);
      assert(existing.users.length === 0, 'USERNAME_TAKEN', 'This username is taken.', 409);
      await transact(service.repo, (tx) => assertInboxFree(tx, input.email));
      if (deviceKey) await assertDeviceMayRegister(service.repo, deviceKey);
      // Cognito's sign-up trigger takes the seat too, for sign-ups that skip this API.
      await beta.claim(input.email, input.inviteCode);
      return auth.signup(input);
    },
    true,
  );
  add(
    'post',
    '/v1/auth/request-access',
    'Email a beta sign-up link, or join the waitlist when the current wave is full',
    z.object({ email }).strict(),
    c.accessRequestResultSchema,
    async (_, i) => {
      const result = await beta.request(i.email);
      if (result.status === 'INVITED') await wakeWorker();
      return result;
    },
    true,
  );
  add(
    'get',
    '/v1/beta',
    'Whether sign-up needs a beta link and whether requests get one at once',
    undefined,
    c.betaStatusSchema,
    async () => beta.status(),
    true,
  );
  add(
    'get',
    '/v1/beta/invites/:code',
    'The email address a beta sign-up link was sent to; null for a test link, which takes any',
    undefined,
    z.object({ email: z.string().nullable() }),
    async (ctx) => beta.inviteEmail(z.string().min(1).max(64).parse(ctx.req.param('code'))),
    true,
  );
  add(
    'post',
    '/v1/auth/confirm',
    'Verify email',
    z.object({ email, code: z.string().min(1).max(20) }).strict(),
    anyObject,
    async (_, i) => auth.confirm(i.email, i.code),
    true,
  );
  add(
    'post',
    '/v1/auth/resend',
    'Resend verification',
    z.object({ email }).strict(),
    anyObject,
    async (_, i) => auth.resend(i.email),
    true,
  );
  /** Records a two-step verification event in the console's usage log for the flag. */
  const twoFactorUsage = (event: c.FlagUsageEvent<'two-factor'>, input: UsageInput) =>
    recordFlagUsage(service.repo, 'two-factor', event, input);
  const signInDevice = {
    deviceName: z.string().max(100).default('Web browser'),
    platform: c.platform.default('WEB'),
  };
  /** Registers the signed-in session as a device; every finished sign-in goes through here. */
  const signedIn = async (
    tokens: Tokens,
    device: { deviceName: string; platform: z.infer<typeof c.platform> },
  ) => {
    const identity = await auth.identity(tokens.accessToken);
    await service.ensureUser(identity);
    const registered = await service.registerDevice(
      identity.id,
      { name: device.deviceName, platform: device.platform },
      identity.deviceId,
    );
    await service.claimPending(identity.id);
    return { ...tokens, device: registered.device };
  };
  add(
    'post',
    '/v1/auth/login',
    'Sign in; accounts with two-step verification get a challenge instead of tokens',
    z
      .object({
        email,
        password: z.string().min(1).max(256),
        ...signInDevice,
        // Apps that can ask for a second-step code say so; others are told to update.
        twoFactor: z.boolean().optional(),
      })
      .strict(),
    anyObject,
    async (_, i) => {
      const result = await auth.login(i.email, i.password);
      if (!needsSecondStep(result)) return signedIn(result, i);
      if (!i.twoFactor)
        await twoFactorUsage('APP_UNSUPPORTED', {
          email: i.email,
          details: { platform: i.platform },
        });
      assert(
        i.twoFactor,
        'TWO_FACTOR_UNSUPPORTED',
        'This account uses two-step verification, which this version of the app doesn’t support. Update the app, or sign in on the web.',
        403,
      );
      return { twoFactor: result.challenge };
    },
    true,
  );
  const secondStep = { email, session: z.string().min(1).max(8192), method: c.twoFactorMethod };
  add(
    'post',
    '/v1/auth/login/method',
    'Choose how to finish a two-step sign-in; an email code is sent now',
    z.object(secondStep).strict(),
    z.object({ twoFactor: c.twoFactorChallengeSchema }),
    async (_, i) => ({ twoFactor: await auth.chooseSecondStep(i.email, i.session, i.method) }),
    true,
  );
  add(
    'post',
    '/v1/auth/login/verify',
    'Finish a two-step sign-in with the code',
    z
      .object({
        ...secondStep,
        code: z.string().regex(/^\d{6,8}$/, 'Enter the code.'),
        ...signInDevice,
      })
      .strict(),
    anyObject,
    async (_, i) => {
      let tokens;
      try {
        tokens = await auth.verifySecondStep(i.email, i.session, i.method, i.code);
      } catch (error) {
        if (error instanceof DomainError && error.code === 'AUTH_INVALID')
          await twoFactorUsage('CODE_REJECTED', {
            email: i.email,
            details: { method: i.method, platform: i.platform },
          });
        throw error;
      }
      const result = await signedIn(tokens, i);
      const identity = await auth.identity(tokens.accessToken);
      await twoFactorUsage('SIGNED_IN', {
        userId: identity.id,
        email: identity.email,
        details: { method: i.method, platform: i.platform },
      });
      return result;
    },
    true,
  );
  add(
    'post',
    '/v1/auth/refresh',
    'Rotate refresh credentials',
    z.object({ refreshToken: z.string().min(1).max(10000) }).strict(),
    anyObject,
    async (_, i) => {
      const tokens = await auth.refresh(i.refreshToken);
      const identity = await auth.identity(tokens.accessToken);
      await service.checkDevice(identity.id, identity.deviceId!);
      return tokens;
    },
    true,
  );
  add(
    'post',
    '/v1/auth/logout',
    'Revoke session',
    z.object({ refreshToken: z.string().min(1).max(10000) }).strict(),
    anyObject,
    async (ctx, i) => {
      await service.revokeSession(userId(ctx), ctx.get('identity').deviceId!);
      await auth.logout(i.refreshToken);
      return { loggedOut: true };
    },
  );
  add(
    'post',
    '/v1/auth/forgot',
    'Request password reset',
    z.object({ email }).strict(),
    anyObject,
    async (_, i) => auth.forgot(i.email),
    true,
  );
  add(
    'post',
    '/v1/auth/reset',
    'Reset password',
    z.object({ email, code: z.string().min(1).max(20), password }).strict(),
    anyObject,
    async (_, i) => auth.reset(i.email, i.code, i.password),
    true,
  );
  const deviceInput = z
    .object({
      name: z.string().min(1).max(100),
      platform: c.platform,
      devicePublicId: z.string().max(128).optional(),
      appVersion: z.string().max(32).optional(),
      proof: c.deviceProofSchema.optional(),
    })
    .strict();
  add(
    'post',
    sessionChallengePath,
    'Issue a challenge for this session to sign with its device key',
    undefined,
    z.object({ challenge: z.string(), userId: z.string(), expiresAt: z.string() }),
    async (ctx) => {
      const deviceId = ctx.get('identity').deviceId;
      assert(deviceId, 'FORBIDDEN', 'A registered device is required.', 403);
      return service.deviceChallenge(userId(ctx), deviceId);
    },
  );
  add(
    'post',
    '/v1/auth/session',
    'Register a managed-login session',
    deviceInput,
    z.object({ device: c.deviceSchema }),
    async (ctx, i) => service.registerDevice(userId(ctx), i, ctx.get('identity').deviceId),
  );
  add(
    'get',
    '/v1/users/me',
    'Current account, quota, and the features turned on for it on this app',
    undefined,
    z.object({ user: c.userSchema, storage: c.storageSchema, flags: c.flagStatesSchema }),
    async (ctx) => {
      const [me, states] = await Promise.all([
        service.me(userId(ctx)),
        flags.states(userId(ctx), ctx.get('device')),
      ]);
      return { ...me, flags: states };
    },
  );
  add(
    'get',
    '/v1/storage/audit',
    'List every stored file version counted toward storage',
    undefined,
    c.storageAuditPageSchema,
    async (ctx) => {
      const q = pageQuery.parse(ctx.req.query());
      return storageAudit(service, userId(ctx), q.limit, q.cursor);
    },
  );
  add(
    'patch',
    '/v1/users/me',
    'Update profile',
    z
      .object({
        operationId: c.operationId,
        username: c.username.optional(),
        displayName: z.string().min(1).max(100).optional(),
        appearance: c.appearanceSchema.optional(),
        emailPreferences: c.emailPreferencesSchema.optional(),
      })
      .strict(),
    z.object({ user: c.userSchema }),
    async (ctx, i) => service.updateProfile(userId(ctx), i),
  );
  // Unsubscribe links work without signing in: the signed token in `t` names the account, or
  // the address for one without an account.
  // The POST takes no JSON body, as mail apps' one-click requests send a form body (RFC 8058).
  const linkSubject = async (ctx: Context<Env>) => {
    const token = ctx.req.query('t');
    await rateLimit(`email-link:${token ?? ''}`, 30);
    return unsubscribeSubject(emailLinks, token);
  };
  add(
    'get',
    '/v1/email/unsubscribe',
    'Which optional emails the account behind an unsubscribe link gets',
    undefined,
    z.object({ subscription: c.emailSubscriptionSchema }),
    async (ctx) => ({ subscription: await linkSubscription(service, await linkSubject(ctx)) }),
    true,
  );
  add(
    'post',
    '/v1/email/unsubscribe',
    'Stop product update emails for the account behind an unsubscribe link',
    undefined,
    z.object({ subscription: c.emailSubscriptionSchema }),
    async (ctx) => ({
      subscription: await setLinkProductUpdates(service, await linkSubject(ctx), false),
    }),
    true,
  );
  add(
    'post',
    '/v1/email/resubscribe',
    'Turn product update emails back on from an unsubscribe link',
    undefined,
    z.object({ subscription: c.emailSubscriptionSchema }),
    async (ctx) => ({
      subscription: await setLinkProductUpdates(service, await linkSubject(ctx), true),
    }),
    true,
  );
  // Forms from the console, answered without signing in: from a shared link, or a campaign
  // email's personal link (`r`). A signed-in session, when there is one, says who is answering.
  const formHints = async (ctx: Context<Env>, r?: string, browser?: string) => {
    let accountId: string | undefined;
    const token = bearer(ctx);
    if (token)
      try {
        const identity = await auth.identity(token);
        if (identity.emailVerified) accountId = identity.id;
      } catch {
        // An expired or revoked session answers as if signed out.
      }
    return { r, browser, accountId };
  };
  add(
    'get',
    '/v1/forms/:id',
    'A form to answer, and who the answers would be recorded as',
    undefined,
    z.object({ view: formViewSchema }),
    async (ctx) => {
      const id = p(ctx, 'id');
      const browser = browserId.safeParse(ctx.req.query('b')).data;
      const r = z.string().max(400).safeParse(ctx.req.query('r')).data;
      await rateLimit(`form-view:${id}:${browser ?? r ?? ''}`, 60);
      return { view: await formView(service.repo, emailLinks, id, await formHints(ctx, r, browser)) };
    },
    true,
  );
  add(
    'post',
    '/v1/forms/:id/responses',
    'Answer a form; with one response per person, answering again replaces the earlier answers',
    formSubmitBody,
    formSubmitResultSchema,
    async (ctx, i) => {
      const id = p(ctx, 'id');
      await rateLimit(`form:${id}:${i.r ?? i.browser ?? ''}`, 10);
      // A ceiling for the form as a whole, against scripted answers from many browser IDs.
      await rateLimit(`form:${id}`, 300);
      return submitForm(service.repo, emailLinks, id, await formHints(ctx, i.r, i.browser), i.answers);
    },
    true,
  );
  add(
    'post',
    deleteAccountPath,
    'Delete the account; its data is purged 30 days later',
    z.object({ operationId: c.operationId, email }).strict(),
    z.object({ deletedAt: z.string(), purgeAt: z.string() }),
    async (ctx, i) => {
      const result = await service.deleteAccount(userId(ctx), i);
      await auth.deleteUser(bearer(ctx)!);
      return result;
    },
  );
  // An account has at most one second step. Turning one on is rolled out behind a flag; reading and turning off are not, so
  // an account keeps control of what it turned on if the flag is later taken off.
  const twoFactorPath = '/v1/users/me/two-factor';
  const twoFactorResponse = z.object({ twoFactor: c.twoFactorStatusSchema });
  const twoFactorStatus = async (ctx: Context<Env>) => ({
    twoFactor: await auth.twoFactorStatus(bearer(ctx)!),
  });
  /** Emails the account holder whenever a second step is turned on, switched or turned off. */
  const twoFactorChanged = async (
    ctx: Context<Env>,
    method: c.TwoFactorMethod,
    enabled: boolean,
    before: c.TwoFactorStatus,
  ) => {
    const other = method === 'TOTP' ? 'EMAIL' : 'TOTP';
    const replaced = enabled && before[other === 'TOTP' ? 'totp' : 'email'] ? other : undefined;
    await twoFactorUsage(
      !enabled ? 'TURNED_OFF' : method === 'TOTP' ? 'TOTP_TURNED_ON' : 'EMAIL_TURNED_ON',
      {
        userId: ctx.get('identity').id,
        email: ctx.get('identity').email,
        details: { method, ...(replaced ? { replaced } : {}) },
      },
    );
    const { id, email, displayName } = ctx.get('identity');
    const at = new Date().toISOString();
    await transact(service.repo, (tx) =>
      service.email(tx, `two-factor-${id}-${at}-${crypto.randomUUID()}`, {
        template: 'TWO_FACTOR_CHANGED',
        to: email,
        name: displayName,
        method,
        enabled,
        ...(replaced ? { replaced } : {}),
        at,
      }),
    );
    await wakeWorker();
    return twoFactorStatus(ctx);
  };
  add(
    'get',
    twoFactorPath,
    'Which two-step verification methods are on',
    undefined,
    twoFactorResponse,
    twoFactorStatus,
  );
  add(
    'post',
    `${twoFactorPath}/totp/setup`,
    'Start adding an authenticator app',
    undefined,
    c.totpSetupSchema,
    flagged(flags, 'two-factor', async (ctx) => {
      const { id, email } = ctx.get('identity');
      const setup = await auth.setupTotp(bearer(ctx)!, email);
      await twoFactorUsage('TOTP_SETUP_STARTED', { userId: id, email });
      return setup;
    }),
  );
  add(
    'post',
    `${twoFactorPath}/totp/verify`,
    'Turn on the authenticator app with its first code; it replaces email codes',
    z.object({ code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code.') }).strict(),
    twoFactorResponse,
    flagged(flags, 'two-factor', async (ctx, i) => {
      const before = await auth.twoFactorStatus(bearer(ctx)!);
      await auth.confirmTotp(bearer(ctx)!, i.code);
      return twoFactorChanged(ctx, 'TOTP', true, before);
    }),
  );
  add(
    'post',
    `${twoFactorPath}/email`,
    'Turn on email sign-in codes; they replace the authenticator app',
    undefined,
    twoFactorResponse,
    flagged(flags, 'two-factor', async (ctx) => {
      const before = await auth.twoFactorStatus(bearer(ctx)!);
      if (before.email && !before.totp) return { twoFactor: before };
      await auth.setTwoFactor(bearer(ctx)!, 'EMAIL', true);
      return twoFactorChanged(ctx, 'EMAIL', true, before);
    }),
  );
  add(
    'post',
    `${twoFactorPath}/disable`,
    'Turn off one two-step verification method',
    z.object({ method: c.twoFactorMethod }).strict(),
    twoFactorResponse,
    async (ctx, i) => {
      const before = await auth.twoFactorStatus(bearer(ctx)!);
      if (!before[i.method === 'TOTP' ? 'totp' : 'email']) return { twoFactor: before };
      await auth.setTwoFactor(bearer(ctx)!, i.method, false);
      return twoFactorChanged(ctx, i.method, false, before);
    },
  );
  const publicUser = z.object({
    id: z.string(),
    username: z.string(),
    displayName: z.string(),
    avatarUrl: z.string().nullable().optional(),
  });
  add(
    'get',
    '/v1/users/search',
    'Find recipients by username prefix or exact email',
    undefined,
    z.object({ users: z.array(publicUser) }),
    async (ctx) => {
      await rateLimit(`search:${userId(ctx)}`, 120);
      return service.searchUsers(
        userId(ctx),
        z
          .string()
          .max(254)
          .parse(ctx.req.query('q') ?? ''),
      );
    },
  );
  add(
    'get',
    '/v1/users/contacts',
    'People this account exchanges files with most',
    undefined,
    z.object({
      users: z.array(publicUser.extend({ exchangeCount: z.number(), lastExchangedAt: z.string() })),
    }),
    async (ctx) => service.contacts(userId(ctx)),
  );
  add('get', '/v1/users/lookup', 'Look up an exact username', undefined, anyObject, async (ctx) => {
    await rateLimit(`lookup:${userId(ctx)}`, 30);
    return service.lookup(z.string().min(3).max(32).parse(ctx.req.query('q')));
  });
  add(
    'get',
    '/v1/drive/items/:id',
    'Read item metadata',
    undefined,
    z.object({ item: c.itemSchema }),
    async (ctx) => service.metadata(userId(ctx), p(ctx, 'id')),
  );
  add(
    'get',
    '/v1/drive/folders/:id/children',
    'List a folder',
    undefined,
    z.object({ items: z.array(c.itemSchema), nextCursor: z.string().nullable() }),
    async (ctx) => {
      const q = pageQuery.parse(ctx.req.query());
      return p(ctx, 'id') === 'root'
        ? service.list(userId(ctx), null, q.limit, q.cursor)
        : service.sharedList(userId(ctx), p(ctx, 'id'), q.limit, q.cursor);
    },
  );
  add(
    'post',
    '/v1/drive/folders',
    'Create folder',
    folderBody,
    z.object({ item: c.itemSchema }),
    async (ctx, i) => service.createFolder(userId(ctx), i),
  );
  add(
    'patch',
    '/v1/drive/items/:id',
    'Rename an item',
    c.mutation.extend({ name: c.filename }).strict(),
    z.object({ item: c.itemSchema }),
    async (ctx, i) => service.mutate(userId(ctx), p(ctx, 'id'), i),
  );
  add(
    'post',
    '/v1/drive/items/:id/move',
    'Move an item',
    c.mutation.extend({ parentId: c.id.nullable() }).strict(),
    z.object({ item: c.itemSchema }),
    async (ctx, i) => service.mutate(userId(ctx), p(ctx, 'id'), i),
  );
  add(
    'delete',
    '/v1/drive/items/:id',
    'Move to trash',
    c.mutation.strict(),
    z.object({ item: c.itemSchema }),
    async (ctx, i) => {
      const result = await service.mutate(userId(ctx), p(ctx, 'id'), { ...i, action: 'trash' });
      // Folders are measured in the background so deleting them later frees space at once.
      if (result.item.type === 'FOLDER') await wakeWorker();
      return result;
    },
  );
  add(
    'post',
    '/v1/drive/items/:id/restore',
    'Restore from trash',
    c.mutation.strict(),
    z.object({ item: c.itemSchema }),
    async (ctx, i) => service.mutate(userId(ctx), p(ctx, 'id'), { ...i, action: 'restore' }),
  );
  add(
    'delete',
    '/v1/drive/items/:id/permanent',
    'Permanently delete a trashed item',
    c.mutation.strict(),
    anyObject,
    async (ctx, i) => {
      const result = await service.permanentDelete(userId(ctx), p(ctx, 'id'), i);
      await wakeWorker();
      return result;
    },
  );
  add(
    'post',
    '/v1/drive/trash/empty',
    'Empty the trash at once; content is deleted in the background (cursor is ignored, nextCursor is always null)',
    z.object({ operationId: c.operationId, cursor: z.string().optional() }).strict(),
    z.object({ count: z.number().int().nonnegative(), nextCursor: z.string().nullable() }),
    async (ctx, i) => {
      const result = await service.emptyTrash(userId(ctx), i);
      await wakeWorker();
      return result;
    },
  );
  for (const method of ['put', 'delete'])
    add(
      method,
      '/v1/drive/items/:id/favorite',
      'Change favorite',
      c.mutation.strict(),
      z.object({ item: c.itemSchema }),
      async (ctx, i) =>
        service.mutate(userId(ctx), p(ctx, 'id'), { ...i, favorite: method === 'put' }),
    );
  add(
    'get',
    '/v1/search',
    'Search file metadata',
    undefined,
    z.object({ items: z.array(c.itemSchema), nextCursor: z.string().nullable() }),
    async (ctx) => {
      const q = pageQuery.parse(ctx.req.query());
      return service.browseSpecial(userId(ctx), ctx.req.query(), q.limit, q.cursor);
    },
  );
  add(
    'get',
    '/v1/drive/items/:id/versions',
    'List file versions',
    undefined,
    z.object({ items: z.array(c.versionSchema.omit({ storageObjectId: true })) }),
    async (ctx) => {
      const r = await service.versions(userId(ctx), p(ctx, 'id'));
      return { items: r.items.map(({ storageObjectId: _, ...v }) => v) };
    },
  );
  add(
    'post',
    '/v1/drive/items/:id/versions/:versionId/restore',
    'Restore a version',
    c.mutation.strict(),
    z.object({ item: c.itemSchema }),
    async (ctx, i) => service.restoreVersion(userId(ctx), p(ctx, 'id'), p(ctx, 'versionId'), i),
  );
  add(
    'post',
    '/v1/uploads',
    'Reserve quota and create upload',
    c.uploadInput,
    anyObject,
    async (ctx, i) => service.createUpload(userId(ctx), i, ctx.get('identity').deviceId),
  );
  add('get', '/v1/uploads/:id', 'Resume an upload', undefined, anyObject, async (ctx) =>
    service.uploadStatus(userId(ctx), p(ctx, 'id')),
  );
  add(
    'post',
    '/v1/uploads/:id/parts',
    'Sign upload part URLs',
    z.object({ partNumbers: z.array(z.number().int().min(1).max(10000)).min(1).max(50) }).strict(),
    anyObject,
    async (ctx, i) => service.uploadParts(userId(ctx), p(ctx, 'id'), i.partNumbers),
  );
  add(
    'post',
    '/v1/uploads/:id/complete',
    'Finalize upload atomically',
    z.object({ parts: z.array(c.completedPart).min(1).max(10000), contentHash: c.hash }).strict(),
    z.object({ item: c.itemSchema }),
    async (ctx, i) => service.completeUpload(userId(ctx), p(ctx, 'id'), i.parts, i.contentHash),
  );
  add(
    'delete',
    '/v1/uploads/:id',
    'Abort upload and release reservation',
    undefined,
    anyObject,
    async (ctx) => service.abortUpload(userId(ctx), p(ctx, 'id')),
  );
  const archives = new ArchiveWorkflows(service);
  add(
    'post',
    '/v1/folder-downloads',
    'Prepare one folder ZIP in the background',
    z.object({ operationId: c.operationId, driveItemId: c.id }).strict(),
    c.folderDownloadSchema,
    async (ctx, input) => {
      const result = await archives.create(
        userId(ctx),
        ctx.get('identity').deviceId!,
        input.driveItemId,
        input.operationId,
      );
      await wakeWorker();
      return archives.status(userId(ctx), result.id);
    },
  );
  add(
    'get',
    '/v1/folder-downloads/:id',
    'Read ZIP preparation progress',
    undefined,
    c.folderDownloadSchema,
    async (ctx) => archives.status(userId(ctx), p(ctx, 'id')),
  );
  add(
    'delete',
    '/v1/folder-downloads/:id',
    'Cancel ZIP preparation',
    undefined,
    z.object({ cancelled: z.boolean() }),
    async (ctx) => archives.cancel(userId(ctx), p(ctx, 'id')),
  );
  add(
    'post',
    '/v1/downloads',
    'Authorize a short-lived download',
    z
      .object({
        folderDownloadId: c.id.optional(),
        driveItemId: c.id.optional(),
        versionId: c.id.nullable().optional(),
        transferId: c.id.optional(),
        entryId: c.id.optional(),
      })
      .strict(),
    z.object({
      downloadUrl: z.string(),
      expiresAt: z.string(),
      sizeBytes: z.number(),
      contentHash: c.hash,
      contentHashAlgorithm: z.literal('SHA256'),
    }),
    async (ctx, i) => service.download(userId(ctx), i),
  );
  add(
    'post',
    '/v1/transfers',
    'Send files to a person',
    z
      .object({
        operationId: c.operationId,
        recipient: c.recipient,
        items: z
          .array(z.object({ driveItemId: c.id }).strict())
          .min(1)
          .max(40),
      })
      .strict(),
    z.object({ transfer: c.transferSchema }),
    async (ctx, i) => service.createTransfer(userId(ctx), i),
  );
  for (const direction of ['received', 'sent'] as const)
    add(
      'get',
      `/v1/transfers/${direction}`,
      `List ${direction} transfers`,
      undefined,
      anyObject,
      async (ctx) => {
        const q = pageQuery.parse(ctx.req.query());
        return service.listTransfers(
          userId(ctx),
          direction,
          q.limit,
          q.cursor,
          ctx.req.query('state'),
        );
      },
    );
  for (const action of ['accept', 'decline', 'cancel'] as const)
    add(
      'post',
      `/v1/transfers/:id/${action}`,
      `${action} a transfer`,
      op,
      z.object({ transfer: c.transferSchema }),
      async (ctx, i) => service.transferAction(userId(ctx), p(ctx, 'id'), action, i.operationId),
    );
  add(
    'get',
    '/v1/transfers/:id/items',
    'Read a transfer manifest page',
    undefined,
    anyObject,
    async (ctx) => service.transferItems(userId(ctx), p(ctx, 'id'), ctx.req.query('cursor')),
  );
  add(
    'post',
    '/v1/transfers/:id/save',
    'Save an accepted transfer',
    op.extend({ targetParentId: c.id.nullable().default(null) }).strict(),
    z.object({
      items: z.array(c.itemSchema),
      jobId: z.string().optional(),
      state: z.string().optional(),
    }),
    async (ctx, i) => service.saveTransfer(userId(ctx), p(ctx, 'id'), i),
  );
  add(
    'post',
    '/v1/shares',
    'Grant authenticated access',
    z
      .object({
        operationId: c.operationId,
        driveItemId: c.id,
        recipient: c.recipient,
        permission: z.enum(['VIEWER', 'EDITOR']),
      })
      .strict(),
    z.object({ share: c.shareSchema }),
    async (ctx, i) => service.createShare(userId(ctx), i),
  );
  add(
    'delete',
    '/v1/shares/:id',
    'Remove shared access',
    op,
    z.object({ share: c.shareSchema }),
    async (ctx, i) => service.revokeShare(userId(ctx), p(ctx, 'id'), i.operationId),
  );
  for (const side of ['received', 'sent'])
    add('get', `/v1/shares/${side}`, `List ${side} shares`, undefined, anyObject, async (ctx) =>
      service.shares(userId(ctx), side === 'received'),
    );
  add(
    'get',
    '/v1/devices',
    'List connected devices',
    undefined,
    z.object({ items: z.array(c.deviceSchema) }),
    // Revoked devices are kept for revocation checks but are no longer connected; signed-out
    // ones stay listed because they resume when someone signs in on them again.
    async (ctx) => ({
      items: (await service.devices(userId(ctx))).items.filter(
        (device) => device.status !== 'REVOKED',
      ),
    }),
  );
  add(
    'post',
    '/v1/sync/devices/register',
    'Register this device',
    deviceInput,
    z.object({ device: c.deviceSchema }),
    async (ctx, i) => service.registerDevice(userId(ctx), i, ctx.get('identity').deviceId),
  );
  const pushRegistrations = new PushRegistrations(service.repo);
  const currentDevice = (ctx: Context<Env>) => {
    const id = ctx.get('identity').deviceId;
    assert(id, 'FORBIDDEN', 'A registered device is required.', 403);
    return id;
  };
  add(
    'put',
    '/v1/devices/current/push',
    'Register this device for change wake-ups (iOS Files extension)',
    z
      .object({
        token: z.string().regex(/^[0-9a-f]{16,200}$/i),
        environment: z.enum(['sandbox', 'production']),
        kind: z.literal('FILE_PROVIDER'),
        domain: z.string().min(1).max(200),
      })
      .strict(),
    z.object({ registered: z.boolean() }),
    async (ctx, i) =>
      pushRegistrations.register(userId(ctx), {
        ...i,
        token: i.token.toLowerCase(),
        deviceId: currentDevice(ctx),
      }),
  );
  add(
    'delete',
    '/v1/devices/current/push',
    'Stop change wake-ups for this device',
    undefined,
    z.object({ removed: z.boolean() }),
    async (ctx) => pushRegistrations.remove(userId(ctx), currentDevice(ctx)),
  );
  add(
    'delete',
    '/v1/devices/:id',
    'Revoke a device: stop its sync and archive its backups in the cloud',
    undefined,
    z.object({ device: c.deviceSchema, archivedBackups: z.number().int().min(0) }),
    async (ctx) => service.revokeDevice(userId(ctx), p(ctx, 'id')),
  );
  add(
    'post',
    '/v1/devices/:id/sign-out',
    'Sign a device out; its sync and backups pause until it signs in again',
    undefined,
    z.object({ device: c.deviceSchema }),
    async (ctx) => service.signOutDevice(userId(ctx), p(ctx, 'id')),
  );
  const syncSharing = new SyncSharing(service);
  add(
    'post',
    '/v1/sync/shares',
    'Invite another account to two-way folder sync',
    z.object({ operationId: c.operationId, driveItemId: c.id, recipient: c.recipient }).strict(),
    z.object({ share: c.shareSchema }),
    async (ctx, input) => syncSharing.invite(userId(ctx), input),
  );
  add(
    'get',
    '/v1/sync/shares',
    'List sent and received sync invitations',
    undefined,
    z.object({
      items: z.array(
        c.shareSchema.extend({
          name: z.string(),
          direction: z.enum(['SENT', 'RECEIVED']),
          owner: z.object({ id: z.string(), username: z.string(), displayName: z.string() }),
          recipient: z.object({ id: z.string(), username: z.string(), displayName: z.string() }),
        }),
      ),
    }),
    async (ctx) => syncSharing.list(userId(ctx)),
  );
  add(
    'post',
    '/v1/sync/shares/:id/respond',
    'Accept or decline a sync invitation',
    z.object({ action: z.enum(['ACCEPTED', 'DECLINED']) }).strict(),
    z.object({ share: c.shareSchema }),
    async (ctx, input) => syncSharing.respond(userId(ctx), p(ctx, 'id'), input.action),
  );
  add(
    'get',
    '/v1/sync/shares/:id/status',
    'Read an accepted shared folder revision',
    undefined,
    z.object({ share: c.shareSchema, item: c.itemSchema, sequence: z.number() }),
    async (ctx) => syncSharing.status(userId(ctx), p(ctx, 'id')),
  );
  add(
    'post',
    '/v1/realtime/tickets',
    'Issue a one-time ticket for the live updates connection',
    undefined,
    z.object({ url: z.string(), ticket: z.string(), expiresAt: z.string() }),
    async (ctx) => {
      assert(realtime, 'REALTIME_UNAVAILABLE', 'Live updates are not available.', 503);
      const deviceId = ctx.get('identity').deviceId;
      assert(deviceId, 'FORBIDDEN', 'A registered device is required.', 403);
      return realtime.ticket(userId(ctx), deviceId);
    },
  );
  add(
    'get',
    '/v1/sync/folders',
    'List synced folders across devices',
    undefined,
    z.object({ items: z.array(c.syncFolderSchema) }),
    async (ctx) => service.syncFolders(userId(ctx)),
  );
  add(
    'put',
    '/v1/sync/folders',
    'Replace this device’s synced folders',
    z.object({ folderIds: z.array(c.id).max(200) }).strict(),
    z.object({ ok: z.boolean(), removedFolderIds: z.array(c.id) }),
    async (ctx, i) => {
      const deviceId = ctx.get('identity').deviceId;
      assert(deviceId, 'FORBIDDEN', 'A registered device is required.', 403);
      return service.setSyncFolders(userId(ctx), deviceId, i.folderIds);
    },
  );
  add(
    'delete',
    '/v1/sync/folders/:id',
    'Remove a folder from sync on all linked devices, preserving local files',
    undefined,
    z.object({ ok: z.boolean() }),
    async (ctx) => service.removeSyncFolder(userId(ctx), p(ctx, 'id')),
  );
  add(
    'get',
    '/v1/drive/usage',
    'Read the storage used by folders, every stored version included',
    undefined,
    z.object({ items: z.array(c.folderUsageSchema) }),
    async (ctx) =>
      new UsageService(service).usage(
        userId(ctx),
        z
          .array(c.id)
          .min(1)
          .max(50)
          .parse((ctx.req.query('ids') ?? '').split(',')),
      ),
  );
  add(
    'get',
    '/v1/sync/status',
    'Read file and folder delivery status',
    undefined,
    z.object({ items: z.array(c.syncItemStatusSchema) }),
    async (ctx) => {
      const ids = z
        .array(c.id)
        .min(1)
        .max(50)
        .parse((ctx.req.query('ids') ?? '').split(','));
      return new SyncRelay(service).statuses(
        userId(ctx),
        ids,
        ctx.get('identity').deviceId,
        z.enum(['true', 'false']).default('true').parse(ctx.req.query('recursive')) === 'true',
      );
    },
  );
  add(
    'post',
    '/v1/sync/items/:id/acknowledge',
    'Confirm a verified local copy',
    z
      .object({
        versionId: c.id.nullable(),
        revision: z.number().int().positive(),
        contentHash: c.hash.nullable(),
      })
      .strict(),
    z.object({ ok: z.boolean(), requiredDevices: z.number(), confirmedDevices: z.number() }),
    async (ctx, input) => {
      const deviceId = ctx.get('identity').deviceId;
      assert(deviceId, 'FORBIDDEN', 'A registered device is required.', 403);
      return new SyncRelay(service).acknowledge(userId(ctx), deviceId, p(ctx, 'id'), input);
    },
  );
  add(
    'post',
    '/v1/sync/items/:id/request-content',
    'Request a temporary copy from a synced device',
    undefined,
    z.object({ item: c.itemSchema }),
    async (ctx) => {
      const deviceId = ctx.get('identity').deviceId;
      assert(deviceId, 'FORBIDDEN', 'A registered device is required.', 403);
      return new SyncRelay(service).requestContent(userId(ctx), deviceId, p(ctx, 'id'));
    },
  );
  add(
    'get',
    '/v1/sync/changes',
    'Read ordered durable changes',
    undefined,
    z.object({ changes: z.array(c.changeSchema), nextCursor: z.number(), hasMore: z.boolean() }),
    async (ctx) =>
      // `cursor=latest` returns the current position without changes, for clients that start
      // from now (e.g. the iOS Files extension) rather than replaying the whole feed.
      ctx.req.query('cursor') === 'latest'
        ? service.latestChanges(userId(ctx))
        : service.changes(
            userId(ctx),
            z.coerce.number().int().min(0).default(0).parse(ctx.req.query('cursor')),
            z.coerce.number().int().min(1).max(500).default(100).parse(ctx.req.query('limit')),
          ),
  );
  add(
    'post',
    '/v1/sync/checkpoints',
    'Advance device checkpoint',
    z.object({ deviceId: c.id, cursor: z.number().int().min(0) }).strict(),
    anyObject,
    async (ctx, i) => {
      assert(
        i.deviceId === ctx.get('identity').deviceId,
        'FORBIDDEN',
        'Checkpoint must belong to this device.',
        403,
      );
      return service.checkpoint(userId(ctx), i.deviceId, i.cursor);
    },
  );
  add(
    'post',
    '/v1/sync/operations',
    'Apply offline operations',
    z
      .object({
        deviceId: c.id,
        operations: z
          .array(
            z
              .object({
                operationId: c.operationId,
                type: z.enum(['RENAME_ITEM', 'MOVE_ITEM', 'DELETE_ITEM', 'RESTORE_ITEM']),
                entityId: c.id,
                baseRevision: z.number().int().positive(),
                payload: z
                  .object({ name: c.filename.optional(), parentId: c.id.nullable().optional() })
                  .strict(),
              })
              .strict(),
          )
          .min(1)
          .max(50),
      })
      .strict(),
    anyObject,
    async (ctx, i) => {
      assert(
        i.deviceId === ctx.get('identity').deviceId,
        'FORBIDDEN',
        'Operation device mismatch.',
        403,
      );
      const results = [];
      for (const o of i.operations) {
        try {
          if (o.type === 'RENAME_ITEM')
            assert(o.payload.name, 'VALIDATION_ERROR', 'Name is required.');
          if (o.type === 'MOVE_ITEM')
            assert(o.payload.parentId !== undefined, 'VALIDATION_ERROR', 'Parent is required.');
          const replay = await service.repo.get({
            pk: userPK(userId(ctx)),
            sk: `OP#${o.operationId}`,
          });
          const r = await service.mutate(userId(ctx), o.entityId, {
            operationId: o.operationId,
            baseRevision: o.baseRevision,
            ...o.payload,
            ...(o.type === 'DELETE_ITEM'
              ? { action: 'trash' as const }
              : o.type === 'RESTORE_ITEM'
                ? { action: 'restore' as const }
                : {}),
          });
          results.push({
            operationId: o.operationId,
            status: replay ? 'ALREADY_APPLIED' : 'APPLIED',
            revision: r.item.revision,
          });
        } catch (e) {
          if (!(e instanceof DomainError)) throw e;
          results.push({
            operationId: o.operationId,
            status: e.code === 'REVISION_CONFLICT' ? 'CONFLICT' : 'REJECTED',
            error: { code: e.code, message: e.message },
            ...((e.details as object) ?? {}),
          });
        }
      }
      return { results };
    },
  );
  add('get', '/v1/notifications', 'List notifications', undefined, anyObject, async (ctx) => {
    const q = pageQuery.parse(ctx.req.query());
    return service.notifications(userId(ctx), q.limit, q.cursor);
  });
  add(
    'post',
    '/v1/notifications/:id/read',
    'Mark notification read',
    undefined,
    anyObject,
    async (ctx) => service.markNotification(userId(ctx), p(ctx, 'id')),
  );
  add('get', '/v1/backups', 'List backup roots', undefined, anyObject, async (ctx) =>
    service.backups(userId(ctx)),
  );
  add(
    'post',
    '/v1/backups',
    'Create backup root',
    op.extend({ deviceId: c.id, name: c.filename }).strict(),
    anyObject,
    async (ctx, i) => {
      assert(
        i.deviceId === ctx.get('identity').deviceId,
        'FORBIDDEN',
        'Backup device mismatch.',
        403,
      );
      return service.backupRoot(userId(ctx), i);
    },
  );
  const backupWorkflows = new Backups(service);
  const backupDevice = (ctx: Context<Env>) => {
    const id = ctx.get('identity').deviceId;
    assert(id, 'FORBIDDEN', 'Use the desktop app for this action.', 403);
    return id;
  };
  add(
    'get',
    '/v1/backups/:id',
    'Get backup connection',
    undefined,
    z.object({ root: backupRootSchema }),
    async (ctx) => backupWorkflows.get(userId(ctx), p(ctx, 'id')),
  );
  add(
    'delete',
    '/v1/backups/:id',
    'Disconnect backup and keep its cloud folder',
    undefined,
    z.object({ root: backupRootSchema }),
    async (ctx) => backupWorkflows.disconnect(userId(ctx), p(ctx, 'id')),
  );
  add(
    'post',
    '/v1/backups/:id/forget',
    'Remove a stopped backup and its history from the list',
    undefined,
    z.object({ removed: z.boolean() }),
    async (ctx) => backupWorkflows.forget(userId(ctx), p(ctx, 'id')),
  );
  for (const [action, summary, archived] of [
    ['archive', 'Stop a backup and keep only its cloud copy', true],
    ['unarchive', 'Resume an archived backup on its computer', false],
  ] as const)
    add(
      'post',
      `/v1/backups/:id/${action}`,
      summary,
      undefined,
      z.object({ root: backupRootSchema }),
      async (ctx) =>
        backupWorkflows.archive(userId(ctx), p(ctx, 'id'), backupDevice(ctx), archived),
    );
  add(
    'post',
    '/v1/backups/:id/runs/:runId/folders',
    'Create folder in a backup run',
    folderBody,
    z.object({ item: c.itemSchema }),
    async (ctx, i) =>
      service.createFolder(userId(ctx), i, {
        rootId: p(ctx, 'id'),
        runId: p(ctx, 'runId'),
        deviceId: backupDevice(ctx),
      }),
  );
  add(
    'post',
    '/v1/backups/:id/runs/:runId/uploads',
    'Append a backup file version',
    c.uploadInput,
    anyObject,
    async (ctx, i) =>
      service.createUpload(userId(ctx), i, backupDevice(ctx), {
        rootId: p(ctx, 'id'),
        runId: p(ctx, 'runId'),
        deviceId: backupDevice(ctx),
      }),
  );
  for (const [collection, schema, prefix] of [
    ['runs', backupRunSchema, 'RUN#'],
    ['restores', backupRestoreSchema, 'RESTORE#'],
    ['pending-restores', backupRestoreSchema, 'PENDING#'],
  ] as const) {
    add(
      'get',
      `/v1/backups/:id/${collection}`,
      `List backup ${collection}`,
      undefined,
      z.object({ items: z.array(schema), nextCursor: z.string().nullable() }),
      async (ctx) =>
        backupWorkflows.page(
          userId(ctx),
          p(ctx, 'id'),
          prefix,
          pageQuery.parse(ctx.req.query()).cursor,
        ),
    );
  }
  add(
    'post',
    '/v1/backups/:id/checked',
    'Report that a backup folder has nothing new to back up',
    undefined,
    z.object({ checked: z.boolean() }),
    async (ctx) => backupWorkflows.checked(userId(ctx), p(ctx, 'id'), backupDevice(ctx)),
  );
  add(
    'post',
    '/v1/backups/:id/runs',
    'Start backup run',
    z.object({ id: c.id, trigger: z.enum(['AUTOMATIC', 'MANUAL']) }).strict(),
    z.object({ run: backupRunSchema }),
    async (ctx, i) => backupWorkflows.start(userId(ctx), p(ctx, 'id'), backupDevice(ctx), i),
  );
  add(
    'get',
    '/v1/backups/:id/runs/:runId/files',
    'List files covered by a backup',
    undefined,
    z.object({ items: z.array(backupEntrySchema), nextCursor: z.string().nullable() }),
    async (ctx) =>
      backupWorkflows.page(
        userId(ctx),
        p(ctx, 'id'),
        `ENTRY#${p(ctx, 'runId')}#`,
        pageQuery.parse(ctx.req.query()).cursor,
      ),
  );
  add(
    'post',
    '/v1/backups/:id/runs/:runId/files',
    'Record a backed up file',
    backupEntrySchema.strict(),
    anyObject,
    async (ctx, i) =>
      backupWorkflows.entry(userId(ctx), p(ctx, 'id'), backupDevice(ctx), p(ctx, 'runId'), i),
  );
  const backupResult = z.object({ error: z.string().min(1).max(2000).optional() }).strict();
  add(
    'post',
    '/v1/backups/:id/runs/:runId/complete',
    'Complete backup run',
    backupResult,
    z.object({ run: backupRunSchema }),
    async (ctx, i) =>
      backupWorkflows.finish(
        userId(ctx),
        p(ctx, 'id'),
        backupDevice(ctx),
        p(ctx, 'runId'),
        i.error,
      ),
  );
  add(
    'post',
    '/v1/backups/:id/restores',
    'Restore a backup version to its local folder',
    z.object({ id: c.id, itemId: c.id, versionId: c.id }).strict(),
    z.object({ restore: backupRestoreSchema }),
    async (ctx, i) => backupWorkflows.restore(userId(ctx), p(ctx, 'id'), i),
  );
  add(
    'post',
    '/v1/backups/:id/restores/:restoreId/complete',
    'Record local restore result',
    backupResult,
    anyObject,
    async (ctx, i) =>
      backupWorkflows.restored(
        userId(ctx),
        p(ctx, 'id'),
        backupDevice(ctx),
        p(ctx, 'restoreId'),
        i.error,
      ),
  );
  add('get', '/v1/billing/plans', 'Available storage capacity', undefined, anyObject, async () => ({
    items: [
      {
        id: 'free',
        name: 'Free',
        storageBytes: c.SIGNUP_QUOTA,
        priceMinorUnits: 0,
        currency: 'USD',
        billingPeriod: 'MONTH',
      },
    ],
    checkoutAvailable: false,
  }));
  add(
    'get',
    '/v1/billing/subscription',
    'Current storage entitlement',
    undefined,
    anyObject,
    async (ctx) => {
      const { user } = await service.me(userId(ctx));
      const baseFreeBytes = user.freeQuotaBytes ?? c.FREE_QUOTA;
      return {
        planId: 'free',
        entitlement: {
          userId: userId(ctx),
          baseFreeBytes,
          paidBytes: Math.max(0, user.storageQuotaBytes - baseFreeBytes),
          totalQuotaBytes: user.storageQuotaBytes,
        },
      };
    },
  );
  add(
    'get',
    '/ready',
    'Check metadata availability',
    undefined,
    anyObject,
    async () => {
      await service.repo.get({ pk: 'SYSTEM', sk: 'SCHEMA' });
      return { status: 'ready' };
    },
    true,
  );
  const document = () => {
    const paths: Record<string, Record<string, unknown>> = {};
    const json = (schema: z.ZodType) =>
      z.toJSONSchema(schema, { unrepresentable: 'any', io: 'input' });
    for (const d of definitions) {
      const path = d.path.replace(/:([^/]+)/g, '{$1}');
      const parameters = [...d.path.matchAll(/:([^/]+)/g)].map((m) => ({
        name: m[1],
        in: 'path',
        required: true,
        schema: { type: 'string' },
      }));
      paths[path] ??= {};
      paths[path][d.method.toLowerCase()] = {
        summary: d.summary,
        operationId: d.method + '_' + d.path.replace(/[^a-zA-Z0-9]/g, '_'),
        security: d.public ? [] : [{ bearerAuth: [] }],
        parameters: [
          ...parameters,
          ...(d.method === 'get' || d.path.startsWith('/v1/email/')
            ? queryParameters(d.path)
            : []),
        ],
        ...(d.body
          ? {
              requestBody: {
                required: true,
                content: { 'application/json': { schema: json(d.body) } },
              },
            }
          : {}),
        responses: {
          '200': {
            description: 'Success',
            content: { 'application/json': { schema: json(d.response) } },
          },
          ...Object.fromEntries(
            [400, 401, 403, 404, 409, 410, 413, 429, 500].map((status) => [
              status,
              {
                description: 'Error',
                content: { 'application/json': { schema: json(c.errorSchema) } },
              },
            ]),
          ),
        },
      };
    }
    return {
      openapi: '3.1.0',
      info: { title: 'harbor0 storage API', version: '1.0.0' },
      components: {
        securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
      },
      paths,
    };
  };
  app.get('/openapi.json', (ctx) => ctx.json(document()));
  app.notFound((ctx) =>
    ctx.json(
      {
        error: {
          code: 'NOT_FOUND',
          message: 'Endpoint not found.',
          requestId: ctx.get('requestId'),
        },
      },
      404,
    ),
  );
  return { app, document };
}
