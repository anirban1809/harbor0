import {
  CognitoIdentityProviderClient,
  SignUpCommand,
  ConfirmSignUpCommand,
  ResendConfirmationCodeCommand,
  InitiateAuthCommand,
  GetUserCommand,
  DeleteUserCommand,
  GetTokensFromRefreshTokenCommand,
  RevokeTokenCommand,
  ForgotPasswordCommand,
  ConfirmForgotPasswordCommand,
  RespondToAuthChallengeCommand,
  AssociateSoftwareTokenCommand,
  VerifySoftwareTokenCommand,
  SetUserMFAPreferenceCommand,
  AdminGetUserCommand,
  AdminSetUserMFAPreferenceCommand,
  type ChallengeNameType,
  type AuthenticationResultType,
} from '@aws-sdk/client-cognito-identity-provider';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import type {
  Identity,
  TotpSetup,
  TwoFactorChallenge,
  TwoFactorMethod,
  TwoFactorStatus,
} from '@harbor/contracts';
import { assert, DomainError } from './errors';
export type Tokens = { accessToken: string; refreshToken: string; expiresIn: number };
/** A password sign-in either finishes or waits for the account's second step. */
export type SignIn = Tokens | { challenge: TwoFactorChallenge };
export const needsSecondStep = (r: SignIn): r is { challenge: TwoFactorChallenge } =>
  'challenge' in r;
export interface AuthProvider {
  identity(token: string): Promise<Identity>;
  signup(input: {
    email: string;
    password: string;
    username: string;
    displayName: string;
    inviteCode?: string;
  }): Promise<unknown>;
  confirm(email: string, code: string): Promise<unknown>;
  resend(email: string): Promise<unknown>;
  login(email: string, password: string): Promise<SignIn>;
  /** Picks the second step when the account has more than one; an email code is sent now. */
  chooseSecondStep(
    email: string,
    session: string,
    method: TwoFactorMethod,
  ): Promise<TwoFactorChallenge>;
  /** Finishes a sign-in with the second step's code. */
  verifySecondStep(
    email: string,
    session: string,
    method: TwoFactorMethod,
    code: string,
  ): Promise<Tokens>;
  twoFactorStatus(accessToken: string): Promise<TwoFactorStatus>;
  /** Starts adding an authenticator app; it is on once `confirmTotp` accepts its first code. */
  setupTotp(accessToken: string, email: string): Promise<TotpSetup>;
  confirmTotp(accessToken: string, code: string): Promise<void>;
  /** An account has one second step at most: turning one on turns the other off. */
  setTwoFactor(accessToken: string, method: TwoFactorMethod, enabled: boolean): Promise<void>;
  refresh(refreshToken: string): Promise<Tokens>;
  logout(refreshToken: string): Promise<void>;
  deleteUser(accessToken: string): Promise<void>;
  forgot(email: string): Promise<unknown>;
  reset(email: string, code: string, password: string): Promise<unknown>;
}
// Cognito's GetUser is a network call on every request. A warm Lambda reuses its answer
// for a short time; the token signature and expiry are still verified on every request,
// and device revocation (sign-out, removed devices) is checked in DynamoDB on every request.
const IDENTITY_CACHE_MS = 60_000;
const cognitoMethod = { TOTP: 'SOFTWARE_TOKEN_MFA', EMAIL: 'EMAIL_OTP' } as const;
const methodOf = (name: string): TwoFactorMethod | undefined =>
  name === 'SOFTWARE_TOKEN_MFA' ? 'TOTP' : name === 'EMAIL_OTP' ? 'EMAIL' : undefined;
/**
 * The session handed to clients names the step Cognito waits for, so a code sent while the
 * account still has to choose a method can pick it first. `SELECT:` waits for a choice.
 */
const encodeSession = (step: TwoFactorMethod | 'SELECT', session: string) => `${step}:${session}`;
const decodeSession = (value: string) => {
  const at = value.indexOf(':');
  const step = value.slice(0, at);
  assert(
    at > 0 && ['SELECT', 'TOTP', 'EMAIL'].includes(step),
    'AUTH_EXPIRED',
    'This sign-in expired. Enter your password again.',
    400,
  );
  return { step: step as TwoFactorMethod | 'SELECT', session: value.slice(at + 1) };
};
const signInExpired = () =>
  new DomainError('AUTH_EXPIRED', 'This sign-in expired. Enter your password again.', 400);
const wrongCode = (session: string) =>
  new DomainError('AUTH_INVALID', 'That code didn’t match. Try again.', 400, { session });
const name = (error: unknown) => (error as { name?: string }).name;
/** Staff suspend an account by disabling its sign-in; say so instead of "wrong password". */
const suspended = () =>
  new DomainError(
    'ACCOUNT_SUSPENDED',
    'This account is suspended. Write to contact@harbor0.com to find out more.',
    403,
  );
/**
 * Cognito refuses to send a password-reset code to the address that also receives the
 * account's sign-in codes. Email sign-in codes are switched off just long enough to send the
 * reset code and then restored, so the next sign-in still asks for the second step.
 */
export async function withEmailCodesLifted<T>(
  client: CognitoIdentityProviderClient,
  poolId: string,
  username: string,
  work: () => Promise<T>,
): Promise<T> {
  let user;
  try {
    user = await client.send(new AdminGetUserCommand({ UserPoolId: poolId, Username: username }));
  } catch (error) {
    // Unknown accounts get Cognito's usual answer, which does not reveal that they don't exist.
    if (name(error) === 'UserNotFoundException') return work();
    throw error;
  }
  if (!user.UserMFASettingList?.includes('EMAIL_OTP')) return work();
  const preferred = user.PreferredMfaSetting === 'EMAIL_OTP';
  const set = (enabled: boolean) =>
    client.send(
      new AdminSetUserMFAPreferenceCommand({
        UserPoolId: poolId,
        Username: username,
        EmailMfaSettings: { Enabled: enabled, PreferredMfa: enabled && preferred },
      }),
    );
  await set(false);
  try {
    return await work();
  } finally {
    await set(true).catch((error) => {
      console.error(
        JSON.stringify({ event: 'email_codes_not_restored', error: name(error) ?? 'unknown' }),
      );
      throw error;
    });
  }
}
const IDENTITY_CACHE_SIZE = 1000;
export class CognitoAuth implements AuthProvider {
  private client = new CognitoIdentityProviderClient({});
  private verifier;
  private identities = new Map<string, { identity: Identity; until: number }>();
  constructor(
    private poolId: string,
    private clientId: string,
  ) {
    this.verifier = CognitoJwtVerifier.create({ userPoolId: poolId, clientId, tokenUse: 'access' });
  }
  async identity(token: string): Promise<Identity> {
    try {
      const jwt = await this.verifier.verify(token);
      const cached = this.identities.get(token);
      if (cached && cached.until > Date.now()) return cached.identity;
      this.identities.delete(token);
      const response = await this.client.send(new GetUserCommand({ AccessToken: token }));
      const attrs = Object.fromEntries(
        (response.UserAttributes ?? []).map((a) => [a.Name!, a.Value!]),
      );
      assert(
        typeof jwt.origin_jti === 'string',
        'AUTH_INVALID',
        'Token revocation must be enabled on the Cognito client.',
        401,
      );
      const identity: Identity = {
        id: jwt.sub,
        email: attrs.email,
        emailVerified: attrs.email_verified === 'true',
        username: attrs.preferred_username,
        displayName: attrs.name ?? attrs.preferred_username,
        deviceId: jwt.origin_jti,
        sessionId: jwt.origin_jti,
      };
      // An unverified account is not cached, so verifying the email takes effect at once.
      if (identity.emailVerified) {
        if (this.identities.size >= IDENTITY_CACHE_SIZE)
          this.identities.delete(this.identities.keys().next().value!);
        this.identities.set(token, {
          identity,
          until: Math.min(Date.now() + IDENTITY_CACHE_MS, jwt.exp * 1000),
        });
      }
      return identity;
    } catch (e) {
      if (e instanceof DomainError) throw e;
      throw new DomainError(
        'AUTH_INVALID',
        'Your session expired or was revoked. Sign in again.',
        401,
      );
    }
  }
  async signup(input: {
    email: string;
    password: string;
    username: string;
    displayName: string;
    inviteCode?: string;
  }) {
    await this.client.send(
      new SignUpCommand({
        ClientId: this.clientId,
        // The sign-up trigger takes the beta seat this code holds.
        ClientMetadata: input.inviteCode ? { inviteCode: input.inviteCode } : undefined,
        Username: input.email.toLowerCase(),
        Password: input.password,
        UserAttributes: [
          { Name: 'email', Value: input.email.toLowerCase() },
          { Name: 'preferred_username', Value: input.username },
          { Name: 'name', Value: input.displayName },
        ],
      }),
    );
    return { verificationRequired: true };
  }
  async confirm(email: string, code: string) {
    await this.client.send(
      new ConfirmSignUpCommand({
        ClientId: this.clientId,
        Username: email.toLowerCase(),
        ConfirmationCode: code,
      }),
    );
    return { verified: true };
  }
  async resend(email: string) {
    await this.client.send(
      new ResendConfirmationCodeCommand({ ClientId: this.clientId, Username: email.toLowerCase() }),
    );
    return { sent: true };
  }
  private tokens(result: AuthenticationResultType | undefined): Tokens {
    assert(
      result?.AccessToken && result.RefreshToken,
      'AUTH_CHALLENGE_REQUIRED',
      'Sign-in could not be completed. Start again.',
      401,
    );
    return {
      accessToken: result.AccessToken,
      refreshToken: result.RefreshToken,
      expiresIn: result.ExpiresIn ?? 900,
    };
  }
  private challenge(r: {
    ChallengeName?: ChallengeNameType;
    ChallengeParameters?: Record<string, string>;
    Session?: string;
  }): TwoFactorChallenge {
    assert(r.Session, 'AUTH_EXPIRED', 'This sign-in expired. Enter your password again.', 400);
    if (r.ChallengeName === 'SELECT_MFA_TYPE') {
      let offered: unknown = [];
      try {
        offered = JSON.parse(r.ChallengeParameters?.MFAS_CAN_CHOOSE ?? '[]');
      } catch {
        /* treated as nothing offered */
      }
      const methods = (Array.isArray(offered) ? offered : [])
        .map((m) => methodOf(String(m)))
        .filter((m): m is TwoFactorMethod => !!m);
      assert(
        methods.length,
        'AUTH_CHALLENGE_UNSUPPORTED',
        'This sign-in step is not supported.',
        401,
      );
      // Authenticator codes first: they need no email round trip.
      methods.sort((a, b) => Number(b === 'TOTP') - Number(a === 'TOTP'));
      return { session: encodeSession('SELECT', r.Session), methods, method: null };
    }
    const method = methodOf(r.ChallengeName ?? '');
    assert(
      method,
      'AUTH_CHALLENGE_UNSUPPORTED',
      'This account needs a sign-in step harbor0 does not support.',
      401,
    );
    return {
      session: encodeSession(method, r.Session),
      methods: [method],
      method,
      ...(method === 'EMAIL' && r.ChallengeParameters?.CODE_DELIVERY_DESTINATION
        ? { destination: r.ChallengeParameters.CODE_DELIVERY_DESTINATION }
        : {}),
    };
  }
  async login(email: string, password: string): Promise<SignIn> {
    const r = await this.client
      .send(
        new InitiateAuthCommand({
          ClientId: this.clientId,
          AuthFlow: 'USER_PASSWORD_AUTH',
          AuthParameters: { USERNAME: email.toLowerCase(), PASSWORD: password },
        }),
      )
      .catch((error: unknown) => {
        // Cognito answers a disabled user with this exact message.
        if (name(error) === 'NotAuthorizedException' && /user is disabled/i.test((error as Error).message))
          throw suspended();
        throw error;
      });
    if (r.ChallengeName) return { challenge: this.challenge(r) };
    return this.tokens(r.AuthenticationResult);
  }
  /** Cognito answers an expired or used-up session with NotAuthorizedException. */
  private async respond(input: {
    email: string;
    session: string;
    name: ChallengeNameType;
    responses: Record<string, string>;
  }) {
    try {
      return await this.client.send(
        new RespondToAuthChallengeCommand({
          ClientId: this.clientId,
          ChallengeName: input.name,
          Session: input.session,
          ChallengeResponses: { USERNAME: input.email.toLowerCase(), ...input.responses },
        }),
      );
    } catch (error) {
      if (name(error) === 'NotAuthorizedException') throw signInExpired();
      throw error;
    }
  }
  async chooseSecondStep(email: string, session: string, method: TwoFactorMethod) {
    const current = decodeSession(session);
    assert(
      current.step === 'SELECT',
      'VALIDATION_ERROR',
      'This sign-in already has a method. Enter your password again to choose another.',
    );
    const r = await this.respond({
      email,
      session: current.session,
      name: 'SELECT_MFA_TYPE',
      responses: { ANSWER: cognitoMethod[method] },
    });
    return this.challenge(r);
  }
  async verifySecondStep(email: string, session: string, method: TwoFactorMethod, code: string) {
    let current = decodeSession(session);
    if (current.step === 'SELECT') {
      // An emailed code only exists once the email method was chosen.
      assert(method === 'TOTP', 'VALIDATION_ERROR', 'Ask for an email code first.');
      const chosen = this.challenge(
        await this.respond({
          email,
          session: current.session,
          name: 'SELECT_MFA_TYPE',
          responses: { ANSWER: cognitoMethod.TOTP },
        }),
      );
      current = decodeSession(chosen.session);
    }
    assert(
      current.step === method,
      'VALIDATION_ERROR',
      'This sign-in is waiting for a different code.',
    );
    let r;
    try {
      r = await this.respond({
        email,
        session: current.session,
        name: cognitoMethod[method],
        responses: method === 'TOTP' ? { SOFTWARE_TOKEN_MFA_CODE: code } : { EMAIL_OTP_CODE: code },
      });
    } catch (error) {
      // The session survives a wrong code; it is handed back, since choosing may have replaced it.
      if (name(error) === 'CodeMismatchException')
        throw wrongCode(encodeSession(current.step, current.session));
      throw error;
    }
    assert(
      !r.ChallengeName,
      'AUTH_CHALLENGE_UNSUPPORTED',
      'This sign-in step is not supported.',
      401,
    );
    return this.tokens(r.AuthenticationResult);
  }
  async twoFactorStatus(accessToken: string) {
    const user = await this.client.send(new GetUserCommand({ AccessToken: accessToken }));
    const list = user.UserMFASettingList ?? [];
    return { totp: list.includes('SOFTWARE_TOKEN_MFA'), email: list.includes('EMAIL_OTP') };
  }
  async setupTotp(accessToken: string, email: string) {
    const r = await this.client.send(
      new AssociateSoftwareTokenCommand({ AccessToken: accessToken }),
    );
    assert(r.SecretCode, 'INTERNAL_ERROR', 'Authenticator setup could not start.', 500);
    const label = encodeURIComponent(`harbor0:${email}`);
    return {
      secret: r.SecretCode,
      uri: `otpauth://totp/${label}?secret=${r.SecretCode}&issuer=harbor0`,
    };
  }
  async confirmTotp(accessToken: string, code: string) {
    let status;
    try {
      ({ Status: status } = await this.client.send(
        new VerifySoftwareTokenCommand({
          AccessToken: accessToken,
          UserCode: code,
          FriendlyDeviceName: 'Authenticator app',
        }),
      ));
    } catch (error) {
      if (['EnableSoftwareTokenMFAException', 'CodeMismatchException'].includes(name(error) ?? ''))
        throw new DomainError('AUTH_INVALID', 'That code didn’t match. Try the next one.', 400);
      throw error;
    }
    assert(status === 'SUCCESS', 'AUTH_INVALID', 'That code didn’t match. Try the next one.', 400);
    await this.setTwoFactor(accessToken, 'TOTP', true);
  }
  async setTwoFactor(accessToken: string, method: TwoFactorMethod, enabled: boolean) {
    const settings = (on: boolean) => ({ Enabled: on, PreferredMfa: on });
    const other = method === 'TOTP' ? 'EMAIL' : 'TOTP';
    // One call, so the account is never left with both methods or, mid-switch, with neither.
    const replaces =
      enabled && (await this.twoFactorStatus(accessToken))[other === 'TOTP' ? 'totp' : 'email'];
    const changes = { [method]: enabled, ...(replaces ? { [other]: false } : {}) };
    await this.client.send(
      new SetUserMFAPreferenceCommand({
        AccessToken: accessToken,
        ...('TOTP' in changes ? { SoftwareTokenMfaSettings: settings(changes.TOTP!) } : {}),
        ...('EMAIL' in changes ? { EmailMfaSettings: settings(changes.EMAIL!) } : {}),
      }),
    );
  }
  async refresh(refreshToken: string) {
    const r = await this.client.send(
      new GetTokensFromRefreshTokenCommand({ ClientId: this.clientId, RefreshToken: refreshToken }),
    );
    assert(
      r.AuthenticationResult?.AccessToken && r.AuthenticationResult.RefreshToken,
      'AUTH_INVALID',
      'Refresh failed. Sign in again.',
      401,
    );
    return {
      accessToken: r.AuthenticationResult.AccessToken,
      refreshToken: r.AuthenticationResult.RefreshToken,
      expiresIn: r.AuthenticationResult.ExpiresIn ?? 900,
    };
  }
  async logout(refreshToken: string) {
    await this.client.send(
      new RevokeTokenCommand({ ClientId: this.clientId, Token: refreshToken }),
    );
  }
  async deleteUser(accessToken: string) {
    this.identities.delete(accessToken);
    await this.client.send(new DeleteUserCommand({ AccessToken: accessToken }));
  }
  async forgot(email: string) {
    await withEmailCodesLifted(this.client, this.poolId, email.toLowerCase(), () =>
      this.client.send(
        new ForgotPasswordCommand({ ClientId: this.clientId, Username: email.toLowerCase() }),
      ),
    );
    return { sent: true };
  }
  async reset(email: string, code: string, password: string) {
    await this.client.send(
      new ConfirmForgotPasswordCommand({
        ClientId: this.clientId,
        Username: email.toLowerCase(),
        ConfirmationCode: code,
        Password: password,
      }),
    );
    return { reset: true };
  }
}
// Explicitly injected by tests/local.ts. Production runtime never imports this provider.
export class DevelopmentAuth implements AuthProvider {
  users = new Map<string, Identity>();
  sessions = new Map<string, Identity>();
  /** Accounts disabled from the management console; they cannot sign in. */
  disabled = new Set<string>();
  /** Second steps by user id; every development code is 123456. */
  twoFactor = new Map<string, TwoFactorStatus>();
  /** Pending authenticator setups, by user id. */
  private totpPending = new Set<string>();
  /** Sign-ins waiting for a second step: session → email. */
  private pending = new Map<string, string>();
  constructor() {
    for (const name of ['alice', 'bob'])
      this.users.set(`${name}@example.test`, {
        id: name,
        email: `${name}@example.test`,
        emailVerified: true,
        username: name,
        displayName: name === 'alice' ? 'Alice Morgan' : 'Bob Chen',
        deviceId: `dev-${name}`,
      });
  }
  async identity(token: string) {
    const user =
      this.sessions.get(token) ?? [...this.users.values()].find((u) => `dev-${u.id}` === token);
    assert(
      user && !this.disabled.has(user.id),
      'AUTH_INVALID',
      'Invalid development session.',
      401,
    );
    return user;
  }
  async signup(input: { email: string; username: string; displayName: string }) {
    assert(!this.users.has(input.email), 'EMAIL_ALREADY_REGISTERED', 'Email exists.', 409);
    this.users.set(input.email, {
      id: crypto.randomUUID(),
      email: input.email,
      emailVerified: false,
      username: input.username,
      displayName: input.displayName,
    });
    return { verificationRequired: true };
  }
  async confirm(email: string, code: string) {
    assert(code === '123456', 'AUTH_INVALID', 'Development verification code is 123456.', 400);
    const u = this.users.get(email);
    assert(u, 'USER_NOT_FOUND', 'Account not found.', 404);
    u.emailVerified = true;
    u.deviceId = `dev-${u.id}`;
    return { verified: true };
  }
  async resend() {
    return { sent: true };
  }
  async login(email: string, password: string): Promise<SignIn> {
    const u = this.users.get(email);
    assert(
      u && password === 'Development-only-123!',
      'AUTH_INVALID',
      'Use Development-only-123! for local accounts.',
      401,
    );
    assert(u.emailVerified, 'EMAIL_NOT_VERIFIED', 'Verify your email.', 403);
    if (this.disabled.has(u.id)) throw suspended();
    const status = this.twoFactor.get(u.id);
    const methods = (['TOTP', 'EMAIL'] as const).filter((m) =>
      m === 'TOTP' ? status?.totp : status?.email,
    );
    if (!methods.length) return this.issue(u);
    const step = methods.length > 1 ? 'SELECT' : methods[0];
    const session = encodeSession(step, crypto.randomUUID());
    this.pending.set(session, email);
    return {
      challenge: {
        session,
        methods,
        method: step === 'SELECT' ? null : step,
        ...(step === 'EMAIL' ? { destination: 'a***@e***' } : {}),
      },
    };
  }
  private issue(u: Identity): Tokens {
    const sessionId = crypto.randomUUID();
    const token = `dev-${u.id}-${sessionId}`;
    this.sessions.set(token, { ...u, deviceId: sessionId, sessionId });
    return { accessToken: token, refreshToken: token, expiresIn: 3600 };
  }
  private waiting(email: string, session: string) {
    if (this.pending.get(session) !== email) throw signInExpired();
    return decodeSession(session).step;
  }
  async chooseSecondStep(email: string, session: string, method: TwoFactorMethod) {
    assert(this.waiting(email, session) === 'SELECT', 'VALIDATION_ERROR', 'Already chosen.');
    this.pending.delete(session);
    const next = encodeSession(method, crypto.randomUUID());
    this.pending.set(next, email);
    return {
      session: next,
      methods: [method],
      method,
      ...(method === 'EMAIL' ? { destination: 'a***@e***' } : {}),
    };
  }
  async verifySecondStep(email: string, session: string, method: TwoFactorMethod, code: string) {
    const step = this.waiting(email, session);
    assert(
      step === method || (step === 'SELECT' && method === 'TOTP'),
      'VALIDATION_ERROR',
      'Wrong step.',
    );
    if (code !== '123456') throw wrongCode(session);
    this.pending.delete(session);
    return this.issue(this.users.get(email)!);
  }
  async twoFactorStatus(token: string) {
    const user = await this.identity(token);
    return this.twoFactor.get(user.id) ?? { totp: false, email: false };
  }
  async setupTotp(token: string, email: string) {
    const user = await this.identity(token);
    this.totpPending.add(user.id);
    const secret = 'JBSWY3DPEHPK3PXP';
    return {
      secret,
      uri: `otpauth://totp/${encodeURIComponent(`harbor0:${email}`)}?secret=${secret}&issuer=harbor0`,
    };
  }
  async confirmTotp(token: string, code: string) {
    const user = await this.identity(token);
    assert(this.totpPending.has(user.id), 'VALIDATION_ERROR', 'Start authenticator setup first.');
    assert(
      code === '123456',
      'AUTH_INVALID',
      'That code didn’t match. The development code is 123456.',
      400,
    );
    this.totpPending.delete(user.id);
    await this.setTwoFactor(token, 'TOTP', true);
  }
  async setTwoFactor(token: string, method: TwoFactorMethod, enabled: boolean) {
    const user = await this.identity(token);
    const status = enabled
      ? { totp: false, email: false }
      : { ...(this.twoFactor.get(user.id) ?? { totp: false, email: false }) };
    status[method === 'TOTP' ? 'totp' : 'email'] = enabled;
    this.twoFactor.set(user.id, status);
  }
  async refresh(token: string) {
    await this.identity(token);
    return { accessToken: token, refreshToken: token, expiresIn: 3600 };
  }
  async logout() {}
  async deleteUser(token: string) {
    const user = await this.identity(token);
    for (const [email, u] of this.users) if (u.id === user.id) this.users.delete(email);
    for (const [key, u] of this.sessions) if (u.id === user.id) this.sessions.delete(key);
  }
  async forgot() {
    return { sent: true };
  }
  async reset() {
    return { reset: true };
  }
}
