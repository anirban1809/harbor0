import {
    CognitoIdentityProviderClient,
    ListUsersCommand,
    AdminResetUserPasswordCommand,
    AdminConfirmSignUpCommand,
    AdminUpdateUserAttributesCommand,
    AdminDisableUserCommand,
    AdminEnableUserCommand,
    AdminUserGlobalSignOutCommand,
    AdminDeleteUserCommand,
    DescribeUserPoolCommand,
    ResendConfirmationCodeCommand,
    type UserType,
} from '@aws-sdk/client-cognito-identity-provider';
import type { AccountStatus, DirectoryUser } from '../../../../packages/contracts/src/admin';
import type { DevelopmentAuth } from '../auth';
import { assert } from '../errors';

export type DirectoryPage = { items: DirectoryUser[]; nextCursor: string | null; };
/** The customer sign-in accounts, as staff see and change them. Ids are the account `sub`. */
export interface UserDirectory {
    list(query: string, cursor?: string): Promise<DirectoryPage>;
    get(userId: string): Promise<DirectoryUser | null>;
    /** Emails a reset code; the next sign-in must set a new password with it. */
    resetPassword(userId: string): Promise<void>;
    resendVerification(userId: string): Promise<void>;
    /** Marks the email verified for someone who cannot receive the code. */
    confirm(userId: string): Promise<void>;
    setEnabled(userId: string, enabled: boolean): Promise<void>;
    /** Revokes every refresh token, so no device can renew its session. */
    signOut(userId: string): Promise<void>;
    delete(userId: string): Promise<void>;
    estimatedUsers(): Promise<number | null>;
    /** Every sign-in account; one paged listing of the whole pool. */
    all(): Promise<DirectoryUser[]>;
    /** The id of every sign-in account; one paged listing, so callers cache the result. */
    ids(): Promise<Set<string>>;
}

const PAGE = 50;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const statuses = new Set<AccountStatus>([
    'CONFIRMED',
    'UNCONFIRMED',
    'RESET_REQUIRED',
    'FORCE_CHANGE_PASSWORD',
]);

export class CognitoDirectory implements UserDirectory {
    private client = new CognitoIdentityProviderClient({});
    constructor(
        private poolId: string,
        private clientId: string,
    ) { }
    private user(u: UserType): DirectoryUser {
        const attrs = Object.fromEntries((u.Attributes ?? []).map((a) => [a.Name!, a.Value ?? '']));
        const status = u.UserStatus as AccountStatus;
        return {
            id: attrs.sub ?? u.Username!,
            email: attrs.email ?? '',
            username: attrs.preferred_username || null,
            displayName: attrs.name || null,
            status: statuses.has(status) ? status : 'UNKNOWN',
            enabled: u.Enabled ?? false,
            createdAt: u.UserCreateDate?.toISOString() ?? null,
        };
    }
    private async find(filter: string, limit: number, cursor?: string) {
        const r = await this.client.send(
            new ListUsersCommand({
                UserPoolId: this.poolId,
                Filter: filter || undefined,
                Limit: limit,
                PaginationToken: cursor,
            }),
        );
        return { users: r.Users ?? [], nextCursor: r.PaginationToken ?? null };
    }
    /** The pool's own username for an account; admin calls take it rather than the `sub`. */
    private async username(userId: string) {
        const { users } = await this.find(`sub = "${userId.replace(/[^a-zA-Z0-9-]/g, '')}"`, 1);
        assert(users[0]?.Username, 'USER_NOT_FOUND', 'This sign-in account no longer exists.', 404);
        return users[0].Username;
    }
    async list(query: string, cursor?: string): Promise<DirectoryPage> {
        // Cognito filters match one attribute by prefix; quotes would break out of the filter.
        const q = query.trim().toLowerCase().replace(/["\\]/g, '');
        if (!q) {
            const page = await this.find('', PAGE, cursor);
            return { items: page.users.map((u) => this.user(u)), nextCursor: page.nextCursor };
        }
        if (uuid.test(q)) {
            const page = await this.find(`sub = "${q}"`, 1);
            return { items: page.users.map((u) => this.user(u)), nextCursor: null };
        }
        const filters = q.includes('@')
            ? [`email ^= "${q}"`]
            : [`email ^= "${q}"`, `preferred_username ^= "${q}"`];
        const found = new Map<string, DirectoryUser>();
        for (const filter of filters)
            for (const u of (await this.find(filter, PAGE)).users) {
                const user = this.user(u);
                found.set(user.id, user);
            }
        return { items: [...found.values()], nextCursor: null };
    }
    async get(userId: string) {
        if (!/^[a-zA-Z0-9-]+$/.test(userId)) return null;
        const { users } = await this.find(`sub = "${userId}"`, 1);
        return users[0] ? this.user(users[0]) : null;
    }
    async resetPassword(userId: string) {
        await this.client.send(
            new AdminResetUserPasswordCommand({
                UserPoolId: this.poolId,
                Username: await this.username(userId),
            }),
        );
    }
    async resendVerification(userId: string) {
        await this.client.send(
            new ResendConfirmationCodeCommand({
                ClientId: this.clientId,
                Username: await this.username(userId),
            }),
        );
    }
    async confirm(userId: string) {
        const Username = await this.username(userId);
        await this.client.send(new AdminConfirmSignUpCommand({ UserPoolId: this.poolId, Username }));
        await this.client.send(
            new AdminUpdateUserAttributesCommand({
                UserPoolId: this.poolId,
                Username,
                UserAttributes: [{ Name: 'email_verified', Value: 'true' }],
            }),
        );
    }
    async setEnabled(userId: string, enabled: boolean) {
        const input = { UserPoolId: this.poolId, Username: await this.username(userId) };
        await this.client.send(
            enabled ? new AdminEnableUserCommand(input) : new AdminDisableUserCommand(input),
        );
    }
    async signOut(userId: string) {
        await this.client.send(
            new AdminUserGlobalSignOutCommand({
                UserPoolId: this.poolId,
                Username: await this.username(userId),
            }),
        );
    }
    async delete(userId: string) {
        await this.client.send(
            new AdminDeleteUserCommand({
                UserPoolId: this.poolId,
                Username: await this.username(userId),
            }),
        );
    }
    async estimatedUsers() {
        const r = await this.client.send(new DescribeUserPoolCommand({ UserPoolId: this.poolId }));
        return r.UserPool?.EstimatedNumberOfUsers ?? null;
    }
    async all() {
        const users: DirectoryUser[] = [];
        let token: string | undefined;
        do {
            const r = await this.client.send(
                new ListUsersCommand({ UserPoolId: this.poolId, Limit: 60, PaginationToken: token }),
            );
            for (const u of r.Users ?? []) users.push(this.user(u));
            token = r.PaginationToken;
        } while (token);
        return users;
    }
    async ids() {
        return new Set((await this.all()).map((u) => u.id));
    }
}

/** The local directory: the development sign-in accounts held in memory by DevelopmentAuth. */
export class DevelopmentDirectory implements UserDirectory {
    private resetRequired = new Set<string>();
    private created = new Map<string, string>();
    constructor(private auth: DevelopmentAuth) { }
    private user(identity: {
        id: string;
        email: string;
        username: string;
        displayName: string;
        emailVerified: boolean;
    }): DirectoryUser {
        if (!this.created.has(identity.id)) this.created.set(identity.id, new Date().toISOString());
        return {
            id: identity.id,
            email: identity.email,
            username: identity.username,
            displayName: identity.displayName,
            status: !identity.emailVerified
                ? 'UNCONFIRMED'
                : this.resetRequired.has(identity.id)
                    ? 'RESET_REQUIRED'
                    : 'CONFIRMED',
            enabled: !this.auth.disabled.has(identity.id),
            createdAt: this.created.get(identity.id)!,
        };
    }
    private identity(userId: string) {
        const found = [...this.auth.users.values()].find((u) => u.id === userId);
        assert(found, 'USER_NOT_FOUND', 'This sign-in account no longer exists.', 404);
        return found;
    }
    async list(query: string, cursor?: string): Promise<DirectoryPage> {
        const q = query.trim().toLowerCase();
        const all = [...this.auth.users.values()]
            .filter(
                (u) => !q || u.id === q || u.email.startsWith(q) || u.username.toLowerCase().startsWith(q),
            )
            .sort((a, b) => a.email.localeCompare(b.email));
        const start = cursor ? Number(cursor) : 0;
        const items = all.slice(start, start + PAGE).map((u) => this.user(u));
        return { items, nextCursor: start + PAGE < all.length ? String(start + PAGE) : null };
    }
    async get(userId: string) {
        const found = [...this.auth.users.values()].find((u) => u.id === userId);
        return found ? this.user(found) : null;
    }
    async resetPassword(userId: string) {
        this.identity(userId);
        this.resetRequired.add(userId);
    }
    async resendVerification(userId: string) {
        this.identity(userId);
    }
    async confirm(userId: string) {
        const identity = this.identity(userId);
        identity.emailVerified = true;
        identity.deviceId = `dev-${identity.id}`;
    }
    async setEnabled(userId: string, enabled: boolean) {
        this.identity(userId);
        if (enabled) this.auth.disabled.delete(userId);
        else this.auth.disabled.add(userId);
    }
    async signOut(userId: string) {
        for (const [token, session] of this.auth.sessions)
            if (session.id === userId) this.auth.sessions.delete(token);
    }
    async delete(userId: string) {
        for (const [email, u] of this.auth.users) if (u.id === userId) this.auth.users.delete(email);
        await this.signOut(userId);
    }
    async estimatedUsers() {
        return this.auth.users.size;
    }
    async all() {
        return [...this.auth.users.values()].map((u) => this.user(u));
    }
    async ids() {
        return new Set([...this.auth.users.values()].map((u) => u.id));
    }
}
