import { Hono, type Context } from 'hono';
import { routePath } from 'hono/route';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { z } from 'zod';
import { createHash, timingSafeEqual } from 'node:crypto';
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
import { transact, transientDynamoError } from './repository';
import { assertDeviceMayRegister, assertInboxFree } from './signup-guard';
import { trackSignup } from './signup-tracking';
import { needsSecondStep, type AuthProvider, type Tokens } from './auth';
import type { Realtime } from './realtime';
import { PushRegistrations } from './push';
import { responseSchema, queryParameters } from './responses';
import { storageAudit } from './storage-audit';
import { Beta } from './beta';
import { featureFlagsFor, recordFlagUsage, type FeatureFlags, type UsageInput } from './flags';
import { AccessTokens, isAccessToken, toolVersion } from './access-tokens';
import {
  linkSubscription,
  setLinkProductUpdates,
  unsubscribeSubject,
  type EmailLinks,
} from './email-preferences';
import { usageDetails } from './usage-events';
import { E2ee, assertNotEncrypted, encryptedAccount, encryptingClient } from './e2ee';
import { PublicLinks, linkHash } from './public-links';
type Env = {
  Variables: {
    identity: c.Identity;
    requestId: string;
    timing?: Record<string, number>;
    /** The calling app's device, once the session is registered. */
    device?: c.Device;
    /** The error code a failed request answered with. */
    errorCode?: string;
    /** Sizes and counts of a usage request (an upload, a download, a backup run). */
    usage?: Record<string, unknown>;
    /** Set when the caller signed in with a personal access token rather than an app session. */
    accessToken?: { scope: c.AccessTokenScope };
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
/** Keeps signed URLs and local paths out of the logs if an app's error message carries one. */
export const redact = (message: string) =>
  message
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<url>')
    .replace(/(?:\b[A-Za-z]:)?(?:[\\/][^\\/\s'"]+){2,}/g, '<path>');
/** Routes that read or write files; apps that can't encrypt are kept off encrypted accounts. */
const fileRoute = (path: string) =>
  /^\/v1\/(drive|uploads|downloads|folder-downloads|sync|backups|search|transfers|shares|storage)(\/|$)/.test(
    path,
  );
/**
 * Routes a personal access token may call: My Drive, uploads and downloads, and reading the
 * account. Everything else (sign-in, account settings, sharing, devices, tokens themselves)
 * needs a signed-in app, so a leaked token cannot take over the account.
 */
const tokenRoute = (method: string, path: string) =>
  /^\/v1\/(drive|uploads|folder-downloads)(\/|$)/.test(path) ||
  ['/v1/downloads', '/v1/search'].includes(path) ||
  (path === '/v1/users/me' && method === 'get');
/** Read-only tokens may list and download; these are the downloads that are not GETs. */
const readOnlyPosts = new Set(['/v1/downloads', '/v1/folder-downloads']);
/** Requests a minute for one token, within the account's own limit. */
export const TOKEN_RATE_LIMIT = 300;
/** Files a day that token clients may upload to one account. */
export const TOKEN_DAILY_UPLOADS = 20_000;
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
  /** Where public link pages are served (harbor0content.online in production). */
  publicLinkOrigin = 'http://127.0.0.1:3400',
  /**
   * Sent by the link domain's CloudFront as X-Harbor-Edge. When set, public link routes refuse
   * requests without it, so they can't be called straight at API Gateway around CloudFront.
   */
  publicEdgeSecret?: string,
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
    // One line per request for the operations dashboard and the console's per-account
    // activity. The route is the matched pattern, never the concrete path, so no file or
    // folder ids reach the logs; the account and device are the caller's own ids.
    const matched = routePath(ctx, -1);
    const identity = ctx.get('identity');
    const device = ctx.get('device');
    console.log(
      JSON.stringify({
        event: 'request',
        requestId,
        method: ctx.req.method,
        route: matched === '/*' ? '(no route)' : matched,
        status: ctx.res.status,
        ms: Math.round(performance.now() - started),
        ...(identity ? { userId: identity.id } : {}),
        ...(identity?.deviceId ? { deviceId: identity.deviceId } : {}),
        ...(device ? { platform: device.platform, appVersion: device.appVersion } : {}),
        ...(ctx.get('errorCode') ? { code: ctx.get('errorCode') } : {}),
        ...(ctx.get('usage') ? { usage: ctx.get('usage') } : {}),
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
            ...(ctx.get('identity') ? { userId: ctx.get('identity').id } : {}),
          }),
        );
    }
    ctx.set('errorCode', e.code);
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
  async function dailyLimit(key: string, max: number) {
    const day = Math.floor(Date.now() / 86400_000);
    const k = createHash('sha256').update(key).digest('hex');
    assert(
      await service.repo.increment({ pk: 'RATE', sk: `${k}#d${day}` }, max, (day + 2) * 86400),
      'RATE_LIMITED',
      `Access tokens can upload up to ${max.toLocaleString('en')} files a day. Try again tomorrow.`,
      429,
    );
  }
  const tokens = new AccessTokens(service.repo);
  function route(d: Definition) {
    definitions.push(d);
    app.on(d.method.toUpperCase(), d.path, async (ctx) => {
      if (!d.public) {
        const token = bearer(ctx);
        assert(token, 'AUTH_REQUIRED', 'Sign in to continue.', 401);
        if (isAccessToken(token)) {
          assert(
            tokenRoute(d.method, d.path),
            'TOKEN_NOT_ALLOWED',
            'Access tokens can only use My Drive. Sign in to the app for this.',
            403,
          );
          const { identity, scope } = await tokens.identity(token);
          assert(
            scope === 'FULL' || d.method === 'get' || readOnlyPosts.has(d.path),
            'TOKEN_SCOPE',
            'This access token is read-only.',
            403,
          );
          ctx.set('identity', identity);
          ctx.set('accessToken', { scope });
          const checks = await Promise.allSettled([
            service.ensureUser(identity),
            service.checkDevice(identity.id, identity.deviceId!),
            rateLimit(`user:${identity.id}`, c.RATE_LIMIT),
            rateLimit(`pat:${identity.deviceId}`, TOKEN_RATE_LIMIT),
          ]);
          for (const check of checks) if (check.status === 'rejected') throw check.reason;
          if (checks[1].status === 'fulfilled') ctx.set('device', checks[1].value);
          // Tools such as rclone can't encrypt, so they'd read ciphertext and write plaintext.
          if (
            fileRoute(d.path) &&
            checks[0].status === 'fulfilled' &&
            encryptedAccount(checks[0].value)
          )
            throw new DomainError(
              'E2EE_UNSUPPORTED',
              "Access tokens can't be used with end-to-end encryption yet.",
              403,
            );
          if (d.method === 'post' && d.path === '/v1/uploads')
            await dailyLimit(`uploads:${identity.id}`, TOKEN_DAILY_UPLOADS);
          await tokens.touch(
            identity.id,
            identity.deviceId!,
            toolVersion(ctx.req.header('User-Agent')),
          );
        } else {
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
            timed(
              'rate',
              c.bulkTransferPath(d.path)
                ? rateLimit(`user-bulk:${identity.id}`, c.BULK_RATE_LIMIT)
                : rateLimit(`user:${identity.id}`, c.RATE_LIMIT),
            ),
          ]);
          for (const check of checks) if (check.status === 'rejected') throw check.reason;
          if (checks[1].status === 'fulfilled' && checks[1].value)
            ctx.set('device', checks[1].value);
          // An app that can't encrypt would upload plaintext or save ciphertext as the file.
          if (
            !registering &&
            fileRoute(d.path) &&
            checks[0].status === 'fulfilled' &&
            encryptedAccount(checks[0].value) &&
            !encryptingClient(ctx.get('device'))
          )
            throw new DomainError(
              'E2EE_UPDATE_REQUIRED',
              'Your account now uses end-to-end encryption. Update harbor0 to keep syncing; nothing was uploaded unencrypted.',
              426,
            );
        }
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
      const usage = usageDetails(d.method.toUpperCase(), d.path, input, result);
      if (usage) ctx.set('usage', usage);
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
        // The `?ref=` of the sign-up link this person came through.
        trackingId: c.signupTrackingId,
      })
      .strict(),
    anyObject,
    async (_, { deviceKey, trackingId, ...input }) => {
      const existing = await service.lookup(input.username);
      assert(existing.users.length === 0, 'USERNAME_TAKEN', 'This username is taken.', 409);
      await transact(service.repo, (tx) => assertInboxFree(tx, input.email));
      if (deviceKey) await assertDeviceMayRegister(service.repo, deviceKey);
      // Cognito's sign-up trigger takes the seat too, for sign-ups that skip this API.
      await beta.claim(input.email, input.inviteCode);
      const result = await auth.signup(input);
      await transact(service.repo, (tx) =>
        trackSignup(tx, input.email, trackingId, 'signedUpAt'),
      );
      return result;
    },
    true,
  );
  add(
    'post',
    '/v1/auth/request-access',
    'Email a beta sign-up link, or join the waitlist when the current wave is full',
    z.object({ email, trackingId: c.signupTrackingId }).strict(),
    c.accessRequestResultSchema,
    async (_, i) => {
      const result = await beta.request(i.email);
      if (result.status !== 'REGISTERED')
        await transact(service.repo, (tx) =>
          trackSignup(tx, i.email, i.trackingId, 'requestedAt'),
        );
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
  // End-to-end encryption. Turning it on is rolled out behind a flag; an account that has it
  // keeps unlocking, changing its keys and finishing its migration if the flag is taken off.
  const e2ee = new E2ee(service);
  const e2eeUsage = (ctx: Context<Env>, event: c.FlagUsageEvent<'e2ee'>) =>
    recordFlagUsage(service.repo, 'e2ee', event, {
      userId: ctx.get('identity').id,
      email: ctx.get('identity').email,
    });
  const e2eeResponse = z.object({ e2ee: c.e2eeStateSchema });
  add(
    'get',
    '/v1/e2ee',
    'End-to-end encryption: whether it is on, the wrapped keys and unlocked devices',
    undefined,
    e2eeResponse,
    async (ctx) => ({ e2ee: await e2ee.state(userId(ctx)) }),
  );
  add(
    'post',
    '/v1/e2ee/enroll',
    'Turn on end-to-end encryption for good with the wrapped master key',
    c.e2eeEnrollInput,
    e2eeResponse,
    flagged(flags, 'e2ee', async (ctx, i) => {
      const state = await e2ee.enroll(userId(ctx), i);
      await e2eeUsage(ctx, 'TURNED_ON');
      return { e2ee: state };
    }),
  );
  add(
    'put',
    '/v1/e2ee/passphrase',
    'Replace the passphrase-wrapped key; files are not re-encrypted',
    z.object({ passphrase: c.passphraseEnvelopeSchema, proof: c.keyProof }).strict(),
    e2eeResponse,
    async (ctx, i) => {
      const state = await e2ee.setPassphrase(userId(ctx), i);
      await e2eeUsage(ctx, 'PASSPHRASE_CHANGED');
      return { e2ee: state };
    },
  );
  add(
    'put',
    '/v1/e2ee/recovery',
    'Replace the recovery key; the old one stops working',
    z.object({ recovery: c.recoveryEnvelopeSchema, proof: c.keyProof }).strict(),
    e2eeResponse,
    async (ctx, i) => {
      const state = await e2ee.setRecovery(userId(ctx), i);
      await e2eeUsage(ctx, 'RECOVERY_KEY_CREATED');
      return { e2ee: state };
    },
  );
  add(
    'post',
    '/v1/e2ee/devices',
    'Keep a wrapped copy of the key on this device',
    c.e2eeDeviceInput,
    z.object({ id: z.string() }),
    async (ctx, i) => e2ee.addDevice(userId(ctx), ctx.get('device'), i),
  );
  add(
    'post',
    '/v1/e2ee/devices/:id/secret',
    "The server's half of an unlocked device's key",
    undefined,
    z.object({ serverSecret: z.string() }),
    async (ctx) => {
      await rateLimit(`e2ee-secret:${userId(ctx)}`, 60);
      return e2ee.deviceSecret(userId(ctx), z.string().uuid().parse(ctx.req.param('id')));
    },
  );
  add(
    'delete',
    '/v1/e2ee/devices/:id',
    'Remove an unlocked device; it needs the passphrase again',
    undefined,
    e2eeResponse,
    async (ctx) => ({
      e2ee: await e2ee.removeDevice(userId(ctx), z.string().uuid().parse(ctx.req.param('id'))),
    }),
  );
  add(
    'put',
    '/v1/e2ee/migration',
    'Report progress re-encrypting files stored before encryption was on',
    c.e2eeMigrationInput,
    e2eeResponse,
    async (ctx, i) => {
      const { finished, state } = await e2ee.setMigration(userId(ctx), ctx.get('device'), i);
      if (finished) await e2eeUsage(ctx, 'MIGRATION_COMPLETE');
      return { e2ee: state };
    },
  );
  add(
    'post',
    '/v1/e2ee/items/:id/purge-plaintext',
    'Delete the unencrypted versions of a file once its encrypted copy is uploaded',
    undefined,
    z.object({ removed: z.number(), retained: z.number() }),
    async (ctx) => {
      const result = await e2ee.purgePlaintext(userId(ctx), p(ctx, 'id'));
      if (result.removed) await wakeWorker();
      return result;
    },
  );
  add(
    'get',
    '/v1/e2ee/leftovers',
    'Files with versions left from an interrupted encrypt or decrypt, to finish them',
    undefined,
    z.object({
      plaintextVersions: z.array(z.string()),
      encryptedVersions: z.array(z.string()),
      encryptedItems: z.number(),
    }),
    async (ctx) => e2ee.leftovers(userId(ctx)),
  );
  add(
    'post',
    '/v1/e2ee/items/:id/purge-encrypted',
    'While turning off: delete the encrypted versions of a file once its decrypted copy is uploaded',
    undefined,
    z.object({ removed: z.number(), retained: z.number() }),
    async (ctx) => {
      const result = await e2ee.purgeEncrypted(userId(ctx), p(ctx, 'id'));
      if (result.removed) await wakeWorker();
      return result;
    },
  );
  add(
    'post',
    '/v1/e2ee/items/:id/name',
    'While turning off: give a backed up item its decrypted name, from any device',
    z
      .object({
        operationId: c.operationId,
        baseRevision: z.number().int().positive(),
        name: c.filename,
      })
      .strict(),
    z.object({ item: c.itemSchema }),
    async (ctx, i) => service.renameInBackup(userId(ctx), p(ctx, 'id'), i),
  );
  // Turning off works whether or not the flag is on, like the account's other key changes.
  add(
    'post',
    '/v1/e2ee/disable',
    'Start turning off end-to-end encryption; devices then decrypt what is stored',
    c.e2eeProofInput,
    e2eeResponse,
    async (ctx, i) => {
      const state = await e2ee.startDisable(userId(ctx), i.proof);
      await e2eeUsage(ctx, 'TURN_OFF_STARTED');
      return { e2ee: state };
    },
  );
  add(
    'put',
    '/v1/e2ee/decryption',
    'Report progress decrypting files while turning off end-to-end encryption',
    c.e2eeMigrationInput,
    e2eeResponse,
    async (ctx, i) => ({
      e2ee: (await e2ee.setMigration(userId(ctx), ctx.get('device'), i, 'decryption')).state,
    }),
  );
  add(
    'post',
    '/v1/e2ee/disable/finish',
    'Finish turning off once nothing is encrypted: delete the keys and device copies',
    c.e2eeProofInput,
    e2eeResponse,
    async (ctx, i) => {
      const state = await e2ee.finishDisable(userId(ctx), i.proof);
      await e2eeUsage(ctx, 'TURNED_OFF');
      return { e2ee: state };
    },
  );
  /** Refuses features that need the server to read an encrypted account's files. */
  const notEncrypted = async (ctx: Context<Env>, what: string) =>
    assertNotEncrypted((await service.me(userId(ctx))).user, what);
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
    'get',
    '/v1/drive/folders/:id/lookup',
    'Find the item with a name in a folder, compared the way names are kept unique',
    undefined,
    z.object({ item: c.itemSchema }),
    async (ctx) =>
      service.findChild(
        userId(ctx),
        p(ctx, 'id') === 'root' ? null : p(ctx, 'id'),
        c.filename.parse(ctx.req.query('name')),
      ),
  );
  add(
    'patch',
    '/v1/drive/items/:id/modified',
    "Set a file's modification time without changing its content or revision",
    z.object({ baseRevision: z.number().int().positive(), modifiedAt: z.iso.datetime() }).strict(),
    z.object({ item: c.itemSchema }),
    async (ctx, i) => service.setModified(userId(ctx), p(ctx, 'id'), i),
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
    'Move an item, renaming it on the way when a name is given',
    c.mutation.extend({ parentId: c.id.nullable(), name: c.filename.optional() }).strict(),
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
    '/v1/client-events',
    'Report problems the app saw outside the API',
    c.clientEventsBody,
    z.object({ accepted: z.number() }),
    async (ctx, i: z.infer<typeof c.clientEventsBody>) => {
      const identity = ctx.get('identity');
      const device = ctx.get('device');
      // Each event is one log line under the account, like a request, and nothing is stored.
      for (const event of i.events)
        console.log(
          JSON.stringify({
            event: 'client_error',
            requestId: ctx.get('requestId'),
            userId: identity.id,
            deviceId: identity.deviceId,
            ...(device ? { platform: device.platform, appVersion: device.appVersion } : {}),
            ...event,
            ...(event.message ? { message: redact(event.message) } : {}),
          }),
        );
      return { accepted: i.events.length };
    },
  );
  add(
    'post',
    '/v1/uploads',
    'Reserve quota and create upload',
    c.uploadInput,
    anyObject,
    async (ctx, i) => service.createUpload(userId(ctx), i, ctx.get('identity').deviceId),
  );
  // A batch stops starting files after this long, inside the API's 29 s limit; the files it did
  // not reach come back as BATCH_NOT_REACHED and the device sends them again.
  const BATCH_DEADLINE_MS = 18_000;
  const batchError = (error: unknown) => {
    // The database busy for a moment: this file goes again rather than failing the whole batch,
    // which would leave the files already saved in it unreported.
    if (transientDynamoError(error)) return notReached;
    if (!(error instanceof DomainError)) throw error;
    return {
      error: { code: error.code, message: error.message, details: error.details },
    };
  };
  const notReached = {
    error: { code: 'BATCH_NOT_REACHED', message: 'Not reached in this batch. Send it again.' },
  };
  // A reserved upload started in storage, with the URL its one part goes to.
  const openBatched = async (
    ctx: Context<Env>,
    result: Awaited<ReturnType<typeof service.reserveUpload>> | { error: unknown },
  ) => {
    if (!('upload' in result)) return result;
    try {
      const upload = await service.openUpload(userId(ctx), result.upload.id);
      return { upload: service.publicUpload(upload), uploadUrl: await service.firstPartUrl(upload) };
    } catch (error) {
      return batchError(error);
    }
  };
  // Finishing in storage touches only each upload's own record, so it runs at once; adding the
  // files moves room on the account, so that is one at a time.
  const prepareBatched = (
    ctx: Context<Env>,
    files: { uploadId: string; etag: string; contentHash: string }[],
  ) =>
    Promise.all(
      files.map((file) =>
        service
          .prepareFinish(
            userId(ctx),
            file.uploadId,
            [{ partNumber: 1, etag: file.etag }],
            file.contentHash,
          )
          .catch(batchError),
      ),
    );
  // Several small files at once, as a backup run sends them (see the backup batch routes): each
  // reserved one at a time, then started in storage together.
  add(
    'post',
    '/v1/uploads/batch',
    'Create several small uploads at once: each gets an upload and one storage part URL',
    z
      .object({
        uploads: z
          .array(c.uploadInput.refine((u) => u.sizeBytes <= c.BATCH_UPLOAD_MAX_BYTES))
          .min(1)
          .max(c.BATCH_UPLOAD_FILES),
      })
      .strict(),
    z.object({ results: z.array(anyObject) }),
    async (ctx, i) => {
      const deviceId = ctx.get('identity').deviceId;
      const started = Date.now();
      const reserved = [];
      for (const input of i.uploads) {
        if (Date.now() - started > BATCH_DEADLINE_MS) {
          reserved.push(notReached);
          continue;
        }
        try {
          reserved.push(await service.reserveUpload(userId(ctx), input, deviceId));
        } catch (error) {
          reserved.push(batchError(error));
        }
      }
      return { results: await Promise.all(reserved.map((result) => openBatched(ctx, result))) };
    },
  );
  add(
    'post',
    '/v1/uploads/batch/finish',
    'Finish several small uploads at once',
    z
      .object({
        files: z
          .array(
            z
              .object({ uploadId: c.id, etag: z.string().min(1).max(256), contentHash: c.hash })
              .strict(),
          )
          .min(1)
          .max(c.BATCH_UPLOAD_FILES),
      })
      .strict(),
    z.object({ results: z.array(anyObject) }),
    async (ctx, i) => {
      const started = Date.now();
      const prepared = await prepareBatched(ctx, i.files);
      const results = [];
      for (const [index, file] of i.files.entries()) {
        const ready = prepared[index];
        if ('error' in ready) {
          results.push(ready);
          continue;
        }
        if (Date.now() - started > BATCH_DEADLINE_MS) {
          results.push(notReached);
          continue;
        }
        try {
          const { item } =
            'item' in ready
              ? ready
              : await service.commitFinish(userId(ctx), file.uploadId, file.contentHash, ready.object);
          results.push({ item: await service.viewed(userId(ctx), item) });
        } catch (error) {
          results.push(batchError(error));
        }
      }
      return { results };
    },
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
      await notEncrypted(ctx, 'Downloading folders as a ZIP from the server');
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
      /** The stored bytes are encrypted; sizeBytes and contentHash describe them as stored. */
      encrypted: z.boolean().optional(),
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
    async (ctx, i) => {
      await notEncrypted(ctx, 'Sending files');
      return service.createTransfer(userId(ctx), i);
    },
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
    async (ctx, i) => {
      await notEncrypted(ctx, 'Saving received files to My Drive');
      return service.saveTransfer(userId(ctx), p(ctx, 'id'), i);
    },
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
    async (ctx, i) => {
      await notEncrypted(ctx, 'Sharing folders');
      return service.createShare(userId(ctx), i);
    },
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
  add(
    'get',
    '/v1/tokens',
    'List personal access tokens that still work',
    undefined,
    z.object({ items: z.array(c.accessTokenSchema) }),
    async (ctx) => ({ items: await tokens.list(userId(ctx)) }),
  );
  add(
    'post',
    '/v1/tokens',
    'Create a personal access token for rclone and other tools; the token is returned only here',
    c.accessTokenInput,
    z.object({ token: z.string(), item: c.accessTokenSchema }),
    async (ctx, i) => {
      // `harbor0 webdav` makes a token of its own, so the WebDAV flag allows one too.
      const device = ctx.get('device');
      assert(
        (await flags.enabled('rclone', userId(ctx), device)) ||
          (await flags.enabled('webdav', userId(ctx), device)),
        'FEATURE_UNAVAILABLE',
        "This feature isn't available on your account yet.",
        403,
      );
      await notEncrypted(ctx, 'Access tokens');
      const created = await tokens.create(userId(ctx), i);
      await recordFlagUsage(service.repo, 'rclone', 'TOKEN_CREATED', {
        userId: userId(ctx),
        email: ctx.get('identity').email,
        details: { scope: i.scope, expiresInDays: i.expiresInDays },
      });
      return created;
    },
  );
  add(
    'delete',
    '/v1/tokens/:id',
    'Revoke a personal access token and remove its device',
    undefined,
    z.object({ revoked: z.boolean() }),
    async (ctx) => {
      await tokens.revoke(userId(ctx), p(ctx, 'id'));
      await recordFlagUsage(service.repo, 'rclone', 'TOKEN_REVOKED', {
        userId: userId(ctx),
        email: ctx.get('identity').email,
      });
      return { revoked: true };
    },
  );
  // Public links: the owner's routes, then the routes anyone with a link calls, which the
  // link pages on their own domain reach through that domain's /api/v1/public/* path.
  const publicLinks = new PublicLinks(service, publicLinkOrigin);
  add(
    'get',
    '/v1/links/allowance',
    'Whether this account can make public links now, and how many it has',
    undefined,
    c.publicLinkAllowanceSchema,
    flagged(flags, 'public-links', async (ctx) => publicLinks.allowance(userId(ctx))),
  );
  add(
    'get',
    '/v1/links',
    'List public links that still work, optionally only one item\'s',
    undefined,
    z.object({ items: z.array(c.publicLinkSchema) }),
    // Not flagged: links made before the flag was taken off can still be found and turned off.
    async (ctx) => ({
      items: await publicLinks.list(
        userId(ctx),
        c.id.optional().parse(ctx.req.query('driveItemId') || undefined),
      ),
    }),
  );
  add(
    'post',
    '/v1/links',
    'Make a public link to a file or folder that anyone with it can open',
    c.publicLinkInput,
    z.object({ link: c.publicLinkSchema }),
    flagged(flags, 'public-links', async (ctx, i) => {
      const created = await publicLinks.create(userId(ctx), i);
      await recordFlagUsage(service.repo, 'public-links', 'LINK_CREATED', {
        userId: userId(ctx),
        email: ctx.get('identity').email,
        details: {
          itemType: created.link.itemType,
          expiresInDays: i.expiresInDays,
          password: !!i.password,
        },
      });
      return created;
    }),
  );
  add(
    'patch',
    '/v1/links/:id',
    'Change when a public link ends, or its password',
    c.publicLinkUpdate,
    z.object({ link: c.publicLinkSchema }),
    flagged(flags, 'public-links', async (ctx, i) =>
      publicLinks.update(userId(ctx), p(ctx, 'id'), i),
    ),
  );
  add(
    'delete',
    '/v1/links/:id',
    'Turn off a public link',
    undefined,
    z.object({ revoked: z.boolean() }),
    async (ctx) => {
      await publicLinks.revoke(userId(ctx), p(ctx, 'id'));
      await recordFlagUsage(service.repo, 'public-links', 'LINK_REVOKED', {
        userId: userId(ctx),
        email: ctx.get('identity').email,
      });
      return { revoked: true };
    },
  );
  /**
   * The visitor's address: CloudFront-Viewer-Address ("ip:port"), which the link domain's
   * CloudFront sets. With the edge secret checked, no request reaches here without passing it.
   */
  const visitor = (ctx: Context<Env>) =>
    ctx.req.header('CloudFront-Viewer-Address')?.replace(/:\d+$/, '') ??
    ctx.req.header('X-Forwarded-For')?.split(',')[0]?.trim() ??
    'unknown';
  const edgeSecret = publicEdgeSecret ? Buffer.from(publicEdgeSecret) : undefined;
  const fromEdge = (ctx: Context<Env>) => {
    if (!edgeSecret) return true;
    const sent = Buffer.from(ctx.req.header('X-Harbor-Edge') ?? '');
    return sent.length === edgeSecret.length && timingSafeEqual(sent, edgeSecret);
  };
  /**
   * A visitor's link token. Requests that didn't come through CloudFront and codes that match no
   * link are answered after at most one read; only real links count against the per-link and
   * per-visitor limits, so a flood of made-up codes writes nothing.
   */
  const publicLink = async (ctx: Context<Env>) => {
    const token = c.publicLinkToken.safeParse(ctx.req.param('token'));
    assert(
      token.success && fromEdge(ctx) && (await publicLinks.exists(token.data)),
      'LINK_NOT_FOUND',
      "This link doesn't work. It may have been turned off, or what it shared was removed.",
      404,
    );
    await Promise.all([
      rateLimit(`public-link:${linkHash(token.data)}`, c.PUBLIC_LINK_RATE.link),
      rateLimit(`public-visitor:${visitor(ctx)}`, c.PUBLIC_LINK_RATE.visitor),
    ]);
    return { token: token.data, pass: ctx.req.header(c.PUBLIC_LINK_PASS_HEADER) || undefined };
  };
  add(
    'get',
    '/v1/public/links/:token',
    'Open a public link: who shared it and what, unless it needs a password first',
    undefined,
    c.publicLinkViewSchema,
    async (ctx) => {
      const { token, pass } = await publicLink(ctx);
      return publicLinks.open(token, pass);
    },
    true,
  );
  add(
    'post',
    '/v1/public/links/:token/unlock',
    "Check a public link's password; send the pass it returns in X-Harbor-Link-Pass",
    z.object({ password: z.string().min(1).max(128) }).strict(),
    z.object({ pass: z.string() }),
    async (ctx, i) => {
      const { token } = await publicLink(ctx);
      const hour = Math.floor(Date.now() / 3600_000);
      const key = createHash('sha256')
        .update(`public-link-password:${linkHash(token)}:${visitor(ctx)}`)
        .digest('hex');
      assert(
        await service.repo.increment(
          { pk: 'RATE', sk: `${key}#h${hour}` },
          c.PUBLIC_LINK_PASSWORD_ATTEMPTS,
          (hour + 2) * 3600,
        ),
        'RATE_LIMITED',
        'Too many tries. Wait an hour and try again.',
        429,
      );
      return publicLinks.unlock(token, i.password);
    },
    true,
  );
  add(
    'get',
    '/v1/public/links/:token/items',
    "List a folder in a public folder link: the linked folder unless folderId says which",
    undefined,
    c.publicFolderPageSchema,
    async (ctx) => {
      const { token, pass } = await publicLink(ctx);
      const q = z
        .object({ folderId: c.id.optional(), cursor: z.string().max(4096).optional() })
        .parse(ctx.req.query());
      return publicLinks.folder(token, pass, q.folderId, q.cursor);
    },
    true,
  );
  add(
    'post',
    '/v1/public/links/:token/download',
    'A short-lived download address for the linked file, or a file in the linked folder',
    z.object({ itemId: c.id.optional() }).strict(),
    z.object({
      downloadUrl: z.string(),
      expiresAt: z.string(),
      name: z.string(),
      sizeBytes: z.number(),
    }),
    async (ctx, i) => {
      const { token, pass } = await publicLink(ctx);
      return publicLinks.download(token, pass, i.itemId);
    },
    true,
  );
  const syncSharing = new SyncSharing(service);
  add(
    'post',
    '/v1/sync/shares',
    'Invite another account to two-way folder sync',
    z.object({ operationId: c.operationId, driveItemId: c.id, recipient: c.recipient }).strict(),
    z.object({ share: c.shareSchema }),
    async (ctx, input) => {
      await notEncrypted(ctx, 'Shared sync');
      return syncSharing.invite(userId(ctx), input);
    },
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
  // Many copies at once, as a desktop confirms a folder it just synced.
  add(
    'post',
    '/v1/sync/items/acknowledge',
    'Confirm several verified local copies at once',
    z
      .object({
        items: z
          .array(
            z
              .object({
                itemId: c.id,
                versionId: c.id.nullable(),
                revision: z.number().int().positive(),
                contentHash: c.hash.nullable(),
              })
              .strict(),
          )
          .min(1)
          .max(c.SYNC_ACKNOWLEDGE_ITEMS),
      })
      .strict(),
    z.object({ results: z.array(anyObject) }),
    async (ctx, i) => {
      const deviceId = ctx.get('identity').deviceId;
      assert(deviceId, 'FORBIDDEN', 'A registered device is required.', 403);
      const relay = new SyncRelay(service);
      const started = Date.now();
      const results = [];
      for (const { itemId, ...input } of i.items as {
        itemId: string;
        versionId: string | null;
        revision: number;
        contentHash: string | null;
      }[]) {
        if (Date.now() - started > BATCH_DEADLINE_MS) {
          results.push(notReached);
          continue;
        }
        try {
          results.push(await relay.acknowledge(userId(ctx), deviceId, itemId, input));
        } catch (error) {
          results.push(batchError(error));
        }
      }
      return { results };
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
    '/v1/backups/:id/runs/:runId/items/:itemId/name',
    'Switch a backed up name between its plain and encrypted forms',
    z
      .object({
        operationId: c.operationId,
        baseRevision: z.number().int().positive(),
        name: c.filename,
      })
      .strict(),
    z.object({ item: c.itemSchema }),
    async (ctx, i) =>
      service.renameInBackup(userId(ctx), p(ctx, 'itemId'), i, {
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
  add(
    'post',
    '/v1/backups/:id/runs/:runId/uploads/batch',
    'Append several small backup files at once: each gets an upload and one storage part URL',
    z
      .object({
        uploads: z
          .array(c.uploadInput.refine((u) => u.sizeBytes <= c.BATCH_UPLOAD_MAX_BYTES))
          .min(1)
          .max(c.BATCH_UPLOAD_FILES),
      })
      .strict(),
    z.object({ results: z.array(anyObject) }),
    async (ctx, i) => {
      const write = { rootId: p(ctx, 'id'), runId: p(ctx, 'runId'), deviceId: backupDevice(ctx) };
      const started = Date.now();
      // Reserved one at a time: each takes room on the account, which parallel requests would
      // only contend for. Starting them in storage touches nothing shared, so that runs at once.
      const reserved = [];
      for (const input of i.uploads) {
        if (Date.now() - started > BATCH_DEADLINE_MS) {
          reserved.push(notReached);
          continue;
        }
        try {
          reserved.push(await service.reserveUpload(userId(ctx), input, write.deviceId, write));
        } catch (error) {
          reserved.push(batchError(error));
        }
      }
      const results = await Promise.all(reserved.map((result) => openBatched(ctx, result)));
      return { results };
    },
  );
  add(
    'post',
    '/v1/backups/:id/runs/:runId/files/batch',
    'Finish several small backup uploads and record them in the run at once',
    z
      .object({
        files: z
          .array(
            z
              .object({
                uploadId: c.id,
                etag: z.string().min(1).max(256),
                contentHash: c.hash,
                relativePath: z.string().min(1).max(4096),
                modifiedAt: z.string(),
                savedAt: z.string(),
              })
              .strict(),
          )
          .min(1)
          .max(c.BATCH_UPLOAD_FILES),
      })
      .strict(),
    z.object({ results: z.array(anyObject) }),
    async (ctx, i) => {
      const [rootId, runId, deviceId] = [p(ctx, 'id'), p(ctx, 'runId'), backupDevice(ctx)];
      const started = Date.now();
      const prepared = await prepareBatched(ctx, i.files);
      const results = [];
      for (const [index, file] of i.files.entries()) {
        const ready = prepared[index];
        if ('error' in ready) {
          results.push(ready);
          continue;
        }
        // Not reached: finished in storage, so sending it again only adds the file.
        if (Date.now() - started > BATCH_DEADLINE_MS) {
          results.push(notReached);
          continue;
        }
        try {
          const { item } =
            'item' in ready
              ? ready
              : await service.commitFinish(
                  userId(ctx),
                  file.uploadId,
                  file.contentHash,
                  ready.object,
                );
          const entry = {
            relativePath: file.relativePath,
            itemId: item.id,
            versionId: item.currentVersionId!,
            sizeBytes: item.sizeBytes,
            modifiedAt: file.modifiedAt,
            savedAt: file.savedAt,
          };
          await backupWorkflows.entry(userId(ctx), rootId, deviceId, runId, entry);
          results.push({ item, entry });
        } catch (error) {
          results.push(batchError(error));
        }
      }
      return { results };
    },
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
    z
      .object({
        id: c.id,
        trigger: z.enum(['AUTOMATIC', 'MANUAL']),
        plannedFileCount: z.number().int().nonnegative().optional(),
        plannedSizeBytes: z.number().int().nonnegative().optional(),
      })
      .strict(),
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
    'Restore a backup version, or a folder with each file at its latest version, to its local folder',
    z.object({ id: c.id, itemId: c.id, versionId: c.id.optional() }).strict(),
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
