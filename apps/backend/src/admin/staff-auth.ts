import {
    CognitoIdentityProviderClient,
    InitiateAuthCommand,
    RespondToAuthChallengeCommand,
    AssociateSoftwareTokenCommand,
    VerifySoftwareTokenCommand,
    GetTokensFromRefreshTokenCommand,
    RevokeTokenCommand,
    GetUserCommand,
    type AuthenticationResultType,
    type ChallengeNameType,
} from '@aws-sdk/client-cognito-identity-provider';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import type { Staff, StaffRole } from '../../../../packages/contracts/src/admin';
import { assert, DomainError } from '../errors';

export type StaffTokens = { accessToken: string; refreshToken: string; expiresIn: number };
export type StaffChallenge = 'NEW_PASSWORD' | 'MFA_SETUP' | 'MFA';
export type StaffAuthStep =
    | { status: 'SIGNED_IN'; tokens: StaffTokens }
    | { status: 'CHALLENGE'; challenge: StaffChallenge; session: string; secret?: string };
export type StaffChallengeInput = {
    email: string;
    session: string;
    challenge: StaffChallenge;
    newPassword?: string;
    code?: string;
};
/** Sign-in for console staff. Staff live in their own pool; customer tokens are never accepted. */
export interface StaffAuth {
    login(email: string, password: string): Promise<StaffAuthStep>;
    respond(input: StaffChallengeInput): Promise<StaffAuthStep>;
    refresh(refreshToken: string): Promise<StaffTokens>;
    identity(accessToken: string): Promise<Staff>;
    logout(refreshToken: string): Promise<void>;
}

/** Cognito groups map to roles; a staff account in neither group cannot use the console. */
export const roleFromGroups = (groups: unknown): StaffRole | null => {
    const list = Array.isArray(groups) ? groups : [];
    if (list.includes('admin')) return 'ADMIN';
    if (list.includes('support')) return 'SUPPORT';
    return null;
};

const CACHE_MS = 60_000;
export class CognitoStaffAuth implements StaffAuth {
    private client = new CognitoIdentityProviderClient({});
    private verifier;
    private emails = new Map<string, { email: string; until: number }>();
    constructor(
        poolId: string,
        private clientId: string,
    ) {
        this.verifier = CognitoJwtVerifier.create({ userPoolId: poolId, clientId, tokenUse: 'access' });
    }
    private tokens(result: AuthenticationResultType | undefined): StaffTokens {
        assert(
            result?.AccessToken && result.RefreshToken,
            'AUTH_INVALID',
            'Sign-in could not be completed. Start again.',
            401,
        );
        return {
            accessToken: result.AccessToken,
            refreshToken: result.RefreshToken,
            expiresIn: result.ExpiresIn ?? 900,
        };
    }
    private async step(response: {
        ChallengeName?: ChallengeNameType;
        Session?: string;
        AuthenticationResult?: AuthenticationResultType;
    }): Promise<StaffAuthStep> {
        if (!response.ChallengeName)
            return { status: 'SIGNED_IN', tokens: this.tokens(response.AuthenticationResult) };
        assert(response.Session, 'AUTH_INVALID', 'Sign-in could not be completed. Start again.', 401);
        if (response.ChallengeName === 'NEW_PASSWORD_REQUIRED')
            return { status: 'CHALLENGE', challenge: 'NEW_PASSWORD', session: response.Session };
        if (response.ChallengeName === 'SOFTWARE_TOKEN_MFA')
            return { status: 'CHALLENGE', challenge: 'MFA', session: response.Session };
        if (response.ChallengeName === 'MFA_SETUP') {
            const token = await this.client.send(
                new AssociateSoftwareTokenCommand({ Session: response.Session }),
            );
            assert(token.SecretCode && token.Session, 'AUTH_INVALID', 'Authenticator setup failed.', 401);
            return {
                status: 'CHALLENGE',
                challenge: 'MFA_SETUP',
                session: token.Session,
                secret: token.SecretCode,
            };
        }
        throw new DomainError(
            'AUTH_CHALLENGE_UNSUPPORTED',
            'This sign-in step is not supported by the console.',
            401,
        );
    }
    async login(email: string, password: string) {
        return this.step(
            await this.client.send(
                new InitiateAuthCommand({
                    ClientId: this.clientId,
                    AuthFlow: 'USER_PASSWORD_AUTH',
                    AuthParameters: { USERNAME: email.toLowerCase(), PASSWORD: password },
                }),
            ),
        );
    }
    async respond(input: StaffChallengeInput) {
        const USERNAME = input.email.toLowerCase();
        if (input.challenge === 'NEW_PASSWORD') {
            assert(input.newPassword, 'VALIDATION_ERROR', 'Choose a new password.');
            return this.step(
                await this.client.send(
                    new RespondToAuthChallengeCommand({
                        ClientId: this.clientId,
                        ChallengeName: 'NEW_PASSWORD_REQUIRED',
                        Session: input.session,
                        ChallengeResponses: { USERNAME, NEW_PASSWORD: input.newPassword },
                    }),
                ),
            );
        }
        assert(input.code, 'VALIDATION_ERROR', 'Enter the code from your authenticator app.');
        if (input.challenge === 'MFA_SETUP') {
            const verified = await this.client.send(
                new VerifySoftwareTokenCommand({
                    Session: input.session,
                    UserCode: input.code,
                    FriendlyDeviceName: 'harbor0 console',
                }),
            );
            assert(
                verified.Status === 'SUCCESS' && verified.Session,
                'AUTH_INVALID',
                'That code did not match. Try the next one.',
                400,
            );
            return this.step(
                await this.client.send(
                    new RespondToAuthChallengeCommand({
                        ClientId: this.clientId,
                        ChallengeName: 'MFA_SETUP',
                        Session: verified.Session,
                        ChallengeResponses: { USERNAME },
                    }),
                ),
            );
        }
        return this.step(
            await this.client.send(
                new RespondToAuthChallengeCommand({
                    ClientId: this.clientId,
                    ChallengeName: 'SOFTWARE_TOKEN_MFA',
                    Session: input.session,
                    ChallengeResponses: { USERNAME, SOFTWARE_TOKEN_MFA_CODE: input.code },
                }),
            ),
        );
    }
    async refresh(refreshToken: string) {
        const r = await this.client.send(
            new GetTokensFromRefreshTokenCommand({ ClientId: this.clientId, RefreshToken: refreshToken }),
        );
        return this.tokens(r.AuthenticationResult);
    }
    async identity(accessToken: string): Promise<Staff> {
        let jwt;
        try {
            jwt = await this.verifier.verify(accessToken);
        } catch {
            throw new DomainError('AUTH_INVALID', 'Your console session expired. Sign in again.', 401);
        }
        const role = roleFromGroups(jwt['cognito:groups']);
        assert(role, 'FORBIDDEN', 'This account has no console role.', 403);
        let cached = this.emails.get(accessToken);
        if (!cached || cached.until < Date.now()) {
            try {
                const user = await this.client.send(new GetUserCommand({ AccessToken: accessToken }));
                const email = user.UserAttributes?.find((a) => a.Name === 'email')?.Value ?? '';
                cached = { email, until: Math.min(Date.now() + CACHE_MS, jwt.exp * 1000) };
            } catch {
                // GetUser fails once the token is revoked (sign-out) or the staff account is disabled.
                throw new DomainError('AUTH_INVALID', 'Your console session ended. Sign in again.', 401);
            }
            if (this.emails.size > 200) this.emails.clear();
            this.emails.set(accessToken, cached);
        }
        return { id: jwt.sub, email: cached.email, role };
    }
    async logout(refreshToken: string) {
        await this.client.send(
            new RevokeTokenCommand({ ClientId: this.clientId, Token: refreshToken }),
        );
    }
}

export const DEV_STAFF_PASSWORD = 'Development-only-123!';
export const DEV_STAFF_CODE = '123456';
/**
 * Local staff: admin@example.test (ADMIN) and support@example.test (SUPPORT). Sign-in always
 * asks for an authenticator code (123456) so the console's MFA step is exercised locally.
 */
export class DevelopmentStaffAuth implements StaffAuth {
    staff = new Map<string, Staff>([
        ['admin@example.test', { id: 'staff-admin', email: 'admin@example.test', role: 'ADMIN' }],
        [
            'support@example.test',
            { id: 'staff-support', email: 'support@example.test', role: 'SUPPORT' },
        ],
    ]);
    private sessions = new Map<string, Staff>();
    async login(email: string, password: string): Promise<StaffAuthStep> {
        const staff = this.staff.get(email.toLowerCase());
        assert(
            staff && password === DEV_STAFF_PASSWORD,
            'AUTH_INVALID',
            'Email or password is incorrect.',
            401,
        );
        return { status: 'CHALLENGE', challenge: 'MFA', session: `dev-mfa:${staff.email}` };
    }
    async respond(input: StaffChallengeInput): Promise<StaffAuthStep> {
        const staff = this.staff.get(input.email.toLowerCase());
        assert(
            staff && input.session === `dev-mfa:${staff.email}` && input.code === DEV_STAFF_CODE,
            'AUTH_INVALID',
            'That code did not match. The development code is 123456.',
            400,
        );
        const token = `staff-${crypto.randomUUID()}`;
        this.sessions.set(token, staff);
        return {
            status: 'SIGNED_IN',
            tokens: { accessToken: token, refreshToken: token, expiresIn: 900 },
        };
    }
    async refresh(refreshToken: string) {
        await this.identity(refreshToken);
        return { accessToken: refreshToken, refreshToken, expiresIn: 900 };
    }
    async identity(accessToken: string) {
        const staff = this.sessions.get(accessToken);
        assert(staff, 'AUTH_INVALID', 'Your console session expired. Sign in again.', 401);
        return staff;
    }
    async logout(refreshToken: string) {
        this.sessions.delete(refreshToken);
    }
}
