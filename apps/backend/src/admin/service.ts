import { randomUUID } from 'node:crypto';
import { normalizeEmail, storageUsage } from '@harbor/contracts';
import type {
    AdminProfile,
    AdminUserDetail,
    AdminUserFilters,
    AdminUserListItem,
    AdminUserPage,
    AdminUserSort,
    AuditEntry,
    DirectoryUser,
    Staff,
    StaffDeletionReason,
    StorageTotals,
} from '../../../../packages/contracts/src/admin';
import type { BackupRoot } from '../../../../packages/contracts/src/backups';
import { StorageService, userPK, type Account, type Job } from '../domain';
import { assert } from '../errors';
import { transact, Transaction } from '../repository';
import type { UserDirectory } from './directory';
import { accountsOnDevice, type DeviceAccount } from '../signup-guard';

const AUDIT = 'ADMIN_AUDIT';
const userAudit = (userId: string) => `ADMIN_AUDIT#${userId}`;
// Sort keys count down so a forward query returns the newest entries first.
const auditKey = (at: number, id: string) => `${String(9e15 - at).padStart(16, '0')}#${id}`;
// Totals come from a full-table scan, so one result serves every console view for a while.
export const STORAGE_TOTALS_MAX_AGE_MS = 15 * 60_000;
const STORAGE_TOTALS_MIN_REFRESH_MS = 60_000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USER_PAGE = 50;

type Platform = AdminUserListItem['platforms'][number];
// The filtered list reads the whole pool and table; Load more reuses one read for a while.
const USER_INDEX_MAX_AGE_MS = 2 * 60_000;
const DAY_MS = 86400_000;
const MOBILE = new Set<Platform>(['IOS', 'ANDROID']);
const DESKTOP = new Set<Platform>(['MACOS', 'WINDOWS', 'LINUX']);
const PLATFORMS = new Set<string>(['WEB', 'MACOS', 'WINDOWS', 'LINUX', 'IOS', 'ANDROID']);

type Sortable = Pick<AdminUserListItem, 'id' | 'createdAt' | 'usedBytes' | 'lastSeenAt'>;
/** Orders accounts by `sort`; accounts without the value (no profile yet) always come last. */
function compareUsers({ sort, order }: AdminUserSort) {
    const value = (u: Sortable) =>
        sort === 'created' ? u.createdAt : sort === 'seen' ? u.lastSeenAt : u.usedBytes;
    return (a: Sortable, b: Sortable) => {
        const x = value(a);
        const y = value(b);
        if (x === null || y === null) return x === y ? a.id.localeCompare(b.id) : x === null ? 1 : -1;
        const by = x < y ? -1 : x > y ? 1 : a.id.localeCompare(b.id);
        return order === 'asc' ? by : -by;
    };
}

/** An indexed account: its list row plus what the filters need that the row does not show. */
type IndexedUser = AdminUserListItem & { hasProfile: boolean; raisedQuota: boolean };
const hasFilters = (filters: AdminUserFilters) => Object.values(filters).some((v) => v !== undefined);

/**
 * Whether `at` falls in a filter's window: within the last N days (`7d`), more than 30 days
 * ago (`inactive-30d`) or 90 (`older-90d`), or never. No window passes everything.
 */
function inWindow(at: string | null, window: string | undefined, now: number) {
    if (!window) return true;
    if (window === 'never') return !at;
    if (!at) return false;
    const age = now - Date.parse(at);
    if (window === 'inactive-30d') return age > 30 * DAY_MS;
    if (window === 'older-90d') return age > 90 * DAY_MS;
    return age <= Number.parseInt(window, 10) * DAY_MS;
}

/** Whether `user` passes every filter set in `filters`, as of `now`. */
export function matchesFilters(user: IndexedUser, filters: AdminUserFilters, now = Date.now()) {
    switch (filters.state) {
        case 'active':
            if (user.suspended || !user.enabled || user.status === 'UNCONFIRMED') return false;
            break;
        case 'unverified':
            if (user.status !== 'UNCONFIRMED') return false;
            break;
        case 'disabled':
            if (user.enabled) return false;
            break;
        case 'suspended':
            if (!user.suspended) return false;
            break;
        case 'deleted':
            if (!user.deleted) return false;
            break;
        case 'never-signed-in':
            if (user.hasProfile) return false;
            break;
    }
    // Deleted accounts are only listed when asked for; they have left the sign-in directory.
    if (user.deleted && filters.state !== 'deleted') return false;
    const { platform } = filters;
    if (platform === 'NONE' && user.platforms.length) return false;
    if (platform === 'MOBILE' && !user.platforms.some((p) => MOBILE.has(p))) return false;
    if (platform === 'DESKTOP' && !user.platforms.some((p) => DESKTOP.has(p))) return false;
    if (platform && PLATFORMS.has(platform) && !user.platforms.includes(platform as Platform))
        return false;
    const used = user.usedBytes ?? 0;
    const share = user.quotaBytes ? used / user.quotaBytes : 0;
    if (filters.storage === 'empty' && used > 0) return false;
    if (filters.storage === 'uploaded' && used === 0) return false;
    if (filters.storage === 'over-50' && share < 0.5) return false;
    if (filters.storage === 'over-90' && share < 0.9) return false;
    if (filters.quota === 'raised' && !user.raisedQuota) return false;
    if (filters.quota === 'standard' && (user.raisedQuota || !user.hasProfile)) return false;
    if (!inWindow(user.lastSeenAt, filters.seen, now)) return false;
    if (!inWindow(user.createdAt, filters.joined, now)) return false;
    return true;
}

type Audit = {
    action: string;
    userId?: string | null;
    userEmail?: string | null;
    reason?: string | null;
    details?: Record<string, unknown>;
    /** Another log to file the entry under as well, like a feature flag's history. */
    scope?: string;
};

/**
 * What console staff can see and do to customer accounts. Every change is written to an
 * append-only audit log, globally and per account, naming the staff member and their reason.
 */
export class AdminService {
    constructor(
        private service: StorageService,
        private directory: UserDirectory,
    ) { }
    get repo() {
        return this.service.repo;
    }
    /** The account's email from the sign-in directory, or its profile once it has left it. */
    async email(userId: string) {
        const [user, account] = await Promise.all([this.directory.get(userId), this.profile(userId)]);
        return user?.email ?? account?.email ?? null;
    }
    private profile(userId: string) {
        return new Transaction(this.repo).get<Account>(userPK(userId), 'PROFILE');
    }
    /** Writes the audit entry into `tx`, so it commits with the change it describes. */
    async audit(tx: Transaction, staff: Staff, entry: Audit) {
        // Every staff change is audited, so this is where the filtered list stops being current.
        this.userIndex = undefined;
        const at = Date.now();
        const record: AuditEntry = {
            id: randomUUID(),
            at: new Date(at).toISOString(),
            actor: { id: staff.id, email: staff.email },
            action: entry.action,
            userId: entry.userId ?? null,
            userEmail: entry.userEmail ?? null,
            reason: entry.reason ?? null,
            details: entry.details ?? {},
        };
        await tx.put(AUDIT, auditKey(at, record.id), record);
        if (record.userId) await tx.put(userAudit(record.userId), auditKey(at, record.id), record);
        if (entry.scope) await tx.put(entry.scope, auditKey(at, record.id), record);
        return record;
    }
    private record(staff: Staff, entry: Audit) {
        return transact(this.repo, (tx) => this.audit(tx, staff, entry));
    }
    async auditLog(cursor?: string, limit = 50) {
        const page = await this.repo.query(AUDIT, '', limit, cursor);
        return { items: page.rows.map((r) => r.data as AuditEntry), nextCursor: page.cursor };
    }
    async overview(refresh = false) {
        const [estimatedUsers, storage, recent] = await Promise.all([
            this.directory.estimatedUsers().catch(() => null),
            this.storageTotals(refresh),
            this.auditLog(undefined, 15),
        ]);
        return { estimatedUsers, storage, recent: recent.items };
    }
    /** Storage across all accounts, recomputed when older than 15 minutes or on request. */
    async storageTotals(refresh = false): Promise<StorageTotals> {
        const cached = await this.repo.get({ pk: 'ADMIN_STATS', sk: 'STORAGE' });
        // Totals cached before a field was added are recomputed rather than served incomplete.
        const age =
            cached && (cached.data as Partial<StorageTotals>).awaitingPurge
                ? Date.now() - Date.parse((cached.data as StorageTotals).computedAt)
                : Infinity;
        if (cached && age < (refresh ? STORAGE_TOTALS_MIN_REFRESH_MS : STORAGE_TOTALS_MAX_AGE_MS))
            return cached.data as StorageTotals;
        const totals: StorageTotals = {
            computedAt: new Date().toISOString(),
            accounts: 0,
            usedBytes: 0,
            allocatedBytes: 0,
            reservedBytes: 0,
            trashBytes: 0,
            pendingDeletionBytes: 0,
            deletedAccounts: 0,
            awaitingPurge: { accounts: 0, usedBytes: 0 },
            orphans: { accounts: 0, usedBytes: 0, allocatedBytes: 0 },
        };
        const [profiles, signIns] = await Promise.all([this.repo.scanProfiles(), this.directory.ids()]);
        const at = new Date().toISOString();
        for (const p of profiles) {
            totals.pendingDeletionBytes += p.purgingBytes ?? 0;
            if (p.deletedAt) {
                totals.deletedAccounts++;
                totals.pendingDeletionBytes += p.storageUsedBytes ?? 0;
                if (p.purgeAt && p.purgeAt > at) {
                    totals.awaitingPurge.accounts++;
                    totals.awaitingPurge.usedBytes += p.storageUsedBytes ?? 0;
                }
                continue;
            }
            if (p.id && !signIns.has(p.id)) {
                totals.orphans.accounts++;
                totals.orphans.usedBytes += p.storageUsedBytes ?? 0;
                totals.orphans.allocatedBytes += p.storageQuotaBytes ?? 0;
                continue;
            }
            totals.accounts++;
            totals.usedBytes += p.storageUsedBytes ?? 0;
            totals.allocatedBytes += p.storageQuotaBytes ?? 0;
            totals.reservedBytes += p.storageReservedBytes ?? 0;
            totals.trashBytes += p.trashBytes ?? 0;
        }
        // A concurrent refresh may have written first; either result is current enough.
        await transact(this.repo, async (tx) => {
            await tx.put('ADMIN_STATS', 'STORAGE', totals);
        }).catch(() => undefined);
        return totals;
    }

    async search(
        query: string,
        cursor?: string,
        sort?: AdminUserSort,
        filters: AdminUserFilters = {},
    ): Promise<AdminUserPage> {
        const q = query.trim();
        if (hasFilters(filters) || (sort && !q) || sort?.sort === 'seen')
            return this.filtered(q, filters, sort, cursor);
        let page = await this.directory.list(q, cursor);
        if (q && !q.includes('@') && !uuid.test(q)) {
            // Usernames can change in the app, so the current one is the claim in the table, while
            // the sign-in directory still holds the one chosen at sign-up.
            const claims = await this.repo.query('USERNAME', q.toLowerCase(), 10);
            const known = new Set(page.items.map((u) => u.id));
            const extra = await Promise.all(
                claims.rows
                    .map((r) => (r.data as { userId?: string; }).userId)
                    .filter((id): id is string => !!id && !known.has(id))
                    .map((id) => this.directory.get(id)),
            );
            page = { ...page, items: [...page.items, ...extra.filter((u) => !!u)] };
        }
        if (!page.items.length && uuid.test(q)) {
            // A deleted account has left the directory but keeps its tombstone profile.
            const tombstone = await this.profile(q);
            if (tombstone) page = { items: [this.fromProfile(tombstone)], nextCursor: null };
        }
        const items = await this.withProfiles(page.items);
        if (sort) items.sort(compareUsers(sort));
        return { items, nextCursor: page.nextCursor, summary: null };
    }
    private userIndex?: Promise<{ computedAt: string; users: IndexedUser[]; }>;
    private userIndexAt = 0;
    /**
     * Every account with what the list filters on: the sign-in pool, every profile and every
     * device session. That is a full listing and two table scans, so one read is reused for
     * two minutes, which also keeps Load more on the same snapshot.
     */
    private indexUsers() {
        if (this.userIndex && Date.now() - this.userIndexAt < USER_INDEX_MAX_AGE_MS)
            return this.userIndex;
        this.userIndexAt = Date.now();
        this.userIndex = this.buildUserIndex().catch((error) => {
            this.userIndex = undefined;
            throw error;
        });
        return this.userIndex;
    }
    private async buildUserIndex() {
        const computedAt = new Date().toISOString();
        const [directory, profiles, devices] = await Promise.all([
            this.directory.all(),
            this.repo.scanProfiles(),
            this.repo.scanDevices(),
        ]);
        const seen = new Map<string, { platforms: Set<Platform>; lastSeenAt: string | null; }>();
        for (const d of devices) {
            if (!d.userId) continue;
            const entry = seen.get(d.userId) ?? { platforms: new Set(), lastSeenAt: null };
            if (d.platform && PLATFORMS.has(d.platform)) entry.platforms.add(d.platform as Platform);
            if (d.lastSeenAt && (!entry.lastSeenAt || d.lastSeenAt > entry.lastSeenAt))
                entry.lastSeenAt = d.lastSeenAt;
            seen.set(d.userId, entry);
        }
        const byId = new Map(profiles.filter((p) => p.id).map((p) => [p.id!, p]));
        const row = (user: DirectoryUser, hasSignIn: boolean): IndexedUser => {
            const p = byId.get(user.id);
            const devices = seen.get(user.id);
            return {
                ...user,
                username: p?.username ?? user.username,
                displayName: p?.displayName ?? user.displayName,
                quotaBytes: p?.storageQuotaBytes ?? null,
                usedBytes: p?.storageUsedBytes ?? null,
                suspended: !!p?.suspendedAt,
                deleted: !!p?.deletedAt || (!hasSignIn && !!p),
                platforms: [...(devices?.platforms ?? [])].sort(),
                lastSeenAt: devices?.lastSeenAt ?? null,
                hasProfile: !!p,
                raisedQuota:
                    !!p?.freeQuotaBytes && (p.storageQuotaBytes ?? 0) > p.freeQuotaBytes,
            };
        };
        const users = directory.map((u) => row(u, true));
        const signIns = new Set(directory.map((u) => u.id));
        // Deleted accounts keep a tombstone profile after leaving the directory.
        for (const p of profiles)
            if (p.id && p.deletedAt && !signIns.has(p.id))
                users.push(
                    row(
                        {
                            id: p.id,
                            email: p.email ?? '',
                            username: p.username ?? null,
                            displayName: p.displayName ?? null,
                            status: 'UNKNOWN',
                            enabled: false,
                            createdAt: p.createdAt ?? null,
                        },
                        false,
                    ),
                );
        return { computedAt, users };
    }
    /**
     * The accounts that match `query` and `filters`, in `sort` order (newest first by default),
     * with totals across every match. The cursor is an offset into that order.
     */
    private async filtered(
        query: string,
        filters: AdminUserFilters,
        sort: AdminUserSort | undefined,
        cursor?: string,
    ): Promise<AdminUserPage> {
        const start = cursor && /^\d+$/.test(cursor) ? Number(cursor) : 0;
        const { computedAt, users } = await this.indexUsers();
        const q = query.toLowerCase();
        const now = Date.now();
        const matches = users
            .filter(
                (u) =>
                    (!q ||
                        u.id === q ||
                        u.email.toLowerCase().startsWith(q) ||
                        !!u.username?.toLowerCase().startsWith(q)) &&
                    matchesFilters(u, filters, now),
            )
            .sort(compareUsers(sort ?? { sort: 'created', order: 'desc' }));
        const summary = {
            computedAt,
            accounts: matches.length,
            usedBytes: 0,
            quotaBytes: 0,
            active30d: 0,
            platforms: {} as Partial<Record<Platform, number>>,
        };
        for (const u of matches) {
            summary.usedBytes += u.usedBytes ?? 0;
            summary.quotaBytes += u.quotaBytes ?? 0;
            if (u.lastSeenAt && now - Date.parse(u.lastSeenAt) <= 30 * DAY_MS) summary.active30d++;
            for (const p of u.platforms) summary.platforms[p] = (summary.platforms[p] ?? 0) + 1;
        }
        const end = start + USER_PAGE;
        return {
            items: matches.slice(start, end).map(({ hasProfile: _h, raisedQuota: _r, ...u }) => u),
            nextCursor: end < matches.length ? String(end) : null,
            summary,
        };
    }
    private withProfiles(users: DirectoryUser[]) {
        return Promise.all(
            users.map(async (user) => {
                const profile = await this.profile(user.id);
                return {
                    ...user,
                    username: profile?.username ?? user.username,
                    displayName: profile?.displayName ?? user.displayName,
                    quotaBytes: profile?.storageQuotaBytes ?? null,
                    usedBytes: profile?.storageUsedBytes ?? null,
                    suspended: !!profile?.suspendedAt,
                    deleted: !!profile?.deletedAt,
                    ...(await this.deviceActivity(user.id)),
                };
            }),
        );
    }
    /** The platforms an account has signed in from and when any of its devices was last seen. */
    private async deviceActivity(userId: string) {
        const sessions = await new Transaction(this.repo).list<{ platform?: Platform; lastSeenAt?: string | null; }>(
            userPK(userId),
            'DEVICE#',
        );
        const platforms = new Set<Platform>();
        let lastSeenAt: string | null = null;
        for (const s of sessions) {
            if (s.platform && PLATFORMS.has(s.platform)) platforms.add(s.platform);
            if (s.lastSeenAt && (!lastSeenAt || s.lastSeenAt > lastSeenAt)) lastSeenAt = s.lastSeenAt;
        }
        return { platforms: [...platforms].sort(), lastSeenAt };
    }
    private fromProfile(profile: Account): DirectoryUser {
        return {
            id: profile.id,
            email: profile.email,
            username: profile.username,
            displayName: profile.displayName,
            status: 'UNKNOWN',
            enabled: false,
            createdAt: profile.createdAt,
        };
    }
    private adminProfile(account: Account): AdminProfile {
        return {
            username: account.username,
            displayName: account.displayName,
            createdAt: account.createdAt,
            updatedAt: account.updatedAt,
            deletedAt: account.deletedAt ?? null,
            purgeAt: account.purgeAt ?? null,
            suspendedAt: account.suspendedAt ?? null,
            suspendedReason: account.suspendedReason ?? null,
            storage: {
                ...storageUsage(account),
                trashBytes: account.trashBytes ?? 0,
                purgingBytes: account.purgingBytes ?? 0,
            },
        };
    }
    /** The account as staff see it; `null` when it exists in neither the directory nor the table. */
    async detail(userId: string): Promise<Omit<AdminUserDetail, 'flags' | 'email'>> {
        const [directoryUser, account] = await Promise.all([
            this.directory.get(userId),
            this.profile(userId),
        ]);
        assert(directoryUser || account, 'USER_NOT_FOUND', 'No account has this ID.', 404);
        const [devices, backups, activity] = account
            ? await Promise.all([
                this.service.devices(userId),
                new Transaction(this.repo).list<BackupRoot>(userPK(userId), 'BACKUP#'),
                this.repo.query(userAudit(userId), '', 50),
            ])
            : [{ items: [] }, [], await this.repo.query(userAudit(userId), '', 50)];
        return {
            account: directoryUser ?? this.fromProfile(account!),
            profile: account ? this.adminProfile(account) : null,
            devices: devices.items,
            backupCount: backups.filter((b) => b.state !== 'REMOVED').length,
            activity: activity.rows.map((r) => r.data as AuditEntry),
            sameDevice: account ? await this.sameDevice(userId) : [],
        };
    }
    /** Other accounts that signed in with any device key this account has proved. */
    private async sameDevice(userId: string) {
        const keys = await new Transaction(this.repo).list<{ fingerprint: string }>(
            userPK(userId),
            'DEVICE_KEY#',
        );
        const fingerprints = [...new Set(keys.map((k) => k.fingerprint))];
        const others = new Map<string, DeviceAccount>();
        for (const fingerprint of fingerprints)
            for (const a of await accountsOnDevice(this.repo, fingerprint))
                if (a.userId !== userId && !others.has(a.userId)) others.set(a.userId, a);
        return Promise.all(
            [...others.values()]
                .sort((a, b) => a.boundAt.localeCompare(b.boundAt))
                .map(async (a) => {
                    const profile = await this.profile(a.userId);
                    return {
                        ...a,
                        suspended: !!profile?.suspendedAt,
                        deleted: !!profile?.deletedAt,
                    };
                }),
        );
    }
    private async live(userId: string) {
        const user = await this.directory.get(userId);
        assert(user, 'USER_NOT_FOUND', 'This sign-in account no longer exists.', 404);
        return user;
    }

    async setQuota(staff: Staff, userId: string, quotaBytes: number, reason: string) {
        return transact(this.repo, async (tx) => {
            const account = await tx.get<Account>(userPK(userId), 'PROFILE');
            assert(
                account,
                'USER_NOT_FOUND',
                'This person has not finished signing up, so there is no storage to change yet.',
                404,
            );
            assert(!account.deletedAt, 'ACCOUNT_DELETED', 'This account was deleted.', 409);
            const previous = account.storageQuotaBytes;
            account.storageQuotaBytes = quotaBytes;
            account.updatedAt = new Date().toISOString();
            await tx.put(userPK(userId), 'PROFILE', account);
            // Signed-in apps see the new limit through the sync feed without reloading.
            await this.service.record(tx, userId, 'PROFILE_UPDATED', userId);
            // Allocated storage changed, so the next overview recomputes the totals.
            await tx.delete('ADMIN_STATS', 'STORAGE');
            await this.audit(tx, staff, {
                action: 'QUOTA_CHANGED',
                userId,
                userEmail: account.email,
                reason,
                details: { previousBytes: previous, quotaBytes },
            });
            return { storage: storageUsage(account) };
        });
    }

    async resetPassword(staff: Staff, userId: string, reason: string) {
        const user = await this.live(userId);
        assert(
            user.status === 'CONFIRMED' || user.status === 'RESET_REQUIRED',
            'INVALID_STATE',
            'Only verified accounts can reset their password. Resend the verification email instead.',
            409,
        );
        await this.directory.resetPassword(userId);
        await this.record(staff, { action: 'PASSWORD_RESET', userId, userEmail: user.email, reason });
        return { sent: true };
    }
    async resendVerification(staff: Staff, userId: string, reason: string) {
        const user = await this.live(userId);
        assert(user.status === 'UNCONFIRMED', 'INVALID_STATE', 'This email is already verified.', 409);
        await this.directory.resendVerification(userId);
        await this.record(staff, {
            action: 'VERIFICATION_RESENT',
            userId,
            userEmail: user.email,
            reason,
        });
        return { sent: true };
    }
    async confirm(staff: Staff, userId: string, reason: string) {
        const user = await this.live(userId);
        assert(user.status === 'UNCONFIRMED', 'INVALID_STATE', 'This email is already verified.', 409);
        await this.directory.confirm(userId);
        await this.record(staff, { action: 'EMAIL_CONFIRMED', userId, userEmail: user.email, reason });
        return { confirmed: true };
    }
    async signOut(staff: Staff, userId: string, reason: string) {
        const user = await this.live(userId);
        await this.directory.signOut(userId);
        const account = await this.profile(userId);
        const sessions = account ? await this.service.signOutAll(userId) : 0;
        await transact(this.repo, (tx) =>
            this.service.email(tx, `signed-out-${userId}-${Date.now()}`, {
                template: 'SIGNED_OUT',
                to: user.email,
                name: account?.displayName ?? '',
            }),
        );
        await this.record(staff, {
            action: 'SIGNED_OUT_EVERYWHERE',
            userId,
            userEmail: user.email,
            reason,
            details: { sessions },
        });
        return { sessions };
    }
    async signOutDevice(staff: Staff, userId: string, deviceId: string, reason: string) {
        const account = await this.profile(userId);
        assert(account, 'USER_NOT_FOUND', 'No account has this ID.', 404);
        const { device } = await this.service.signOutDevice(userId, deviceId);
        await transact(this.repo, (tx) =>
            this.service.email(tx, `signed-out-${deviceId}-${Date.now()}`, {
                template: 'SIGNED_OUT',
                to: account.email,
                name: account.displayName,
                device: device.name,
            }),
        );
        await this.record(staff, {
            action: 'DEVICE_SIGNED_OUT',
            userId,
            userEmail: account.email,
            reason,
            details: { deviceId, deviceName: device.name },
        });
        return { device };
    }
    /** Blocks the account at once (API and sign-in) without touching its files. */
    async suspend(staff: Staff, userId: string, reason: string, notify = true) {
        const user = await this.live(userId);
        await transact(this.repo, async (tx) => {
            const account = await tx.get<Account>(userPK(userId), 'PROFILE');
            if (account) {
                assert(!account.suspendedAt, 'INVALID_STATE', 'This account is already suspended.', 409);
                account.suspendedAt = new Date().toISOString();
                account.suspendedReason = reason;
                await tx.put(userPK(userId), 'PROFILE', account);
            }
            // The notice never includes the staff reason, which stays internal.
            if (notify)
                await this.service.email(tx, `suspended-${userId}-${Date.now()}`, {
                    template: 'ACCOUNT_SUSPENDED',
                    to: user.email,
                    name: account?.displayName ?? '',
                });
            await this.audit(tx, staff, {
                action: 'SUSPENDED',
                userId,
                userEmail: user.email,
                reason,
                details: { notified: notify },
            });
        });
        await this.directory.setEnabled(userId, false);
        await this.directory.signOut(userId);
        if (await this.profile(userId)) await this.service.signOutAll(userId);
        return { suspended: true };
    }
    async unsuspend(staff: Staff, userId: string, reason: string) {
        const user = await this.live(userId);
        await this.directory.setEnabled(userId, true);
        await transact(this.repo, async (tx) => {
            const account = await tx.get<Account>(userPK(userId), 'PROFILE');
            if (account?.suspendedAt) {
                delete account.suspendedAt;
                delete account.suspendedReason;
                await tx.put(userPK(userId), 'PROFILE', account);
            }
            await this.audit(tx, staff, {
                action: 'UNSUSPENDED',
                userId,
                userEmail: user.email,
                reason,
            });
        });
        return { suspended: false };
    }
    /**
     * Deletes the account the way a user's own deletion does: files are purged after the grace
     * period, the email and username are released, and the sign-in account is removed now.
     */
    async deleteAccount(
        staff: Staff,
        userId: string,
        confirmEmail: string,
        reason: string,
        closedBy: { reason: StaffDeletionReason; notify: boolean } = {
            reason: 'OTHER',
            notify: true,
        },
    ) {
        const [user, account] = await Promise.all([this.directory.get(userId), this.profile(userId)]);
        const email = user?.email ?? account?.email;
        assert(email, 'USER_NOT_FOUND', 'No account has this ID.', 404);
        assert(
            normalizeEmail(confirmEmail) === normalizeEmail(email),
            'VALIDATION_ERROR',
            "Type the account's email address to confirm.",
        );
        let purgeAt: string | null = account?.purgeAt ?? null;
        if (account && !account.deletedAt)
            ({ purgeAt } = await this.service.deleteAccount(
                userId,
                { operationId: randomUUID(), email: account.email },
                closedBy,
            ));
        if (user) await this.directory.delete(userId);
        await transact(this.repo, (tx) => tx.delete('ADMIN_STATS', 'STORAGE'));
        await this.record(staff, {
            action: 'ACCOUNT_DELETED',
            userId,
            userEmail: email,
            reason,
            details: { purgeAt, category: closedBy.reason, notified: closedBy.notify },
        });
        return { deleted: true, purgeAt };
    }
    /**
     * Ends the grace period of every deleted account now: each account's purge job falls due at
     * once, and the background worker (which, unlike the console, can reach file storage) removes
     * its files within a minute or so. Cannot be undone.
     */
    async purgeDeletedAccounts(staff: Staff, reason: string) {
        const at = new Date().toISOString();
        const waiting = (await this.repo.scanProfiles()).filter(
            (p) => p.id && p.deletedAt && p.purgeAt && p.purgeAt > at,
        );
        let accounts = 0;
        let usedBytes = 0;
        for (const p of waiting) {
            const purged = await transact(this.repo, async (tx) => {
                const account = await tx.get<Account>(userPK(p.id!), 'PROFILE');
                if (!account?.deletedAt || !account.purgeAt || account.purgeAt <= at) return false;
                const previous = account.purgeAt;
                account.purgeAt = at;
                account.updatedAt = at;
                await tx.put(userPK(p.id!), 'PROFILE', account);
                const job = await tx.get<Job>('JOB', `account-${p.id}`);
                if (job) await this.service.job(tx, { ...job, dueAt: at });
                await this.audit(tx, staff, {
                    action: 'ACCOUNT_PURGED',
                    userId: p.id,
                    userEmail: account.email,
                    reason,
                    details: { previousPurgeAt: previous, usedBytes: account.storageUsedBytes ?? 0 },
                });
                return true;
            });
            if (!purged) continue;
            accounts++;
            usedBytes += p.storageUsedBytes ?? 0;
        }
        if (accounts) await transact(this.repo, (tx) => tx.delete('ADMIN_STATS', 'STORAGE'));
        return { accounts, usedBytes };
    }
    async note(staff: Staff, userId: string, text: string) {
        const [user, account] = await Promise.all([this.directory.get(userId), this.profile(userId)]);
        const email = user?.email ?? account?.email;
        assert(email, 'USER_NOT_FOUND', 'No account has this ID.', 404);
        return this.record(staff, { action: 'NOTE', userId, userEmail: email, details: { text } });
    }
}
