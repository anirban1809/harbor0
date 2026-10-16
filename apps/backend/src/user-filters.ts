import type {
  AdminUserFilters,
  AdminUserListItem,
  DirectoryUser,
} from '../../../packages/contracts/src/admin';
import type { DeviceSighting, ProfileStorage, Repository, SetupSighting } from './repository';

/**
 * The console user list's filters, shared by the list itself and by dynamic email groups,
 * which the job worker works out from the table alone when a campaign sends.
 */
export type Platform = AdminUserListItem['platforms'][number];
const DAY_MS = 86400_000;
const HOUR_MS = 3600_000;
const MOBILE = new Set<Platform>(['IOS', 'ANDROID']);
const DESKTOP = new Set<Platform>(['MACOS', 'WINDOWS', 'LINUX']);
export const PLATFORMS = new Set<string>(['WEB', 'MACOS', 'WINDOWS', 'LINUX', 'IOS', 'ANDROID']);

/** An indexed account: its list row plus what the filters need that the row does not show. */
export type IndexedUser = AdminUserListItem & {
  hasProfile: boolean;
  raisedQuota: boolean;
  /** A signed-in desktop app syncs at least one folder. */
  desktopSync: boolean;
  /** A signed-in desktop app backs up at least one folder. */
  desktopBackup: boolean;
  /** End-to-end encryption is on (or still being turned off). */
  e2ee: boolean;
};

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

/**
 * Whether the latest usage `at` passes an activity filter: within N hours (`6h`) or days
 * (`7d`), none for more than N days (`inactive-7d`, which includes none at all), or `none`.
 */
function activityWindow(at: string | null, window: string | undefined, now: number) {
  if (!window) return true;
  if (window === 'none') return !at;
  const [, inactive, n, unit] = /^(inactive-)?(\d+)([hd])$/.exec(window) ?? [];
  const limit = Number(n) * (unit === 'h' ? HOUR_MS : DAY_MS);
  if (inactive) return !at || now - Date.parse(at) > limit;
  return !!at && now - Date.parse(at) <= limit;
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
  if (!activityWindow(user.lastActivityAt, filters.activity, now)) return false;
  const { desktopSync, desktopBackup } = user;
  if (filters.desktop === 'sync' && !desktopSync) return false;
  if (filters.desktop === 'backup' && !desktopBackup) return false;
  if (filters.desktop === 'either' && !desktopSync && !desktopBackup) return false;
  if (filters.desktop === 'neither' && (desktopSync || desktopBackup)) return false;
  if (filters.e2ee && user.e2ee !== (filters.e2ee === 'on')) return false;
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

// Backups that are on: running, or failing and retrying.
const BACKING_UP = new Set(['ACTIVE', 'ERROR']);

/**
 * Which accounts sync or back up folders from a signed-in desktop app. A device's sync folder
 * list is keyed by its installation (or, for old builds, its session); a backup names both.
 */
export function desktopSetups(devices: DeviceSighting[], setups: SetupSighting[]) {
  const desktops = new Map<string, Set<string>>();
  for (const d of devices) {
    const platform = d.platform as Platform | undefined;
    if (!d.userId || !platform || !DESKTOP.has(platform)) continue;
    if (d.revokedAt || d.status === 'REVOKED' || d.status === 'SIGNED_OUT') continue;
    const keys = desktops.get(d.userId) ?? desktops.set(d.userId, new Set()).get(d.userId)!;
    if (d.id) keys.add(`session:${d.id}`);
    if (d.devicePublicId) keys.add(`installation:${d.devicePublicId}`);
  }
  const result = new Map<string, { sync: boolean; backup: boolean }>();
  for (const s of setups) {
    const keys = desktops.get(s.userId);
    if (!keys) continue;
    const entry =
      result.get(s.userId) ?? result.set(s.userId, { sync: false, backup: false }).get(s.userId)!;
    if (s.kind === 'SYNC' && s.folderCount > 0 && keys.has(s.key)) entry.sync = true;
    if (
      s.kind === 'BACKUP' &&
      BACKING_UP.has(s.state ?? '') &&
      ((s.deviceId && keys.has(`session:${s.deviceId}`)) ||
        (s.devicePublicId && keys.has(`installation:${s.devicePublicId}`)))
    )
      entry.backup = true;
  }
  return result;
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
  setups: SetupSighting[] = [],
): IndexedUser[] {
  const desktop = desktopSetups(devices, setups);
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
      lastActivityAt: null,
      lastAction: null,
      hasProfile: !!p,
      raisedQuota: !!p?.freeQuotaBytes && (p.storageQuotaBytes ?? 0) > p.freeQuotaBytes,
      desktopSync: !!desktop.get(user.id)?.sync,
      desktopBackup: !!desktop.get(user.id)?.backup,
      e2ee: !!p?.e2ee?.enabledAt,
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
  const [profiles, { devices, setups }] = await Promise.all([
    repo.scanProfiles(),
    repo.scanSetups(),
  ]);
  return matchUsers(indexAccounts(profiles, devices, undefined, setups), rule.q, rule.filters);
}
