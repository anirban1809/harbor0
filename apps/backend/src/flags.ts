import { createHash } from 'node:crypto';
import {
  defaultFlagRule,
  flagKeys,
  type Device,
  type FlagClient,
  type FlagKey,
  type FlagReason,
  type FlagRule,
  type FlagStates,
} from '@harbor/contracts';
import type { Repository } from './repository';

/** A flag's stored rule, with who changed it last. */
export type StoredFlag = FlagRule & {
  key: FlagKey;
  /** Emails of `userIds` when they were added, for the console only. */
  userEmails: Record<string, string>;
  updatedAt: string | null;
  updatedBy: string | null;
};
type Client = Pick<Device, 'platform' | 'appVersion'> | undefined;

export const FLAG_PK = 'FLAG';
// Flags change rarely; each API instance rereads them at most this often.
export const FLAG_CACHE_MS = 30_000;

export const emptyFlag = (key: FlagKey): StoredFlag => ({
  key,
  ...defaultFlagRule(),
  userEmails: {},
  updatedAt: null,
  updatedBy: null,
});

/** The account's fixed place, 0–99, in a flag's percentage rollout. */
export function bucket(key: string, userId: string) {
  return createHash('sha256').update(`${key}:${userId}`).digest().readUInt32BE(0) % 100;
}
function family(platform: Device['platform']): FlagClient | null {
  if (platform === 'IOS') return 'IOS';
  if (platform === 'ANDROID') return 'ANDROID';
  if (platform === 'WEB') return null;
  return 'DESKTOP';
}
/** Whether `version` is at least `min`, comparing dotted numbers; a missing version is too old. */
export function atLeast(version: string | null | undefined, min: string) {
  const parts = (v: string) => v.split(/[.+-]/).map((p) => Number.parseInt(p, 10) || 0);
  if (!version) return false;
  const a = parts(version);
  const b = parts(min);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d > 0;
  }
  return true;
}

/**
 * Decides one flag for one account. `client` is the calling app; without one (the console
 * asking about the account as a whole) app versions are not considered.
 */
export function decide(flag: StoredFlag, userId: string, client?: Client): FlagReason {
  if (flag.mode === 'OFF') return 'OFF';
  const fam = client ? family(client.platform) : null;
  const min = fam ? flag.minVersions[fam] : undefined;
  if (min && !atLeast(client?.appVersion, min)) return 'APP_TOO_OLD';
  if (flag.mode === 'ON') return 'EVERYONE';
  if (flag.userIds.includes(userId)) return 'ALLOWLIST';
  return bucket(flag.key, userId) < flag.percent ? 'PERCENT' : 'NOT_SELECTED';
}
export const isOn = (reason: FlagReason) =>
  reason === 'ALLOWLIST' || reason === 'PERCENT' || reason === 'EVERYONE';

/** Reads flag rules, keeping them in memory briefly so checks cost no database read. */
export class FeatureFlags {
  private cached: { at: number; flags: Promise<Map<FlagKey, StoredFlag>> } | undefined;
  constructor(
    private repo: Repository,
    private maxAgeMs = FLAG_CACHE_MS,
  ) {}
  /** Every defined flag, stored or not; rules for flags no longer defined are ignored. */
  all(): Promise<Map<FlagKey, StoredFlag>> {
    if (this.cached && Date.now() - this.cached.at < this.maxAgeMs) return this.cached.flags;
    const flags = this.load();
    this.cached = { at: Date.now(), flags };
    // A failed read is not remembered, so the next check tries again.
    flags.catch(() => (this.cached = undefined));
    return flags;
  }
  /** Forgets the cached rules, after this instance changes one. */
  invalidate() {
    this.cached = undefined;
  }
  private async load() {
    const stored = new Map<string, StoredFlag>();
    let cursor: string | undefined;
    do {
      const page = await this.repo.query(FLAG_PK, '', 100, cursor);
      for (const row of page.rows) stored.set(row.sk, row.data as StoredFlag);
      cursor = page.cursor ?? undefined;
    } while (cursor);
    return new Map(flagKeys().map((key) => [key, { ...emptyFlag(key), ...stored.get(key), key }]));
  }
  async enabled(key: FlagKey, userId: string, client?: Client) {
    const flag = (await this.all()).get(key)!;
    return isOn(decide(flag, userId, client));
  }
  /** Every flag's state for this account on this app. */
  async states(userId: string, client?: Client): Promise<FlagStates> {
    const states: FlagStates = {};
    for (const [key, flag] of await this.all()) states[key] = isOn(decide(flag, userId, client));
    return states;
  }
}

// One reader per table, so a change made through the console in the same process (local
// development and tests) is seen at once; separate Lambdas see it within FLAG_CACHE_MS.
const readers = new WeakMap<Repository, FeatureFlags>();
export function featureFlagsFor(repo: Repository) {
  let reader = readers.get(repo);
  if (!reader) readers.set(repo, (reader = new FeatureFlags(repo)));
  return reader;
}
