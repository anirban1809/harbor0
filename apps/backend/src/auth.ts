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
} from '@aws-sdk/client-cognito-identity-provider';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import type { Identity } from '@harbor/contracts';
import { assert, DomainError } from './errors';
export type Tokens = { accessToken: string; refreshToken: string; expiresIn: number };
export interface AuthProvider {
  identity(token: string): Promise<Identity>;
  signup(input: {
    email: string;
    password: string;
    username: string;
    displayName: string;
  }): Promise<unknown>;
  confirm(email: string, code: string): Promise<unknown>;
  resend(email: string): Promise<unknown>;
  login(email: string, password: string): Promise<Tokens>;
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
  async signup(input: { email: string; password: string; username: string; displayName: string }) {
    await this.client.send(
      new SignUpCommand({
        ClientId: this.clientId,
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
  async login(email: string, password: string) {
    const r = await this.client.send(
      new InitiateAuthCommand({
        ClientId: this.clientId,
        AuthFlow: 'USER_PASSWORD_AUTH',
        AuthParameters: { USERNAME: email.toLowerCase(), PASSWORD: password },
      }),
    );
    assert(
      r.AuthenticationResult?.AccessToken && r.AuthenticationResult.RefreshToken,
      'AUTH_CHALLENGE_REQUIRED',
      'Complete the authentication challenge in Cognito managed login.',
      401,
    );
    return {
      accessToken: r.AuthenticationResult.AccessToken,
      refreshToken: r.AuthenticationResult.RefreshToken,
      expiresIn: r.AuthenticationResult.ExpiresIn ?? 900,
    };
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
    await this.client.send(
      new ForgotPasswordCommand({ ClientId: this.clientId, Username: email.toLowerCase() }),
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
    assert(user, 'AUTH_INVALID', 'Invalid development session.', 401);
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
  async login(email: string, password: string) {
    const u = this.users.get(email);
    assert(
      u && password === 'Development-only-123!',
      'AUTH_INVALID',
      'Use Development-only-123! for local accounts.',
      401,
    );
    assert(u.emailVerified, 'EMAIL_NOT_VERIFIED', 'Verify your email.', 403);
    const sessionId = crypto.randomUUID();
    const token = `dev-${u.id}-${sessionId}`;
    this.sessions.set(token, { ...u, deviceId: sessionId, sessionId });
    return { accessToken: token, refreshToken: token, expiresIn: 3600 };
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
