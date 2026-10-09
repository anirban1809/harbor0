import type {
  AdminUserFilters,
  AdminUserListItem,
  DirectoryUser,
} from '../../../packages/contracts/src/admin';
import type { DeviceSighting, ProfileStorage, Repository } from './repository';

/**
 * The console user list's filters, shared by the list itself and by dynamic email groups,
 * which the job worker works out from the table alone when a campaign sends.
 */
export type Platform = AdminUserListItem['platforms'][number];
const DAY_MS = 86400_000;
const MOBILE = new Set<Platform>(['IOS', 'ANDROID']);
const DESKTOP = new Set<Platform>(['MACOS', 'WINDOWS', 'LINUX']);
export const PLATFORMS = new Set<string>(['WEB', 'MACOS', 'WINDOWS', 'LINUX', 'IOS', 'ANDROID']);

/** An indexed account: its list row plus what the filters need that the row does not show. */
export type IndexedUser = AdminUserListItem & { hasProfile: boolean; raisedQuota: boolean };

/**
 * Whether `at` falls in a filter's window: within the last N days (`14d`), more than N days
 * ago (`inactive-45d`, `older-180d`), or never. No window passes everything.
 */
function inWindow(at: string | null, window: string | undefined, now: number) {
  if (!window) return true;
  if (window === 'never') return !at;
  if (!at) return false;
  const age = now - Date.parse(at);
  const limit = Number(/(\d+)d$/.exec(window)?.[1] ?? 0) * DAY_MS;
  return /^(inactive|older)-/.test(window) ? age > limit : age <= limit;
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
  const [storage, amount] = filters.storage?.split('-') ?? [];
  if (storage === 'empty' && used > 0) return false;
  if (storage === 'uploaded' && used === 0) return false;
  if (storage === 'over' && share * 100 < Number(amount)) return false;
  if (storage === 'gb' && used < Number(amount) * 1e9) return false;
  if (filters.quota === 'raised' && !user.raisedQuota) return false;
  if (filters.quota === 'standard' && (user.raisedQuota || !user.hasProfile)) return false;
  if (!inWindow(user.lastSeenAt, filters.seen, now)) return false;
  if (!inWindow(user.createdAt, filters.joined, now)) return false;
  return true;
}

/** The accounts whose email or username starts with `query` (or whose ID it is) and that pass `filters`. */
export function matchUsers(
  users: IndexedUser[],
  query: string,
  filters: AdminUserFilters,
  now = Date.now(),
) {
  const q = query.trim().toLowerCase();
  return users.filter(
    (u) =>
      (!q ||
        u.id === q ||
        u.email.toLowerCase().startsWith(q) ||
        !!u.username?.toLowerCase().startsWith(q)) &&
      matchesFilters(u, filters, now),
  );
}

/**
 * Every account with what the filters read. With the sign-in `directory`, those are its
 * accounts plus deleted ones' tombstone profiles. Without it (the job worker), every profile:
 * accounts that never signed in are missing, and sign-in status comes from the profile.
 */
export function indexAccounts(
  profiles: ProfileStorage[],
  devices: DeviceSighting[],
  directory?: DirectoryUser[],
): IndexedUser[] {
  const seen = new Map<string, { platforms: Set<Platform>; lastSeenAt: string | null }>();
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
    const activity = seen.get(user.id);
    return {
      ...user,
      username: p?.username ?? user.username,
      displayName: p?.displayName ?? user.displayName,
      quotaBytes: p?.storageQuotaBytes ?? null,
      usedBytes: p?.storageUsedBytes ?? null,
      suspended: !!p?.suspendedAt,
      deleted: !!p?.deletedAt || (!hasSignIn && !!p),
      platforms: [...(activity?.platforms ?? [])].sort(),
      lastSeenAt: activity?.lastSeenAt ?? null,
      hasProfile: !!p,
      raisedQuota: !!p?.freeQuotaBytes && (p.storageQuotaBytes ?? 0) > p.freeQuotaBytes,
    };
  };
  const fromProfile = (p: ProfileStorage): DirectoryUser => ({
    id: p.id!,
    email: p.email ?? '',
    username: p.username ?? null,
    displayName: p.displayName ?? null,
    status: directory ? 'UNKNOWN' : p.emailVerified === false ? 'UNCONFIRMED' : 'CONFIRMED',
    enabled: directory ? false : !p.suspendedAt,
    createdAt: p.createdAt ?? null,
  });
  if (!directory) return profiles.filter((p) => p.id).map((p) => row(fromProfile(p), !p.deletedAt));
  const users = directory.map((u) => row(u, true));
  const signIns = new Set(directory.map((u) => u.id));
  // Deleted accounts keep a tombstone profile after leaving the directory.
  for (const p of profiles)
    if (p.id && p.deletedAt && !signIns.has(p.id)) users.push(row(fromProfile(p), false));
  return users;
}

/** The accounts a dynamic group follows now, read from the table alone. */
export async function profileMatches(
  repo: Repository,
  rule: { q: string; filters: AdminUserFilters },
) {
  const [profiles, devices] = await Promise.all([repo.scanProfiles(), repo.scanDevices()]);
  return matchUsers(indexAccounts(profiles, devices), rule.q, rule.filters);
}
