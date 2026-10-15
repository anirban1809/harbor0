import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import {
  FREE_QUOTA,
  PUBLIC_LINK_EXECUTABLE_MIN_AGE_DAYS,
  PUBLIC_LINK_LIMIT,
  PUBLIC_LINK_MIN_ACCOUNT_AGE_DAYS,
  isExecutableName,
  type DriveItem,
  type FileVersion,
  type PublicItem,
  type PublicLink,
} from '@harbor/contracts';
import type { Account, StorageService, StoredObject } from './domain';
import { encryptedAccount } from './e2ee';
import { assert, DomainError } from './errors';
import { Transaction, transact } from './repository';

/**
 * Public links: anyone with the link can view and download a file, or the files in a folder and
 * its subfolders, without an account. A link points at the item itself, not a version, so it
 * shows the latest content, holds no storage of its own, and stops working when the item is
 * trashed. The token is the only secret; lookups go through a row keyed by its SHA-256.
 *
 * The owner's own row keeps the token so the link can be copied again later, like the links of
 * other drives. Taking a link down (owner revokes it, staff disable it, the account is deleted
 * or suspended, the item is trashed, the link expires) stops it at the next request.
 */

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  length: number,
) => Promise<Buffer>;
const now = () => new Date().toISOString();
const userPK = (id: string) => `USER#${id}`;
const DAY_MS = 86400_000;
// Folders nest at most 32 deep (see domain.ts), so a walk up from any item ends by then.
const MAX_DEPTH = 33;
export const linkHash = (token: string) => createHash('sha256').update(token).digest('hex');
const indexKey = (hash: string) => ({ pk: `PUBLIC_LINK#${hash}`, sk: 'LINK' });
const recordKey = (id: string) => `PUBLIC_LINK#${id}`;
// Rows stay a month after a link stops working, so its page can say so instead of "not found".
const ttl = (until: string | null) =>
  until ? { expiresAt: Math.floor(Date.parse(until) / 1000) + 30 * 86400 } : {};

/** Global lookup row, found by the token's hash. */
type LinkIndex = {
  linkId: string;
  ownerId: string;
  driveItemId: string;
  passwordHash: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  disabledAt: string | null;
};
/** The owner's row, for listing and copying the link again. */
type LinkRecord = Omit<PublicLink, 'url' | 'itemName' | 'hasPassword'> & {
  token: string;
  passwordHash: string | null;
  revokedAt: string | null;
};
/** A link that works, with everything a visitor's request needs. */
type Resolved = { index: LinkIndex; hash: string; owner: Account; root: DriveItem };

const ageDays = (account: Account) => (Date.now() - Date.parse(account.createdAt)) / DAY_MS;
const paid = (account: Account) =>
  account.storageQuotaBytes > (account.freeQuotaBytes ?? FREE_QUOTA);
const expired = (expiresAt: string | null) => !!expiresAt && expiresAt <= now();
const gone = () =>
  new DomainError(
    'LINK_NOT_FOUND',
    "This link doesn't work. It may have been turned off, or what it shared was removed.",
    404,
  );

async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, 32);
  return `scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}
async function passwordMatches(password: string, stored: string) {
  const [, salt, hash] = stored.split('$');
  const expected = Buffer.from(hash, 'base64url');
  const actual = await scryptAsync(password, Buffer.from(salt, 'base64url'), expected.length);
  return timingSafeEqual(actual, expected);
}
/**
 * What a correct password buys: a pass derived from the stored password hash, which only the
 * server knows. It stays valid until the link's password changes, so nothing is stored for it.
 */
const passFor = (index: LinkIndex, hash: string) =>
  createHash('sha256').update(`link-pass:${index.passwordHash}:${hash}`).digest('base64url');
const passMatches = (index: LinkIndex, hash: string, pass?: string) => {
  if (!index.passwordHash) return true;
  if (!pass) return false;
  const expected = Buffer.from(passFor(index, hash));
  const actual = Buffer.from(pass);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};

export class PublicLinks {
  constructor(
    private service: StorageService,
    /** Where link pages are served, e.g. https://harbor0content.online. */
    private origin: string,
  ) {}
  private get repo() {
    return this.service.repo;
  }
  private url(token: string) {
    return `${this.origin}/s#${token}`;
  }

  /** Whether the account may make links now, and how many it has; for the create dialog. */
  async allowance(userId: string) {
    const tx = new Transaction(this.repo);
    const account = await this.service.account(tx, userId);
    const active = (await this.records(tx, userId)).length;
    const limit = paid(account) ? PUBLIC_LINK_LIMIT.paid : PUBLIC_LINK_LIMIT.free;
    let blockedReason: string | null = null;
    if (encryptedAccount(account))
      blockedReason = "Public links aren't available with end-to-end encryption yet.";
    else if (ageDays(account) < PUBLIC_LINK_MIN_ACCOUNT_AGE_DAYS) {
      const from = new Date(
        Date.parse(account.createdAt) + PUBLIC_LINK_MIN_ACCOUNT_AGE_DAYS * DAY_MS,
      );
      blockedReason = `New accounts can make public links after their first ${PUBLIC_LINK_MIN_ACCOUNT_AGE_DAYS} days, from ${from.toLocaleDateString('en', { month: 'long', day: 'numeric' })}.`;
    }
    return { blockedReason, neverExpires: paid(account), active, limit };
  }

  async create(
    userId: string,
    input: { driveItemId: string; expiresInDays: number | null; password: string | null },
  ) {
    const { blockedReason, neverExpires, active, limit } = await this.allowance(userId);
    assert(!blockedReason, 'PUBLIC_LINK_NOT_ALLOWED', blockedReason!, 403);
    assert(
      active < limit,
      'PUBLIC_LINK_LIMIT',
      `You can have up to ${limit} public links. Turn off one you no longer need.`,
      409,
    );
    assert(
      input.expiresInDays !== null || neverExpires,
      'PUBLIC_LINK_EXPIRY',
      'Links that never expire come with paid storage. Choose when this one ends.',
      403,
    );
    const token = randomBytes(16).toString('base64url');
    const hash = linkHash(token);
    const passwordHash = input.password ? await hashPassword(input.password) : null;
    const createdAt = now();
    const expiresAt = input.expiresInDays
      ? new Date(Date.now() + input.expiresInDays * DAY_MS).toISOString()
      : null;
    const record = await transact(this.repo, async (tx) => {
      const account = await this.service.account(tx, userId);
      const item = await this.service.owned(tx, userId, input.driveItemId);
      this.assertShareable(item, account);
      const record: LinkRecord = {
        id: randomUUID(),
        driveItemId: item.id,
        itemType: item.type,
        token,
        passwordHash,
        createdAt,
        expiresAt,
        revokedAt: null,
        disabledAt: null,
      };
      const key = indexKey(hash);
      await tx.put(
        key.pk,
        key.sk,
        {
          linkId: record.id,
          ownerId: userId,
          driveItemId: item.id,
          passwordHash,
          expiresAt,
          revokedAt: null,
          disabledAt: null,
        } satisfies LinkIndex,
        ttl(expiresAt),
      );
      await tx.put(userPK(userId), recordKey(record.id), record, ttl(expiresAt));
      return { record, name: item.name };
    });
    return { link: this.view(record.record, record.name) };
  }

  /** Links that still work, newest first; only one item's when `driveItemId` is given. */
  async list(userId: string, driveItemId?: string) {
    const tx = new Transaction(this.repo);
    const records = (await this.records(tx, userId)).filter(
      (r) => !driveItemId || r.driveItemId === driveItemId,
    );
    const links = await Promise.all(
      records.map(async (record) => {
        const item = await tx.get<DriveItem>(userPK(userId), `ITEM#${record.driveItemId}`);
        return this.view(record, item && !item.deletedAt ? item.name : null);
      }),
    );
    return links.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * Changes when a link ends, counted from now, or its password; null removes the password.
   * A new password also ends the passes visitors got with the old one.
   */
  async update(
    userId: string,
    id: string,
    input: { expiresInDays?: number | null; password?: string | null },
  ) {
    if (input.expiresInDays === null) {
      const { neverExpires } = await this.allowance(userId);
      assert(
        neverExpires,
        'PUBLIC_LINK_EXPIRY',
        'Links that never expire come with paid storage. Choose when this one ends.',
        403,
      );
    }
    const passwordHash =
      input.password === undefined
        ? undefined
        : input.password === null
          ? null
          : await hashPassword(input.password);
    const result = await transact(this.repo, async (tx) => {
      const record = await tx.get<LinkRecord>(userPK(userId), recordKey(id));
      assert(
        record && !record.revokedAt && !record.disabledAt && !expired(record.expiresAt),
        'LINK_NOT_FOUND',
        'This link was turned off or has expired. Make a new one.',
        404,
      );
      const changes = {
        ...(input.expiresInDays !== undefined
          ? {
              expiresAt: input.expiresInDays
                ? new Date(Date.now() + input.expiresInDays * DAY_MS).toISOString()
                : null,
            }
          : {}),
        ...(passwordHash !== undefined ? { passwordHash } : {}),
      };
      const next: LinkRecord = { ...record, ...changes };
      const key = indexKey(linkHash(record.token));
      const index = await tx.get<LinkIndex>(key.pk, key.sk);
      assert(index, 'LINK_NOT_FOUND', 'Public link was not found.', 404);
      await tx.put(key.pk, key.sk, { ...index, ...changes }, ttl(next.expiresAt));
      await tx.put(userPK(userId), recordKey(id), next, ttl(next.expiresAt));
      const item = await tx.get<DriveItem>(userPK(userId), `ITEM#${record.driveItemId}`);
      return { record: next, name: item && !item.deletedAt ? item.name : null };
    });
    return { link: this.view(result.record, result.name) };
  }

  async revoke(userId: string, id: string) {
    await transact(this.repo, async (tx) => {
      const record = await tx.get<LinkRecord>(userPK(userId), recordKey(id));
      assert(record, 'LINK_NOT_FOUND', 'Public link was not found.', 404);
      if (record.revokedAt) return;
      const at = now();
      const key = indexKey(linkHash(record.token));
      const index = await tx.get<LinkIndex>(key.pk, key.sk);
      if (index) await tx.put(key.pk, key.sk, { ...index, revokedAt: at }, ttl(at));
      await tx.put(userPK(userId), recordKey(id), { ...record, revokedAt: at }, ttl(at));
    });
  }

  /** What a visitor sees first. Behind a password, only who shared it and that it's locked. */
  async open(token: string, pass?: string) {
    const link = await this.resolve(token);
    const unlocked = passMatches(link.index, link.hash, pass);
    return {
      sharedBy: {
        displayName: link.owner.displayName,
        memberSince: link.owner.createdAt,
      },
      expiresAt: link.index.expiresAt,
      passwordRequired: !unlocked,
      item: unlocked ? this.publicItem(link.root) : null,
    };
  }

  /** Checks a visitor's password; the pass it returns goes with their later requests. */
  async unlock(token: string, password: string) {
    const link = await this.resolve(token);
    if (!link.index.passwordHash) return { pass: '' };
    assert(
      await passwordMatches(password, link.index.passwordHash),
      'LINK_PASSWORD_WRONG',
      "That password isn't right.",
      403,
    );
    return { pass: passFor(link.index, link.hash) };
  }

  /** A page of a folder within a folder link: the linked folder itself when `folderId` is unset. */
  async folder(token: string, pass: string | undefined, folderId?: string, cursor?: string) {
    const link = await this.unlocked(token, pass);
    assert(link.root.type === 'FOLDER', 'LINK_NOT_FOUND', 'This link shares a single file.', 404);
    const tx = new Transaction(this.repo);
    const path = await this.within(tx, link, folderId ?? link.root.id);
    const folder = path[path.length - 1];
    assert(folder.type === 'FOLDER', 'ITEM_NOT_FOUND', 'Choose a folder.', 400);
    const page = await this.service.list(link.owner.id, folder.id, 100, cursor);
    return {
      path: path.map((item) => ({ id: item.id, name: item.name })),
      items: page.items.map((item) => this.publicItem(item)),
      nextCursor: page.nextCursor,
    };
  }

  /** A short-lived download address for the linked file, or a file within the linked folder. */
  async download(token: string, pass: string | undefined, itemId?: string) {
    const link = await this.unlocked(token, pass);
    const tx = new Transaction(this.repo);
    const path = await this.within(tx, link, itemId ?? link.root.id);
    const item = path[path.length - 1];
    assert(item.type === 'FILE', 'DOWNLOAD_NOT_ALLOWED', 'Choose a file to download.', 400);
    this.assertShareable(item, link.owner);
    const version = await tx.get<FileVersion>(
      userPK(link.owner.id),
      `VERSION#${item.id}#${item.currentVersionId}`,
    );
    assert(version, 'ITEM_NOT_FOUND', 'This file is unavailable.', 404);
    assert(
      version.cloudState !== 'RELEASED',
      'SYNC_CONTENT_OFFLINE',
      "This file isn't in the cloud right now.",
      409,
    );
    assert(
      !version.encrypted,
      'E2EE_UNSUPPORTED',
      "This file is end-to-end encrypted, so it can't be downloaded from a public link.",
      403,
    );
    const object = await tx.get<StoredObject>('OBJECT', version.storageObjectId);
    assert(object && object.references > 0, 'ITEM_NOT_FOUND', 'This file is unavailable.', 404);
    // No database write per download: they show up in the request logs instead.
    return {
      downloadUrl: await this.service.storage.download(object.key, item.name),
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
      name: item.name,
      sizeBytes: version.sizeBytes,
    };
  }

  /** Files a public link may not offer: encrypted ones, and programs from young accounts. */
  private assertShareable(item: DriveItem, owner: Account) {
    if (item.type !== 'FILE') return;
    assert(
      !item.encrypted,
      'E2EE_UNSUPPORTED',
      "End-to-end encrypted files can't be shared with a public link yet.",
      403,
    );
    assert(
      !isExecutableName(item.name) || ageDays(owner) >= PUBLIC_LINK_EXECUTABLE_MIN_AGE_DAYS,
      'PUBLIC_LINK_FILE_TYPE',
      `Programs and installers can be shared with a public link once an account is ${PUBLIC_LINK_EXECUTABLE_MIN_AGE_DAYS} days old.`,
      403,
    );
  }

  private async records(tx: Transaction, userId: string) {
    const records = await tx.list<LinkRecord>(userPK(userId), 'PUBLIC_LINK#');
    return records.filter((r) => !r.revokedAt && !r.disabledAt && !expired(r.expiresAt));
  }

  private view(record: LinkRecord, itemName: string | null): PublicLink {
    return {
      id: record.id,
      driveItemId: record.driveItemId,
      itemType: record.itemType,
      itemName,
      url: this.url(record.token),
      hasPassword: !!record.passwordHash,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      disabledAt: record.disabledAt,
    };
  }

  private publicItem(item: DriveItem): PublicItem {
    return {
      id: item.id,
      type: item.type,
      name: item.name,
      mimeType: item.mimeType,
      sizeBytes: item.sizeBytes,
      updatedAt: item.updatedAt,
      executable: item.type === 'FILE' && isExecutableName(item.name),
    };
  }

  /** The link, if it still works: not revoked, disabled or expired, its owner and item still there. */
  private async resolve(token: string): Promise<Resolved> {
    const hash = linkHash(token);
    const index = (await this.repo.get(indexKey(hash)))?.data as LinkIndex | undefined;
    if (!index || index.revokedAt || index.disabledAt) throw gone();
    if (expired(index.expiresAt))
      throw new DomainError('LINK_EXPIRED', 'This link has expired.', 410);
    const tx = new Transaction(this.repo);
    const owner = await tx.get<Account>(userPK(index.ownerId), 'PROFILE');
    if (!owner || owner.deletedAt || owner.suspendedAt || encryptedAccount(owner)) throw gone();
    let root: DriveItem;
    try {
      root = await this.service.owned(tx, owner.id, index.driveItemId);
    } catch {
      throw gone();
    }
    return { index, hash, owner, root };
  }

  private async unlocked(token: string, pass?: string) {
    const link = await this.resolve(token);
    assert(
      passMatches(link.index, link.hash, pass),
      'LINK_PASSWORD_REQUIRED',
      'Enter the password for this link.',
      401,
    );
    return link;
  }

  /**
   * The linked folder down to `itemId`, which must be the linked item or inside it, with nothing
   * on the way in the trash. Anything outside the link is "not found", not "forbidden".
   */
  private async within(tx: Transaction, link: Resolved, itemId: string) {
    if (itemId === link.root.id) return [link.root];
    const path: DriveItem[] = [];
    let current = await tx.get<DriveItem>(userPK(link.owner.id), `ITEM#${itemId}`);
    while (current && path.length < MAX_DEPTH) {
      if (current.deletedAt || current.syncRemovedAt) break;
      path.unshift(current);
      if (current.parentId === link.root.id) return [link.root, ...path];
      if (!current.parentId) break;
      current = await tx.get<DriveItem>(userPK(link.owner.id), `ITEM#${current.parentId}`);
    }
    throw new DomainError('ITEM_NOT_FOUND', 'That file is not part of this link.', 404);
  }
}
