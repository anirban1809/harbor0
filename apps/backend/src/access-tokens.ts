import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { AccessToken, AccessTokenScope, Device, Identity } from '@harbor/contracts';
import type { Account } from './domain';
import { assert, DomainError } from './errors';
import { Transaction, transact, type Repository } from './repository';

/**
 * Personal access tokens let tools such as rclone use the API without a sign-in. Each token is a
 * device of its own (platform `CLI`), so the usual device check, sign-out and removal apply to it.
 * Only a SHA-256 of the secret is stored.
 */
export const TOKEN_PREFIX = 'h0_pat_';
export const MAX_TOKENS = 20;
// The account's last-used time is written at most this often, to keep writes down.
const TOUCH_MS = 3600_000;
// A token's account details are reread at most this often; revocation is still checked on every
// request through the token's device row.
const CACHE_MS = 60_000;
const CACHE_SIZE = 1000;

/** Global lookup row, found by the secret's hash. */
type TokenIndex = {
  userId: string;
  deviceId: string;
  scope: AccessTokenScope;
  expiresAt: string | null;
  revokedAt: string | null;
};
/** The account's own row for listing, kept beside its devices. */
type TokenRecord = AccessToken & { tokenHash: string; revokedAt: string | null };

const now = () => new Date().toISOString();
const userPK = (id: string) => `USER#${id}`;
const indexKey = (hash: string) => ({ pk: `PAT#${hash}`, sk: 'PAT' });
const recordKey = (deviceId: string) => `ACCESS_TOKEN#${deviceId}`;
export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
export const isAccessToken = (bearer: string) => bearer.startsWith(TOKEN_PREFIX);
const expired = (expiresAt: string | null) => !!expiresAt && expiresAt <= now();
// Rows are kept a while after they stop working, so a revoked token still gets a clear answer.
const ttl = (until: string | null) =>
  until ? { expiresAt: Math.floor(Date.parse(until) / 1000) + 30 * 86400 } : {};
const invalid = () =>
  new DomainError(
    'AUTH_INVALID',
    'This access token is not valid. It may have expired or been revoked; create a new one in Settings.',
    401,
  );

export type TokenIdentity = { identity: Identity; scope: AccessTokenScope };

export class AccessTokens {
  private cache = new Map<string, { value: TokenIdentity; until: number }>();
  private touched = new Map<string, number>();
  constructor(private repo: Repository) {}

  /** Creates a token and its device. The secret is returned here and never again. */
  async create(
    userId: string,
    input: { name: string; scope: AccessTokenScope; expiresInDays: number | null },
  ) {
    const active = (await this.list(userId)).length;
    assert(
      active < MAX_TOKENS,
      'TOKEN_LIMIT',
      `You can have up to ${MAX_TOKENS} access tokens. Revoke one you no longer use.`,
      409,
    );
    const token = TOKEN_PREFIX + randomBytes(32).toString('base64url');
    const hash = tokenHash(token);
    const id = randomUUID();
    const createdAt = now();
    const expiresAt = input.expiresInDays
      ? new Date(Date.now() + input.expiresInDays * 86400_000).toISOString()
      : null;
    const record: TokenRecord = {
      id,
      name: input.name,
      scope: input.scope,
      createdAt,
      expiresAt,
      lastUsedAt: null,
      tokenHash: hash,
      revokedAt: null,
    };
    await transact(this.repo, async (tx) => {
      const key = indexKey(hash);
      await tx.put(
        key.pk,
        key.sk,
        {
          userId,
          deviceId: id,
          scope: input.scope,
          expiresAt,
          revokedAt: null,
        } satisfies TokenIndex,
        ttl(expiresAt),
      );
      await tx.put(userPK(userId), recordKey(id), record, ttl(expiresAt));
      const device: Device = {
        id,
        userId,
        name: input.name,
        platform: 'CLI',
        appVersion: null,
        devicePublicId: null,
        keyFingerprint: null,
        lastSeenAt: null,
        createdAt,
        revokedAt: null,
      };
      await tx.put(userPK(userId), `DEVICE#${id}`, { ...device, revocationVersion: 0 });
    });
    // Not `accessToken`: the web session proxy strips fields with that name from responses.
    return { token, item: this.view(record) };
  }

  /** Tokens that still work: not revoked, not expired, and their device not signed out. */
  async list(userId: string): Promise<AccessToken[]> {
    const tx = new Transaction(this.repo);
    const records = await tx.list<TokenRecord>(userPK(userId), 'ACCESS_TOKEN#');
    const live = await Promise.all(
      records.map(async (record) => {
        if (record.revokedAt || expired(record.expiresAt)) return null;
        const device = await tx.get<Device>(userPK(userId), `DEVICE#${record.id}`);
        return device && !device.revokedAt ? this.view(record, device) : null;
      }),
    );
    return live
      .filter((token): token is AccessToken => !!token)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Revokes the token and removes its device, at once. */
  async revoke(userId: string, id: string) {
    await transact(this.repo, async (tx) => {
      const record = await tx.get<TokenRecord>(userPK(userId), recordKey(id));
      assert(record, 'TOKEN_NOT_FOUND', 'Access token was not found.', 404);
      if (record.revokedAt) return;
      const at = now();
      const key = indexKey(record.tokenHash);
      const index = await tx.get<TokenIndex>(key.pk, key.sk);
      if (index) await tx.put(key.pk, key.sk, { ...index, revokedAt: at }, ttl(at));
      await tx.put(userPK(userId), recordKey(id), { ...record, revokedAt: at }, ttl(at));
      const device = await tx.get<Device>(userPK(userId), `DEVICE#${id}`);
      if (device)
        await tx.put(userPK(userId), `DEVICE#${id}`, {
          ...device,
          revokedAt: device.revokedAt ?? at,
          revoked: true,
        });
    });
    this.cache.clear();
  }

  /**
   * The account a token acts for. The caller still runs the usual profile and device checks,
   * which reject deleted or suspended accounts and tokens whose device was signed out.
   */
  async identity(token: string): Promise<TokenIdentity> {
    const hash = tokenHash(token);
    const cached = this.cache.get(hash);
    if (cached && cached.until > Date.now()) return cached.value;
    this.cache.delete(hash);
    const key = indexKey(hash);
    const index = (await this.repo.get(key))?.data as TokenIndex | undefined;
    if (!index || index.revokedAt || expired(index.expiresAt)) throw invalid();
    const account = (await this.repo.get({ pk: userPK(index.userId), sk: 'PROFILE' }))?.data as
      Account | undefined;
    if (!account) throw invalid();
    const value: TokenIdentity = {
      identity: {
        id: index.userId,
        email: account.email,
        emailVerified: true,
        username: account.username,
        displayName: account.displayName,
        deviceId: index.deviceId,
        sessionId: `pat:${index.deviceId}`,
      },
      scope: index.scope,
    };
    if (this.cache.size >= CACHE_SIZE) this.cache.delete(this.cache.keys().next().value!);
    const until = index.expiresAt
      ? Math.min(Date.parse(index.expiresAt), Date.now() + CACHE_MS)
      : Date.now() + CACHE_MS;
    this.cache.set(hash, { value, until });
    return value;
  }

  /** Notes that the token was used, at most once an hour. Never fails the request. */
  async touch(userId: string, id: string, appVersion: string | null) {
    // Most requests stop here, without a database read.
    if (Date.now() - (this.touched.get(id) ?? 0) < TOUCH_MS) return;
    if (this.touched.size >= CACHE_SIZE) this.touched.delete(this.touched.keys().next().value!);
    this.touched.set(id, Date.now());
    try {
      await transact(this.repo, async (tx) => {
        const record = await tx.get<TokenRecord>(userPK(userId), recordKey(id));
        if (!record || record.revokedAt) return;
        const last = record.lastUsedAt ? Date.parse(record.lastUsedAt) : 0;
        if (Date.now() - last < TOUCH_MS) return;
        const at = now();
        await tx.put(
          userPK(userId),
          recordKey(id),
          { ...record, lastUsedAt: at },
          ttl(record.expiresAt),
        );
        const device = await tx.get<Device>(userPK(userId), `DEVICE#${id}`);
        if (device && !device.revokedAt)
          await tx.put(userPK(userId), `DEVICE#${id}`, {
            ...device,
            lastSeenAt: at,
            appVersion: appVersion ?? device.appVersion,
          });
      });
    } catch (error) {
      console.warn(JSON.stringify({ event: 'access_token_touch_failed', error: String(error) }));
    }
  }

  private view(record: TokenRecord, device?: Device): AccessToken {
    return {
      id: record.id,
      name: record.name,
      scope: record.scope,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      lastUsedAt: record.lastUsedAt ?? device?.lastSeenAt ?? null,
    };
  }
}

/** rclone and similar tools say who they are in the User-Agent, e.g. `rclone/v1.75.2`. */
export function toolVersion(userAgent: string | undefined) {
  const match = userAgent?.match(/^([A-Za-z0-9_.-]+)\/(v?[0-9][A-Za-z0-9_.+-]*)/);
  return match ? `${match[1]}/${match[2]}`.slice(0, 64) : null;
}
