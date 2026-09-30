import { createHash, randomUUID } from 'node:crypto';
import {
  FREE_QUOTA,
  PART_SIZE,
  normalizeEmail,
  normalizeName,
  storageUsage,
  username as usernameSchema,
  filename,
  type User,
  type AppearancePreference,
  type Identity,
  type DriveItem,
  type FileVersion,
  type Device,
  type UploadInput,
  type CompletedPart,
  type SyncChange,
  type Transfer,
  type ManifestEntry,
  type ShareGrant,
} from '@harbor/contracts';
import { assert, DomainError } from './errors';
import { transact, Transaction, type Repository } from './repository';
import type { ObjectStorage } from './storage';
import {
  backupForItem,
  assertBackupMutable,
  assertBackupWrite,
  type BackupWrite,
} from './backup-policy';
import type { BackupRoot } from '../../../packages/contracts/src/backups';
import { ArchiveWorkflows } from './archives';
import { CloudCopies } from './cloud-copies';
import { DeletionWorkflows } from './deletion';
import { SyncRelay, syncMembershipChanged, syncDeviceKey, type SyncMapping } from './sync-relay';
import { TransferWorkflows, type StagedItem, type Save } from './workflows';
const now = () => new Date().toISOString();
const uid = () => randomUUID();
export const userPK = (id: string) => `USER#${id}`;
const nameKey = (parent: string | null, name: string) =>
  `NAME#${parent ?? 'root'}#${normalizeName(name)}`;
const childKey = (item: DriveItem) =>
  `CHILD#${item.parentId ?? 'root'}#${item.normalizedName}#${item.id}`;
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
export type Account = User & { sequence: number; minCursor: number };
// Device rows identify token sessions; devicePublicId identifies an installation.
type DeviceSession = Device & { revocationVersion?: number };
type DeviceRevocation = { version: number; revokedAt: string };
const deviceRevocationKey = (publicId: string) => `DEVICE_REVOCATION#${digest(publicId)}`;
export type StoredObject = {
  id: string;
  key: string;
  sizeBytes: number;
  contentHash: string;
  etag: string;
  references: number;
  createdAt: string;
};
export type Upload = {
  id: string;
  userId: string;
  deviceId: string | null;
  ownerUserId?: string;
  backupWrite?: BackupWrite;
  targetParentId: string | null;
  targetName: string;
  expectedSizeBytes: number;
  mimeType: string;
  contentHash: string | null;
  state: 'CREATED' | 'UPLOADING' | 'COMPLETING' | 'COMPLETED' | 'FAILED' | 'ABORTED' | 'EXPIRED';
  multipart: true;
  partSizeBytes: number;
  providerUploadId: string | null;
  objectId: string;
  objectKey: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  itemId: string;
  versionId: string;
  baseRevision: number | null;
  completionHash?: string;
  completionParts?: CompletedPart[];
  result?: DriveItem;
  failure?: string;
};
export type Job = {
  id: string;
  type:
    | 'CLOUD_COPY'
    | 'CLOUD_MIRROR'
    | 'SYNC_RELEASE'
    | 'ARCHIVE_BUILD'
    | 'ARCHIVE_EXPIRE'
    | 'UPLOAD_EXPIRE'
    | 'OBJECT_DELETE'
    | 'EMAIL'
    | 'TRANSFER_BUILD'
    | 'TRANSFER_SAVE'
    | 'TRANSFER_RELEASE'
    | 'TRANSFER_EXPIRE'
    | 'PERMANENT_DELETE';
  userId?: string;
  entityId?: string;
  key?: string;
  to?: string;
  sender?: string;
  dueAt: string;
  attempts: number;
};
export class StorageService {
  constructor(
    public repo: Repository,
    public storage: ObjectStorage,
  ) {}
  async ensureUser(identity: Identity) {
    assert(
      identity.emailVerified,
      'EMAIL_NOT_VERIFIED',
      'Verify your email before using your drive.',
      403,
    );
    return transact(this.repo, async (tx) => {
      const existing = await tx.get<Account>(userPK(identity.id), 'PROFILE');
      if (existing) {
        assert(
          existing.email === normalizeEmail(identity.email),
          'ACCOUNT_EMAIL_CHANGED',
          'Contact support to reconcile an email change.',
          409,
        );
        return existing;
      }
      const normalized = usernameSchema.parse(identity.username);
      const claimed = await tx.get<{ userId: string; email?: string }>('USERNAME', normalized);
      assert(
        !claimed ||
          claimed.userId === identity.id ||
          claimed.email === normalizeEmail(identity.email),
        'USERNAME_TAKEN',
        'This username is taken.',
        409,
      );
      const email = normalizeEmail(identity.email);
      const emailClaim = await tx.get<{ userId: string }>('EMAIL', email);
      assert(
        !emailClaim || emailClaim.userId === identity.id,
        'EMAIL_ALREADY_REGISTERED',
        'This email is already registered.',
        409,
      );
      const user: Account = {
        id: identity.id,
        email,
        emailVerified: true,
        username: normalized,
        displayName: identity.displayName || normalized,
        avatarUrl: null,
        storageQuotaBytes: FREE_QUOTA,
        storageUsedBytes: 0,
        storageReservedBytes: 0,
        createdAt: now(),
        updatedAt: now(),
        sequence: 0,
        minCursor: 0,
      };
      await tx.put(userPK(user.id), 'PROFILE', user);
      await tx.put('USERNAME', normalized, { userId: user.id });
      await tx.put('EMAIL', email, { userId: user.id });
      return user;
    });
  }
  async account(tx: Transaction, userId: string) {
    const u = await tx.get<Account>(userPK(userId), 'PROFILE');
    assert(u, 'USER_NOT_FOUND', 'Account was not found.', 404);
    return u;
  }
  async me(userId: string) {
    const u = await this.account(new Transaction(this.repo), userId);
    return { user: u, storage: storageUsage(u) };
  }
  async record(tx: Transaction, userId: string, type: string, entityId: string, item?: DriveItem) {
    if (item) await this.syncFolderChanged(tx, userId, item);
    const account = await this.account(tx, userId);
    account.sequence++;
    account.updatedAt = now();
    await tx.put(userPK(userId), 'PROFILE', account);
    const change: SyncChange = {
      sequence: account.sequence,
      type,
      entityId,
      revision: item?.revision ?? null,
      occurredAt: now(),
      ...(item ? { item } : {}),
    };
    await tx.put(userPK(userId), `CHANGE#${String(account.sequence).padStart(16, '0')}`, change);
    await tx.put(
      userPK(userId),
      `AUDIT#${uid()}`,
      { type, entityId, occurredAt: now() },
      { expiresAt: Math.floor(Date.now() / 1000) + 90 * 86400 },
    );
  }
  // A folder-scoped revision lets recipients reconcile without exposing the owner's feed.
  async syncFolderChanged(tx: Transaction, owner: string, item: DriveItem) {
    const config = await tx.get<{ folderIds: string[] }>(userPK(owner), 'SYNC_SHARING');
    if (!config?.folderIds.length) return;
    let current: DriveItem | undefined = item;
    const seen = new Set<string>();
    while (current && !seen.has(current.id) && seen.size <= 33) {
      seen.add(current.id);
      if (config.folderIds.includes(current.id)) {
        const revision = await tx.get<{ sequence: number }>(
          userPK(owner),
          `SYNCFOLDERREV#${current.id}`,
        );
        await tx.put(userPK(owner), `SYNCFOLDERREV#${current.id}`, {
          sequence: (revision?.sequence ?? 0) + 1,
        });
      }
      current = current.parentId
        ? await tx.get<DriveItem>(userPK(owner), `ITEM#${current.parentId}`)
        : undefined;
    }
  }
  async operation<T>(
    userId: string,
    operationId: string,
    input: unknown,
    fn: (tx: Transaction) => Promise<T>,
  ): Promise<T> {
    return transact(this.repo, async (tx) => {
      const key = `OP#${operationId}`;
      const prior = await tx.get<{ hash: string; result: T }>(userPK(userId), key);
      const hash = digest(input);
      if (prior) {
        assert(
          prior.hash === hash,
          'IDEMPOTENCY_KEY_REUSED',
          'This operation ID was used for a different request.',
          409,
        );
        return prior.result;
      }
      const result = await fn(tx);
      await tx.put(
        userPK(userId),
        key,
        { hash, result },
        { expiresAt: Math.floor(Date.now() / 1000) + 7 * 86400 },
      );
      return result;
    });
  }
  async parent(tx: Transaction, userId: string, parentId: string | null, exclude?: string) {
    let current = parentId;
    const visited = new Set<string>();
    while (current) {
      assert(
        current !== exclude && !visited.has(current),
        'INVALID_PARENT',
        'A folder cannot be moved inside itself.',
        409,
      );
      visited.add(current);
      assert(visited.size <= 32, 'PATH_TOO_DEEP', 'Folders can be nested up to 32 levels.', 400);
      const p = await tx.get<StagedItem>(userPK(userId), `ITEM#${current}`);
      assert(
        !p?.syncRemovedAt,
        'SYNC_REMOVED',
        'This folder was removed from sync. Local files are preserved.',
        409,
        { folderId: p?.id },
      );
      if (p?.stagingId)
        assert(
          (await tx.get<Save>(`SAVE#${p.stagingId}`, 'META'))?.state === 'COMPLETED',
          'PARENT_NOT_FOUND',
          'This folder is still being saved.',
          404,
        );
      assert(
        p && p.type === 'FOLDER' && !p.deletedAt,
        'PARENT_NOT_FOUND',
        'The destination folder is unavailable.',
        404,
      );
      current = p.parentId;
    }
  }
  async owned(tx: Transaction, userId: string, itemId: string, includeTrash = false) {
    const item = await tx.get<StagedItem>(userPK(userId), `ITEM#${itemId}`);
    if (item?.stagingId)
      assert(
        (await tx.get<Save>(`SAVE#${item.stagingId}`, 'META'))?.state === 'COMPLETED',
        'ITEM_NOT_FOUND',
        'This transfer is still being saved.',
        404,
      );
    assert(item, 'ITEM_NOT_FOUND', 'The item was not found.', 404);
    assert(
      !item.syncRemovedAt,
      'SYNC_REMOVED',
      'This folder was removed from sync. Local files are preserved.',
      409,
      { folderId: item.id },
    );
    assert(
      !(item as DriveItem & { purging?: boolean }).purging,
      'ITEM_DELETING',
      'This item is being permanently deleted.',
      409,
    );
    if (!includeTrash) {
      assert(!item.deletedAt, 'ITEM_NOT_FOUND', 'The item is in trash.', 404);
      await this.parent(tx, userId, item.parentId);
    }
    return item;
  }
  async reserveName(tx: Transaction, item: DriveItem, old?: DriveItem) {
    const pk = userPK(item.ownerUserId);
    if (
      old &&
      !old.deletedAt &&
      (old.parentId !== item.parentId ||
        old.normalizedName !== item.normalizedName ||
        item.deletedAt)
    ) {
      await tx.delete(pk, nameKey(old.parentId, old.name));
      await tx.delete(pk, childKey(old));
    }
    if (!item.deletedAt) {
      const claim = await tx.get<{ id: string }>(pk, nameKey(item.parentId, item.name));
      assert(
        !claim || claim.id === item.id,
        'NAME_CONFLICT',
        'An item with that name already exists in this folder.',
        409,
      );
      await tx.put(pk, nameKey(item.parentId, item.name), { id: item.id });
      await tx.put(pk, childKey(item), { id: item.id });
    }
    if (old && old.parentId !== item.parentId)
      await tx.delete(pk, `ALLCHILD#${old.parentId ?? 'root'}#${old.id}`);
    await tx.put(pk, `ALLCHILD#${item.parentId ?? 'root'}#${item.id}`, { id: item.id });
    await tx.put(pk, `ITEM#${item.id}`, item);
    await tx.put('ITEMOWNER', item.id, { userId: item.ownerUserId });
  }
  newItem(
    ownerUserId: string,
    parentId: string | null,
    name: string,
    type: 'FILE' | 'FOLDER',
    id: string = uid(),
  ): DriveItem {
    return {
      id,
      ownerUserId,
      parentId,
      type,
      name: name.normalize('NFC'),
      normalizedName: normalizeName(name),
      mimeType: null,
      sizeBytes: 0,
      currentVersionId: null,
      revision: 1,
      favorite: false,
      createdAt: now(),
      updatedAt: now(),
      deletedAt: null,
    };
  }
  async createFolder(
    userId: string,
    input: { parentId: string | null; name: string; operationId: string },
    backupWrite?: BackupWrite,
  ) {
    return this.operation(
      userId,
      input.operationId,
      { action: 'folder', ...input, ...(backupWrite ? { backupWrite } : {}) },
      async (tx) => {
        const owner = input.parentId
          ? (await this.authorized(tx, userId, input.parentId, !backupWrite)).owner
          : userId;
        if (backupWrite) {
          assert(owner === userId, 'FORBIDDEN', 'Backup folders must belong to you.', 403);
          await this.checkDevice(userId, backupWrite.deviceId);
          await assertBackupWrite(tx, owner, input.parentId, backupWrite);
        }
        await this.parent(tx, owner, input.parentId);
        const item = this.newItem(owner, input.parentId, input.name, 'FOLDER');
        await this.reserveName(tx, item);
        await this.record(tx, item.ownerUserId, 'FOLDER_CREATED', item.id, item);
        return { item };
      },
    );
  }
  async list(userId: string, parentId: string | null, limit = 100, cursor?: string) {
    const tx = new Transaction(this.repo);
    await this.parent(tx, userId, parentId);
    const page = await this.repo.query(
      userPK(userId),
      `CHILD#${parentId ?? 'root'}#`,
      limit,
      cursor,
    );
    const items = await Promise.all(
      page.rows.map((r) =>
        tx.get<DriveItem>(userPK(userId), `ITEM#${(r.data as { id: string }).id}`),
      ),
    );
    return {
      items: (
        await Promise.all(
          items.map(async (i): Promise<DriveItem | null> => {
            if (!i || i.deletedAt || i.syncRemovedAt) return null;
            const stagingId = (i as StagedItem).stagingId;
            if (
              stagingId &&
              (await tx.get<Save>(`SAVE#${stagingId}`, 'META'))?.state !== 'COMPLETED'
            )
              return null;
            return { ...i, backupRootId: (await backupForItem(tx, userId, i.id))?.id };
          }),
        )
      ).filter((i): i is DriveItem => !!i),
      nextCursor: page.cursor,
    };
  }
  async mutate(
    userId: string,
    itemId: string,
    input: {
      operationId: string;
      baseRevision: number;
      name?: string;
      parentId?: string | null;
      favorite?: boolean;
      action?: 'trash' | 'restore';
    },
  ) {
    return this.operation(userId, input.operationId, { itemId, ...input }, async (tx) => {
      const locator = await tx.get<{ userId: string }>('ITEMOWNER', itemId);
      const ownerId = locator?.userId ?? userId;
      if (ownerId !== userId) {
        await this.authorized(tx, userId, itemId, true);
        const direct = await tx.get<ShareGrant>(userPK(userId), `ACCESS#${itemId}`);
        assert(
          !direct?.syncState,
          'FORBIDDEN',
          'Only the owner can change the shared folder itself.',
          403,
        );
      }
      const item = await this.owned(tx, ownerId, itemId, true);
      await assertBackupMutable(tx, ownerId, itemId, true);
      if (input.parentId) await assertBackupMutable(tx, ownerId, input.parentId);
      assert(
        item.revision === input.baseRevision,
        'REVISION_CONFLICT',
        'This item changed on another device.',
        409,
        { serverItem: item, serverRevision: item.revision },
      );
      const old = structuredClone(item);
      let type = 'FILE_UPDATED';
      if (input.action === 'trash') {
        assert(!item.deletedAt, 'ITEM_NOT_FOUND', 'Item is already in trash.', 404);
        await this.parent(tx, ownerId, item.parentId);
        item.deletedAt = now();
        type = 'FILE_DELETED';
      } else if (input.action === 'restore') {
        assert(item.deletedAt, 'INVALID_STATE', 'Item is not in trash.', 409);
        item.deletedAt = null;
        try {
          await this.parent(tx, ownerId, item.parentId);
        } catch (e) {
          if (e instanceof DomainError && e.code === 'PARENT_NOT_FOUND') item.parentId = null;
          else throw e;
        }
        type = 'FILE_RESTORED';
      } else {
        assert(!item.deletedAt, 'ITEM_NOT_FOUND', 'Restore this item before editing.', 404);
        await this.parent(tx, ownerId, item.parentId);
        if (input.name !== undefined) {
          item.name = input.name.normalize('NFC');
          item.normalizedName = normalizeName(input.name);
          type = 'ITEM_RENAMED';
        }
        if (input.parentId !== undefined) {
          if (ownerId !== userId) {
            assert(
              input.parentId,
              'FORBIDDEN',
              'Editors cannot move items to the owner’s root.',
              403,
            );
            await this.authorized(tx, userId, input.parentId, true);
          }
          await this.parent(tx, ownerId, input.parentId, item.id);
          item.parentId = input.parentId;
          type = 'ITEM_MOVED';
        }
        if (input.favorite !== undefined) {
          item.favorite = input.favorite;
          type = 'FAVORITE_CHANGED';
        }
      }
      item.revision++;
      item.updatedAt = now();
      await this.reserveName(tx, item, old);
      if (old.parentId !== item.parentId) await this.syncFolderChanged(tx, ownerId, old);
      await this.record(tx, ownerId, type, item.id, item);
      return { item };
    });
  }
  async metadata(userId: string, itemId: string) {
    const tx = new Transaction(this.repo);
    const { item } = await this.authorized(tx, userId, itemId);
    return {
      item: { ...item, backupRootId: (await backupForItem(tx, item.ownerUserId, item.id))?.id },
    };
  }
  async browseSpecial(
    userId: string,
    filter: Record<string, string>,
    limit = 100,
    cursor?: string,
  ) {
    const page = await this.repo.query(userPK(userId), 'ITEM#', limit, cursor);
    const tx = new Transaction(this.repo);
    const items: DriveItem[] = [];
    for (const row of page.rows) {
      const i = row.data as StagedItem;
      if (i.stagingId && (await tx.get<Save>(`SAVE#${i.stagingId}`, 'META'))?.state !== 'COMPLETED')
        continue;
      if ((i as DriveItem & { purging?: boolean }).purging || i.syncRemovedAt) continue;
      if (filter.trash === 'true' ? !i.deletedAt : !!i.deletedAt) continue;
      if (filter.favorite === 'true' && !i.favorite) continue;
      if (filter.q && !i.normalizedName.includes(normalizeName(filter.q))) continue;
      if (filter.type && i.type !== filter.type.toUpperCase()) continue;
      if (filter.mimeType && i.mimeType !== filter.mimeType) continue;
      if (filter.extension && !i.normalizedName.endsWith('.' + filter.extension.toLowerCase()))
        continue;
      if (filter.parentId && i.parentId !== (filter.parentId === 'root' ? null : filter.parentId))
        continue;
      if (
        (filter.createdAfter && i.createdAt < filter.createdAfter) ||
        (filter.createdBefore && i.createdAt > filter.createdBefore) ||
        (filter.updatedAfter && i.updatedAt < filter.updatedAfter) ||
        (filter.updatedBefore && i.updatedAt > filter.updatedBefore)
      )
        continue;
      if (!i.deletedAt) {
        try {
          await this.parent(tx, userId, i.parentId);
        } catch {
          continue;
        }
      }
      items.push({ ...i, backupRootId: (await backupForItem(tx, userId, i.id))?.id });
    }
    if (filter.recent === 'true') items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { items, nextCursor: page.cursor };
  }
  async createUpload(
    userId: string,
    input: UploadInput,
    deviceId?: string,
    backupWrite?: BackupWrite,
  ) {
    const initial = await this.operation(
      userId,
      input.operationId,
      { action: 'upload', ...input, ...(backupWrite ? { backupWrite } : {}) },
      async (tx) => {
        const owner = input.driveItemId
          ? (await this.authorized(tx, userId, input.driveItemId, !backupWrite)).owner
          : input.parentId
            ? (await this.authorized(tx, userId, input.parentId, !backupWrite)).owner
            : userId;
        if (backupWrite) {
          assert(owner === userId, 'FORBIDDEN', 'Backup folders must belong to you.', 403);
          await this.checkDevice(userId, backupWrite.deviceId);
          await assertBackupWrite(tx, owner, input.driveItemId ?? input.parentId, backupWrite);
          await assertBackupWrite(tx, owner, input.parentId, backupWrite);
        }
        await this.parent(tx, owner, input.parentId);
        let prior: DriveItem | undefined;
        if (input.driveItemId) {
          prior = await this.owned(tx, owner, input.driveItemId);
          assert(
            prior.type === 'FILE' && prior.revision === input.baseRevision,
            'REVISION_CONFLICT',
            'File changed before upload started.',
            409,
            { serverItem: prior },
          );
        } else {
          assert(
            !(await tx.get(userPK(owner), nameKey(input.parentId, input.name))),
            'NAME_CONFLICT',
            'An item with this name already exists.',
            409,
          );
        }
        const account = await this.account(tx, owner);
        const available = storageUsage(account).availableBytes;
        assert(
          input.sizeBytes <= available,
          'STORAGE_QUOTA_EXCEEDED',
          'There is not enough available storage.',
          409,
          { requiredBytes: input.sizeBytes, availableBytes: available },
        );
        account.storageReservedBytes += input.sizeBytes;
        await tx.put(userPK(owner), 'PROFILE', account);
        const objectId = uid();
        const upload: Upload = {
          id: uid(),
          userId,
          ownerUserId: owner,
          ...(backupWrite ? { backupWrite } : {}),
          deviceId: deviceId ?? null,
          targetParentId: prior?.parentId ?? input.parentId,
          targetName: prior?.name ?? input.name,
          expectedSizeBytes: input.sizeBytes,
          mimeType: input.mimeType,
          contentHash: input.contentHash ?? null,
          state: 'CREATED',
          multipart: true,
          partSizeBytes: Math.max(
            PART_SIZE,
            Math.ceil(input.sizeBytes / 10000 / 1048576) * 1048576,
          ),
          providerUploadId: null,
          objectId,
          objectKey: `objects/${objectId.slice(0, 2)}/${objectId}`,
          createdAt: now(),
          updatedAt: now(),
          expiresAt: new Date(Date.now() + 24 * 3600_000).toISOString(),
          itemId: prior?.id ?? uid(),
          versionId: uid(),
          baseRevision: prior?.revision ?? null,
        };
        await tx.put(userPK(userId), `UPLOAD#${upload.id}`, upload);
        await this.job(tx, {
          id: `upload-${upload.id}`,
          type: 'UPLOAD_EXPIRE',
          userId,
          entityId: upload.id,
          dueAt: upload.expiresAt,
          attempts: 0,
        });
        await this.record(tx, userId, 'UPLOAD_CREATED', upload.id);
        return { upload };
      },
    );
    const upload = await this.getUpload(userId, initial.upload.id);
    if (upload.state === 'CREATED' && !upload.providerUploadId) {
      const providerId = await this.storage.create(upload.objectKey);
      let attached = false;
      try {
        attached = await transact(this.repo, async (tx) => {
          const current = (await tx.get<Upload>(userPK(userId), `UPLOAD#${upload.id}`))!;
          if (current.providerUploadId || current.state !== 'CREATED') return false;
          current.providerUploadId = providerId;
          current.state = 'UPLOADING';
          await tx.put(userPK(userId), `UPLOAD#${upload.id}`, current);
          return true;
        });
      } finally {
        if (!attached) await this.storage.abort(upload.objectKey, providerId);
      }
    }
    return {
      upload: this.publicUpload(await this.getUpload(userId, upload.id)),
      storage: (await this.me(userId)).storage,
    };
  }
  publicUpload(u: Upload) {
    return {
      id: u.id,
      state: u.state,
      multipart: u.multipart,
      partSizeBytes: u.partSizeBytes,
      expectedSizeBytes: u.expectedSizeBytes,
      expiresAt: u.expiresAt,
      failure: u.failure,
      item: u.result,
    };
  }
  async getUpload(userId: string, id: string) {
    const u = await new Transaction(this.repo).get<Upload>(userPK(userId), `UPLOAD#${id}`);
    assert(u, 'UPLOAD_NOT_FOUND', 'Upload was not found.', 404);
    return u;
  }
  async authorizeUpload(tx: Transaction, actor: string, upload: Upload) {
    const owner = upload.ownerUserId ?? actor;
    const destination = upload.baseRevision !== null ? upload.itemId : upload.targetParentId;
    if (upload.backupWrite) {
      await this.checkDevice(owner, upload.backupWrite.deviceId);
      await assertBackupWrite(tx, owner, destination, upload.backupWrite);
    } else await assertBackupMutable(tx, owner, destination);
    if (owner !== actor) {
      const target = upload.baseRevision !== null ? upload.itemId : upload.targetParentId;
      assert(target, 'FORBIDDEN', 'A shared destination is required.', 403);
      const access = await this.authorized(tx, actor, target, true);
      assert(access.owner === owner, 'FORBIDDEN', 'The shared destination changed.', 403);
    }
    return owner;
  }
  checkUpload(u: Upload) {
    assert(u.expiresAt > now(), 'UPLOAD_EXPIRED', 'Upload expired. Start a new upload.', 410);
    assert(
      u.state === 'UPLOADING',
      'INVALID_UPLOAD_STATE',
      'This upload cannot accept parts.',
      409,
    );
  }
  async uploadParts(userId: string, id: string, partNumbers: number[]) {
    const u = await this.getUpload(userId, id);
    await this.authorizeUpload(new Transaction(this.repo), userId, u);
    this.checkUpload(u);
    const count = Math.max(1, Math.ceil(u.expectedSizeBytes / u.partSizeBytes));
    assert(
      partNumbers.every((p) => p >= 1 && p <= count) &&
        new Set(partNumbers).size === partNumbers.length,
      'UPLOAD_PART_INVALID',
      'Invalid upload part numbers.',
    );
    const parts = await Promise.all(
      partNumbers.map(async (p) => ({
        partNumber: p,
        uploadUrl: await this.storage.signPart(
          u.objectKey,
          u.providerUploadId!,
          p,
          Math.min(u.partSizeBytes, u.expectedSizeBytes - (p - 1) * u.partSizeBytes),
        ),
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
      })),
    );
    return { parts };
  }
  async uploadStatus(userId: string, id: string) {
    const u = await this.getUpload(userId, id);
    return {
      upload: this.publicUpload(u),
      parts:
        u.providerUploadId && u.state === 'UPLOADING'
          ? await this.storage.parts(u.objectKey, u.providerUploadId)
          : (u.completionParts ?? []),
    };
  }
  async completeUpload(userId: string, id: string, parts: CompletedPart[], contentHash: string) {
    const fingerprint = digest({ parts, contentHash });
    let u = await transact(this.repo, async (tx) => {
      const u = await tx.get<Upload>(userPK(userId), `UPLOAD#${id}`);
      assert(u, 'UPLOAD_NOT_FOUND', 'Upload was not found.', 404);
      await this.authorizeUpload(tx, userId, u);
      if (u.completionHash)
        assert(
          u.completionHash === fingerprint,
          'IDEMPOTENCY_KEY_REUSED',
          'Completion content differs from the original request.',
          409,
        );
      if (u.state === 'COMPLETED') return u;
      assert(u.expiresAt > now(), 'UPLOAD_EXPIRED', 'The upload expired.', 410);
      assert(
        ['UPLOADING', 'COMPLETING'].includes(u.state),
        'INVALID_UPLOAD_STATE',
        'This upload cannot be completed.',
        409,
      );
      const count = Math.max(1, Math.ceil(u.expectedSizeBytes / u.partSizeBytes));
      assert(
        parts.length === count && parts.every((p, i) => p.partNumber === i + 1),
        'UPLOAD_PART_INVALID',
        'Provide all parts in ascending order.',
      );
      assert(
        !u.contentHash || u.contentHash === contentHash,
        'HASH_MISMATCH',
        'The content hash does not match the upload.',
      );
      u.contentHash = contentHash;
      u.completionHash = fingerprint;
      u.completionParts = parts;
      u.state = 'COMPLETING';
      u.updatedAt = now();
      await tx.put(userPK(userId), `UPLOAD#${id}`, u);
      return u;
    });
    if (u.state === 'COMPLETED') return { item: u.result! };
    await this.storage.complete(u.objectKey, u.providerUploadId!, parts);
    const object = await this.storage.head(u.objectKey);
    if (!object || object.size !== u.expectedSizeBytes) {
      await this.abortUpload(userId, id, 'FAILED');
      throw new DomainError(
        'UPLOAD_SIZE_MISMATCH',
        'The uploaded file size does not match the reserved size.',
        409,
      );
    }
    return transact(this.repo, async (tx) => {
      u = (await tx.get<Upload>(userPK(userId), `UPLOAD#${id}`))!;
      if (u.state === 'COMPLETED') return { item: u.result! };
      assert(
        u.state === 'COMPLETING' && u.expiresAt > now(),
        'UPLOAD_EXPIRED',
        'The upload expired or was cancelled.',
        410,
      );
      const owner = await this.authorizeUpload(tx, userId, u);
      await this.parent(tx, owner, u.targetParentId);
      let item: DriveItem;
      let old: DriveItem | undefined;
      if (u.baseRevision !== null) {
        old = await this.owned(tx, owner, u.itemId);
        assert(
          old.revision === u.baseRevision,
          'REVISION_CONFLICT',
          'The file changed while this upload was running. Keep your local file and upload a conflict copy.',
          409,
          { serverItem: old },
        );
        item = { ...old, revision: old.revision + 1, updatedAt: now() };
      } else item = this.newItem(owner, u.targetParentId, u.targetName, 'FILE', u.itemId);
      item.sizeBytes = u.expectedSizeBytes;
      item.mimeType = u.mimeType;
      item.currentVersionId = u.versionId;
      item.cloudState = 'AVAILABLE';
      const versions = old
        ? await tx.get<FileVersion>(userPK(owner), `VERSION#${item.id}#${old.currentVersionId}`)
        : undefined;
      const version: FileVersion = {
        id: u.versionId,
        driveItemId: item.id,
        storageObjectId: u.objectId,
        versionNumber: (versions?.versionNumber ?? 0) + 1,
        sizeBytes: u.expectedSizeBytes,
        contentHash,
        contentHashAlgorithm: 'SHA256',
        sourceDeviceId: u.deviceId,
        createdAt: now(),
      };
      await tx.put(userPK(owner), `VERSION#${item.id}#${version.id}`, version);
      await tx.put('OBJECT', u.objectId, {
        id: u.objectId,
        key: u.objectKey,
        sizeBytes: u.expectedSizeBytes,
        contentHash,
        etag: object.etag,
        references: 1,
        createdAt: now(),
      } satisfies StoredObject);
      await this.reserveName(tx, item, old);
      const account = await this.account(tx, owner);
      account.storageReservedBytes -= u.expectedSizeBytes;
      account.storageUsedBytes += u.expectedSizeBytes;
      await tx.put(userPK(owner), 'PROFILE', account);
      u.state = 'COMPLETED';
      u.result = item;
      u.updatedAt = now();
      await tx.put(userPK(userId), `UPLOAD#${id}`, u);
      await tx.delete('JOB', `upload-${id}`);
      await this.record(tx, owner, old ? 'FILE_UPDATED' : 'FILE_CREATED', item.id, item);
      return { item };
    });
  }
  async job(tx: Transaction, job: Job) {
    await tx.put('JOB', job.id, job, { gpk: 'JOB', gsk: job.dueAt });
  }
  async abortUpload(
    userId: string,
    id: string,
    state: 'ABORTED' | 'EXPIRED' | 'FAILED' = 'ABORTED',
  ) {
    const u = await transact(this.repo, async (tx) => {
      const u = await tx.get<Upload>(userPK(userId), `UPLOAD#${id}`);
      assert(u, 'UPLOAD_NOT_FOUND', 'Upload was not found.', 404);
      if (['COMPLETED', 'ABORTED', 'EXPIRED', 'FAILED'].includes(u.state)) return u;
      u.state = state;
      u.updatedAt = now();
      const account = await this.account(tx, u.ownerUserId ?? userId);
      account.storageReservedBytes -= u.expectedSizeBytes;
      await tx.put(userPK(u.ownerUserId ?? userId), 'PROFILE', account);
      await tx.put(userPK(userId), `UPLOAD#${id}`, u);
      await this.record(tx, userId, 'UPLOAD_ABORTED', id);
      return u;
    });
    if (u.state === 'COMPLETED') return { upload: this.publicUpload(u) };
    if (u.providerUploadId) await this.storage.abort(u.objectKey, u.providerUploadId);
    await this.storage.remove(u.objectKey);
    await transact(this.repo, async (tx) => {
      await tx.delete('JOB', `upload-${id}`);
      await this.job(tx, {
        id: `object-${u.objectId}`,
        type: 'OBJECT_DELETE',
        entityId: u.objectId,
        key: u.objectKey,
        dueAt: new Date(Date.now() + 3600_000).toISOString(),
        attempts: 0,
      });
    });
    return { upload: this.publicUpload(u) };
  }
  async reference(tx: Transaction, id: string, delta: number, transferOwnerId?: string) {
    if (transferOwnerId) {
      const pin = await tx.get<{ count: number }>(`PIN#${id}`, transferOwnerId);
      const count = (pin?.count ?? 0) + delta;
      assert(count >= 0, 'INTERNAL_ERROR', 'Invalid transfer retention count.', 500);
      await tx.put(`PIN#${id}`, transferOwnerId, { count });
    }
    const object = await tx.get<StoredObject>('OBJECT', id);
    assert(object, 'ITEM_NOT_FOUND', 'File content is unavailable.', 404);
    assert(
      delta <= 0 || object.references > 0,
      'SYNC_CONTENT_OFFLINE',
      'This content is stored on synced devices. Request a temporary copy first.',
      409,
    );
    object.references += delta;
    assert(object.references >= 0, 'INTERNAL_ERROR', 'Invalid object reference count.', 500);
    await tx.put('OBJECT', id, object);
    if (object.references === 0)
      await this.job(tx, {
        id: `object-${id}`,
        type: 'OBJECT_DELETE',
        entityId: id,
        key: object.key,
        dueAt: new Date(Date.now() + 3600_000).toISOString(),
        attempts: 0,
      });
    return object;
  }
  async authorized(tx: Transaction, userId: string, itemId: string, write = false) {
    const locator = await tx.get<{ userId: string }>('ITEMOWNER', itemId);
    assert(locator, 'ITEM_NOT_FOUND', 'Item was not found.', 404);
    const owner = locator.userId;
    const item = await this.owned(tx, owner, itemId);
    if (write) await assertBackupMutable(tx, owner, itemId);
    if (owner === userId) return { item, owner };
    let current: DriveItem | undefined = item;
    let permission: ShareGrant | undefined;
    while (current) {
      const grant = await tx.get<ShareGrant>(userPK(userId), `ACCESS#${current.id}`);
      if (
        grant &&
        !grant.revokedAt &&
        (!grant.syncState || grant.syncState === 'ACCEPTED') &&
        (!write || grant.permission === 'EDITOR')
      ) {
        permission = grant;
        break;
      }
      current = current.parentId
        ? await tx.get<DriveItem>(userPK(owner), `ITEM#${current.parentId}`)
        : undefined;
    }
    assert(permission, 'FORBIDDEN', 'You do not have access to this item.', 403);
    return { item, owner };
  }
  async download(
    userId: string,
    input: {
      folderDownloadId?: string;
      driveItemId?: string;
      versionId?: string | null;
      transferId?: string;
      entryId?: string;
    },
  ) {
    if (input.folderDownloadId)
      return new ArchiveWorkflows(this).download(userId, input.folderDownloadId);
    const tx = new Transaction(this.repo);
    let version: FileVersion;
    let name: string;
    if (input.transferId) {
      const t = await tx.get<Transfer>('TRANSFER', input.transferId);
      assert(
        t && t.recipientUserId === userId && t.state === 'ACCEPTED',
        'DOWNLOAD_NOT_ALLOWED',
        'Accept a transfer addressed to your account before downloading.',
        403,
      );
      assert(
        !t.expiresAt || t.expiresAt > now(),
        'TRANSFER_EXPIRED',
        'This transfer expired. Saved copies remain in your drive.',
        410,
      );
      const e = await tx.get<ManifestEntry>(`TRANSFER#${t.id}`, `ENTRY#${input.entryId}`);
      assert(e && e.itemType === 'FILE', 'ITEM_NOT_FOUND', 'Transfer file was not found.', 404);
      version = {
        id: e.sourceVersionId!,
        driveItemId: e.sourceDriveItemId,
        storageObjectId: e.storageObjectId!,
        versionNumber: 1,
        sizeBytes: e.sizeBytes,
        contentHash: e.contentHash!,
        contentHashAlgorithm: 'SHA256',
        sourceDeviceId: null,
        createdAt: t.createdAt,
      };
      name = e.displayName;
    } else {
      assert(input.driveItemId, 'VALIDATION_ERROR', 'Choose a file to download.');
      const { item, owner } = await this.authorized(tx, userId, input.driveItemId);
      assert(
        item.type === 'FILE',
        'DOWNLOAD_NOT_ALLOWED',
        'Choose a file within this folder.',
        400,
      );
      const v = await tx.get<FileVersion>(
        userPK(owner),
        `VERSION#${item.id}#${input.versionId ?? item.currentVersionId}`,
      );
      assert(v, 'ITEM_NOT_FOUND', 'File version was not found.', 404);
      assert(
        v.cloudState !== 'RELEASED',
        'SYNC_CONTENT_OFFLINE',
        'This file is on synced devices. Open a local copy or request it from a linked device.',
        409,
      );
      version = v;
      name = item.name;
    }
    const object = await tx.get<StoredObject>('OBJECT', version.storageObjectId);
    assert(object && object.references > 0, 'ITEM_NOT_FOUND', 'File content is unavailable.', 404);
    const downloadUrl = await this.storage.download(object.key, name);
    await transact(this.repo, (tx) =>
      tx.put(
        userPK(userId),
        `AUDIT#${uid()}`,
        { type: 'FILE_DOWNLOADED', entityId: version.driveItemId, occurredAt: now() },
        { expiresAt: Math.floor(Date.now() / 1000) + 90 * 86400 },
      ),
    );
    return {
      downloadUrl,
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
      sizeBytes: version.sizeBytes,
      contentHash: version.contentHash,
      contentHashAlgorithm: 'SHA256' as const,
    };
  }
  async versions(userId: string, itemId: string) {
    const tx = new Transaction(this.repo);
    const { owner } = await this.authorized(tx, userId, itemId);
    const items = await tx.list<FileVersion>(userPK(owner), `VERSION#${itemId}#`);
    return { items: items.sort((a, b) => b.versionNumber - a.versionNumber) };
  }
  async restoreVersion(
    userId: string,
    itemId: string,
    versionId: string,
    input: { operationId: string; baseRevision: number },
  ) {
    return this.operation(
      userId,
      input.operationId,
      { action: 'restoreVersion', itemId, versionId, ...input },
      async (tx) => {
        const item = await this.owned(tx, userId, itemId);
        await assertBackupMutable(tx, userId, itemId);
        assert(
          item.revision === input.baseRevision,
          'REVISION_CONFLICT',
          'The file changed.',
          409,
          { serverItem: item },
        );
        const previous = await tx.get<FileVersion>(
          userPK(userId),
          `VERSION#${itemId}#${versionId}`,
        );
        assert(previous, 'ITEM_NOT_FOUND', 'Version was not found.', 404);
        assert(
          previous.cloudState !== 'RELEASED',
          'SYNC_CONTENT_OFFLINE',
          'This version is no longer stored in the cloud.',
          409,
        );
        const current = (await tx.get<FileVersion>(
          userPK(userId),
          `VERSION#${itemId}#${item.currentVersionId}`,
        ))!;
        const account = await this.account(tx, userId);
        assert(
          previous.sizeBytes <= storageUsage(account).availableBytes,
          'STORAGE_QUOTA_EXCEEDED',
          'There is not enough storage for a restored version.',
          409,
        );
        account.storageUsedBytes += previous.sizeBytes;
        await tx.put(userPK(userId), 'PROFILE', account);
        const v = {
          ...previous,
          id: uid(),
          versionNumber: current.versionNumber + 1,
          createdAt: now(),
        };
        await tx.put(userPK(userId), `VERSION#${itemId}#${v.id}`, v);
        await this.reference(tx, v.storageObjectId, 1);
        item.currentVersionId = v.id;
        item.cloudState = 'AVAILABLE';
        item.sizeBytes = v.sizeBytes;
        item.revision++;
        item.updatedAt = now();
        await tx.put(userPK(userId), `ITEM#${itemId}`, item);
        await this.record(tx, userId, 'FILE_UPDATED', itemId, item);
        return { item };
      },
    );
  }
  async permanentDelete(
    userId: string,
    itemId: string,
    input: { operationId: string; baseRevision: number },
  ) {
    // Only detach the item here; version/reference cleanup runs in durable batches.
    return new DeletionWorkflows(this).start(userId, itemId, input);
  }
  async emptyTrash(userId: string, input: { operationId: string; cursor?: string }) {
    return this.operation(
      userId,
      input.operationId,
      { action: 'empty-trash', ...input },
      async (tx) => {
        // Bound each request and transaction, regardless of the size of the drive.
        const page = await this.repo.query(userPK(userId), 'ITEM#', 10, input.cursor);
        let count = 0;
        for (const row of page.rows) {
          const item = await tx.get<DriveItem & { purging?: boolean }>(row.pk, row.sk);
          if (!item?.deletedAt || item.purging) continue;
          await new DeletionWorkflows(this).detach(tx, userId, item);
          count++;
        }
        return { count, nextCursor: page.cursor };
      },
    );
  }
  async lookup(value: string) {
    const key = value.trim().replace(/^@/, '').toLowerCase();
    const row = await this.repo.get({ pk: 'USERNAME', sk: key });
    if (!row || !(row.data as { userId?: string }).userId) return { users: [] };
    const account = await this.account(
      new Transaction(this.repo),
      (row.data as { userId: string }).userId,
    );
    return {
      users: [
        {
          id: account.id,
          username: account.username,
          displayName: account.displayName,
          avatarUrl: account.avatarUrl,
        },
      ],
    };
  }
  async resolveRecipient(
    tx: Transaction,
    recipient: { type: 'USERNAME' | 'EMAIL'; value: string },
  ) {
    const key =
      recipient.type === 'EMAIL'
        ? normalizeEmail(recipient.value)
        : recipient.value.replace(/^@/, '').toLowerCase();
    if (recipient.type === 'EMAIL')
      assert(
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(key),
        'VALIDATION_ERROR',
        'Enter a valid email address.',
      );
    const result = await tx.get<{ userId: string }>(recipient.type, key);
    if (recipient.type === 'USERNAME')
      assert(result?.userId, 'USER_NOT_FOUND', 'That username was not found.', 404);
    return {
      recipientUserId: result?.userId ?? null,
      recipientEmail: recipient.type === 'EMAIL' ? key : null,
    };
  }
  async notification(tx: Transaction, userId: string, type: string, data: Record<string, unknown>) {
    const id = uid();
    const createdAt = now();
    const key = `NOTIFICATION#${createdAt}#${id}`;
    await tx.put(userPK(userId), key, { id, type, data, readAt: null, createdAt });
    await tx.put(userPK(userId), `NOTIFICATION_ID#${id}`, { key });
  }
  async createTransfer(
    userId: string,
    input: {
      operationId: string;
      recipient: { type: 'USERNAME' | 'EMAIL'; value: string };
      items: { driveItemId: string }[];
    },
  ) {
    try {
      return await this.createTransferAtomic(userId, input);
    } catch (e) {
      if (e instanceof DomainError && e.code === 'OPERATION_TOO_LARGE')
        return new TransferWorkflows(this).create(userId, input);
      throw e;
    }
  }
  private async createTransferAtomic(
    userId: string,
    input: {
      operationId: string;
      recipient: { type: 'USERNAME' | 'EMAIL'; value: string };
      items: { driveItemId: string }[];
    },
  ) {
    return this.operation(
      userId,
      input.operationId,
      { action: 'transfer', ...input },
      async (tx) => {
        const resolved = await this.resolveRecipient(tx, input.recipient);
        assert(
          resolved.recipientUserId !== userId,
          'TRANSFER_NOT_ALLOWED',
          'Choose another recipient.',
          400,
        );
        const account = await this.account(tx, userId);
        const entries: ManifestEntry[] = [];
        const visited = new Set<string>();
        const walk = async (itemId: string, parentEntryId: string | null, path: string) => {
          assert(!visited.has(itemId), 'VALIDATION_ERROR', 'Select each file or folder only once.');
          visited.add(itemId);
          assert(
            entries.length < 15,
            'OPERATION_TOO_LARGE',
            'Preparing this folder in the background.',
            413,
          );
          const item = await this.owned(tx, userId, itemId);
          const version = item.currentVersionId
            ? await tx.get<FileVersion>(
                userPK(userId),
                `VERSION#${itemId}#${item.currentVersionId}`,
              )
            : undefined;
          const e: ManifestEntry = {
            id: uid(),
            sourceDriveItemId: item.id,
            sourceVersionId: version?.id ?? null,
            displayName: item.name,
            relativePath: path + item.name,
            parentEntryId,
            itemType: item.type,
            sizeBytes: item.sizeBytes,
            mimeType: item.mimeType,
            contentHash: version?.contentHash ?? null,
            storageObjectId: version?.storageObjectId ?? null,
          };
          entries.push(e);
          if (version) await this.reference(tx, version.storageObjectId, 1, userId);
          if (item.type === 'FOLDER') {
            const page = await this.repo.query(userPK(userId), `CHILD#${item.id}#`, 16);
            assert(
              !page.cursor,
              'OPERATION_TOO_LARGE',
              'Preparing this folder in the background.',
              413,
            );
            for (const row of page.rows)
              await walk((row.data as { id: string }).id, e.id, e.relativePath + '/');
          }
        };
        for (const i of input.items) await walk(i.driveItemId, null, '');
        const t: Transfer = {
          displayNames: entries.filter((e) => !e.parentEntryId).map((e) => e.displayName),
          id: uid(),
          senderUserId: userId,
          ...resolved,
          state: resolved.recipientUserId ? 'PENDING' : 'PENDING_RECIPIENT_SIGNUP',
          createdAt: now(),
          acceptedAt: null,
          declinedAt: null,
          cancelledAt: null,
          expiresAt: new Date(Date.now() + 30 * 86400_000).toISOString(),
          totalSizeBytes: entries.reduce((n, e) => n + e.sizeBytes, 0),
          savedAt: null,
        };
        await tx.put('TRANSFER', t.id, t);
        for (const e of entries) await tx.put(`TRANSFER#${t.id}`, `ENTRY#${e.id}`, e);
        await tx.put(userPK(userId), `SENT#${t.id}`, { id: t.id });
        if (t.recipientUserId) {
          await tx.put(userPK(t.recipientUserId), `RECEIVED#${t.id}`, { id: t.id });
          await this.notification(tx, t.recipientUserId, 'TRANSFER_RECEIVED', { transferId: t.id });
          await this.record(tx, t.recipientUserId, 'TRANSFER_CREATED', t.id);
        } else {
          await tx.put(`PENDING#${t.recipientEmail}`, t.id, { id: t.id });
          await this.job(tx, {
            id: `invite-${t.id}`,
            type: 'EMAIL',
            to: t.recipientEmail!,
            sender: account.displayName,
            dueAt: now(),
            attempts: 0,
          });
        }
        await this.job(tx, {
          id: `expire-transfer-${t.id}`,
          type: 'TRANSFER_EXPIRE',
          entityId: t.id,
          dueAt: t.expiresAt!,
          attempts: 0,
        });
        await this.record(tx, userId, 'TRANSFER_CREATED', t.id);
        return { transfer: t };
      },
    );
  }
  async claimPending(userId: string) {
    const account = await this.account(new Transaction(this.repo), userId);
    let cursor: string | undefined;
    do {
      const page = await this.repo.query(`PENDING#${account.email}`, '', 50, cursor);
      for (const row of page.rows)
        await transact(this.repo, async (tx) => {
          const t = await tx.get<Transfer>('TRANSFER', row.sk);
          if (!t || t.state !== 'PENDING_RECIPIENT_SIGNUP') return;
          assert(
            t.recipientEmail === account.email && account.emailVerified,
            'TRANSFER_RECIPIENT_MISMATCH',
            'Verified email does not match.',
            403,
          );
          if (t.expiresAt && t.expiresAt <= now()) return;
          t.recipientUserId = userId;
          t.state = 'PENDING';
          await tx.put('TRANSFER', t.id, t);
          await tx.delete(`PENDING#${account.email}`, t.id);
          await tx.put(userPK(userId), `RECEIVED#${t.id}`, { id: t.id });
          await this.notification(tx, userId, 'TRANSFER_RECEIVED', { transferId: t.id });
          await this.record(tx, userId, 'TRANSFER_CREATED', t.id);
        });
      cursor = page.cursor ?? undefined;
    } while (cursor);
  }
  async listTransfers(
    userId: string,
    direction: 'received' | 'sent',
    limit = 50,
    cursor?: string,
    state?: string,
  ) {
    if (direction === 'received') await this.claimPending(userId);
    const page = await this.repo.query(
      userPK(userId),
      direction === 'received' ? 'RECEIVED#' : 'SENT#',
      limit,
      cursor,
    );
    const tx = new Transaction(this.repo);
    const items = [];
    for (const r of page.rows) {
      const t = await tx.get<Transfer>('TRANSFER', (r.data as { id: string }).id);
      if (!t || (state && state !== t.state)) continue;
      const manifestPage = await this.repo.query(`TRANSFER#${t.id}`, 'ENTRY#', 100);
      const entries = manifestPage.rows.map((r) => r.data as ManifestEntry);
      const sender = await this.account(tx, t.senderUserId);
      const recipient = t.recipientUserId ? await this.account(tx, t.recipientUserId) : undefined;
      items.push({
        ...t,
        nextEntryCursor: manifestPage.cursor,
        items: entries.map(({ storageObjectId: _, ...e }) => e),
        sender: { username: sender.username, displayName: sender.displayName },
        recipient: recipient
          ? { username: recipient.username, displayName: recipient.displayName }
          : null,
      });
    }
    return { items, nextCursor: page.cursor };
  }
  async transferAction(
    userId: string,
    id: string,
    action: 'accept' | 'decline' | 'cancel',
    operationId: string,
  ) {
    return this.operation(userId, operationId, { action, id }, async (tx) => {
      const t = await tx.get<Transfer & { preparationState?: string }>('TRANSFER', id);
      assert(t, 'TRANSFER_NOT_FOUND', 'Transfer was not found.', 404);
      assert(
        action === 'cancel' ? t.senderUserId === userId : t.recipientUserId === userId,
        'TRANSFER_NOT_ALLOWED',
        'This transfer does not belong to you.',
        403,
      );
      assert(
        !t.expiresAt || t.expiresAt > now(),
        'TRANSFER_EXPIRED',
        'This transfer expired.',
        410,
      );
      assert(
        t.preparationState !== 'BUILDING',
        'TRANSFER_PREPARING',
        'Files are still being prepared. Try again shortly.',
        409,
      );
      const target = { accept: 'ACCEPTED', decline: 'DECLINED', cancel: 'CANCELLED' } as const;
      if (t.state === target[action]) return { transfer: t };
      assert(
        action === 'cancel'
          ? ['PENDING', 'PENDING_RECIPIENT_SIGNUP'].includes(t.state)
          : t.state === 'PENDING',
        'TRANSFER_NOT_ALLOWED',
        'This transfer can no longer be changed.',
        409,
      );
      t.state = target[action];
      if (action === 'accept') t.acceptedAt = now();
      if (action === 'decline') t.declinedAt = now();
      if (action === 'cancel') t.cancelledAt = now();
      if (action !== 'accept')
        await this.job(tx, {
          id: `release-${id}`,
          type: 'TRANSFER_RELEASE',
          entityId: id,
          dueAt: now(),
          attempts: 0,
        });
      await tx.put('TRANSFER', id, t);
      if (t.recipientUserId) await this.record(tx, t.recipientUserId, `TRANSFER_${t.state}`, id);
      await this.record(tx, t.senderUserId, `TRANSFER_${t.state}`, id);
      await this.notification(tx, t.senderUserId, `TRANSFER_${t.state}`, { transferId: id });
      return { transfer: t };
    });
  }
  async saveTransfer(
    userId: string,
    id: string,
    input: { operationId: string; targetParentId: string | null },
  ) {
    const page = await this.repo.query(`TRANSFER#${id}`, 'ENTRY#', 9);
    if (page.rows.length > 8 || page.cursor)
      return new TransferWorkflows(this).save(userId, id, input);
    try {
      return await this.saveTransferAtomic(userId, id, input);
    } catch (e) {
      if (e instanceof DomainError && e.code === 'OPERATION_TOO_LARGE')
        return new TransferWorkflows(this).save(userId, id, input);
      throw e;
    }
  }
  async transferItems(userId: string, id: string, cursor?: string) {
    const t = await new Transaction(this.repo).get<Transfer>('TRANSFER', id);
    assert(
      t && (t.senderUserId === userId || t.recipientUserId === userId),
      'TRANSFER_NOT_ALLOWED',
      'This transfer is not addressed to you.',
      403,
    );
    const page = await this.repo.query(`TRANSFER#${id}`, 'ENTRY#', 100, cursor);
    return {
      items: page.rows.map((r) => {
        const { storageObjectId: _, ...entry } = r.data as ManifestEntry;
        return entry;
      }),
      nextCursor: page.cursor,
    };
  }
  private async saveTransferAtomic(
    userId: string,
    id: string,
    input: { operationId: string; targetParentId: string | null },
  ) {
    return this.operation(
      userId,
      input.operationId,
      { action: 'save', id, ...input },
      async (tx) => {
        const t = await tx.get<Transfer>('TRANSFER', id);
        assert(
          t && t.recipientUserId === userId && t.state === 'ACCEPTED',
          'TRANSFER_NOT_ALLOWED',
          'Accept this transfer before saving it.',
          403,
        );
        assert(
          !t.expiresAt || t.expiresAt > now(),
          'TRANSFER_EXPIRED',
          'This transfer expired.',
          410,
        );
        if (t.savedAt) {
          const saved = await tx.get<{ items: DriveItem[] }>(userPK(userId), `SAVED#${id}`);
          return saved!;
        }
        await this.parent(tx, userId, input.targetParentId);
        await assertBackupMutable(tx, userId, input.targetParentId);
        const account = await this.account(tx, userId);
        assert(
          t.totalSizeBytes <= storageUsage(account).availableBytes,
          'STORAGE_QUOTA_EXCEEDED',
          'There is not enough storage to save this transfer.',
          409,
        );
        const entries = await tx.list<ManifestEntry>(`TRANSFER#${id}`, 'ENTRY#');
        const ids = new Map(entries.map((e) => [e.id, uid()]));
        const items: DriveItem[] = [];
        for (const e of entries) {
          const item = this.newItem(
            userId,
            e.parentEntryId ? ids.get(e.parentEntryId)! : input.targetParentId,
            e.displayName,
            e.itemType,
            ids.get(e.id),
          );
          if (e.itemType === 'FILE') {
            const v: FileVersion = {
              id: uid(),
              driveItemId: item.id,
              storageObjectId: e.storageObjectId!,
              sizeBytes: e.sizeBytes,
              contentHash: e.contentHash!,
              contentHashAlgorithm: 'SHA256',
              sourceDeviceId: null,
              versionNumber: 1,
              createdAt: now(),
            };
            item.sizeBytes = e.sizeBytes;
            item.mimeType = e.mimeType;
            item.currentVersionId = v.id;
            await this.reference(tx, v.storageObjectId, 1);
            await tx.put(userPK(userId), `VERSION#${item.id}#${v.id}`, v);
          }
          await this.reserveName(tx, item);
          items.push(item);
        }
        account.storageUsedBytes += t.totalSizeBytes;
        await tx.put(userPK(userId), 'PROFILE', account);
        for (const item of items)
          await this.record(
            tx,
            userId,
            item.type === 'FILE' ? 'FILE_CREATED' : 'FOLDER_CREATED',
            item.id,
            item,
          );
        t.savedAt = now();
        await tx.put('TRANSFER', id, t);
        await tx.put(userPK(userId), `SAVED#${id}`, { items });
        return { items };
      },
    );
  }
  async createShare(
    userId: string,
    input: {
      operationId: string;
      driveItemId: string;
      recipient: { type: 'USERNAME' | 'EMAIL'; value: string };
      permission: 'VIEWER' | 'EDITOR';
    },
  ) {
    return this.operation(userId, input.operationId, { action: 'share', ...input }, async (tx) => {
      await this.owned(tx, userId, input.driveItemId);
      await assertBackupMutable(tx, userId, input.driveItemId, true);
      const recipient = await this.resolveRecipient(tx, input.recipient);
      assert(
        recipient.recipientUserId && recipient.recipientUserId !== userId,
        'USER_NOT_FOUND',
        'Sharing requires another registered account.',
        404,
      );
      const prior = await tx.get<ShareGrant>(
        userPK(recipient.recipientUserId),
        `ACCESS#${input.driveItemId}`,
      );
      assert(!prior?.syncState, 'INVALID_STATE', 'Manage this folder from Sync sharing.', 409);
      const share: ShareGrant = {
        id: prior?.id ?? uid(),
        driveItemId: input.driveItemId,
        ownerUserId: userId,
        recipientUserId: recipient.recipientUserId,
        permission: input.permission,
        createdAt: prior?.createdAt ?? now(),
        revokedAt: null,
      };
      await tx.put('SHARE', share.id, share);
      await tx.put(userPK(recipient.recipientUserId), `ACCESS#${input.driveItemId}`, share);
      await tx.put(userPK(userId), `SHARE#${share.id}`, share);
      await this.notification(tx, share.recipientUserId, 'SHARE_RECEIVED', { shareId: share.id });
      await this.record(tx, share.recipientUserId, 'SHARE_CHANGED', share.id);
      await this.record(tx, userId, 'SHARE_CHANGED', share.id);
      return { share };
    });
  }
  async revokeShare(userId: string, id: string, operationId: string) {
    return this.operation(userId, operationId, { action: 'revokeShare', id }, async (tx) => {
      const share = await tx.get<ShareGrant>('SHARE', id);
      assert(
        share && share.ownerUserId === userId,
        'SHARE_NOT_ALLOWED',
        'Only the owner can remove access.',
        403,
      );
      share.revokedAt = now();
      if (share.syncState) await syncMembershipChanged(tx, share.ownerUserId);
      await tx.put('SHARE', id, share);
      const current = await tx.get<ShareGrant>(
        userPK(share.recipientUserId),
        `ACCESS#${share.driveItemId}`,
      );
      if (current?.id === share.id)
        await tx.put(userPK(share.recipientUserId), `ACCESS#${share.driveItemId}`, share);
      await tx.put(userPK(userId), `SHARE#${id}`, share);
      await this.record(tx, share.recipientUserId, 'SHARE_CHANGED', id);
      return { share };
    });
  }
  async shares(userId: string, received: boolean) {
    const tx = new Transaction(this.repo);
    const shares = await tx.list<ShareGrant>(userPK(userId), received ? 'ACCESS#' : 'SHARE#');
    const items = [];
    for (const share of shares) {
      if (share.revokedAt || (share.syncState && share.syncState !== 'ACCEPTED')) continue;
      try {
        const item = await this.owned(tx, share.ownerUserId, share.driveItemId);
        items.push({ ...share, item });
      } catch {
        /* Deleted shared items are inaccessible. */
      }
    }
    return { items };
  }
  async sharedList(userId: string, parentId: string, limit: number, cursor?: string) {
    const { owner, item } = await this.authorized(new Transaction(this.repo), userId, parentId);
    assert(item.type === 'FOLDER', 'PARENT_NOT_FOUND', 'Choose a folder.', 400);
    return this.list(owner, parentId, limit, cursor);
  }
  async registerDevice(
    userId: string,
    input: {
      name: string;
      platform: Device['platform'];
      devicePublicId?: string;
      appVersion?: string;
    },
    sessionId?: string,
  ) {
    return transact(this.repo, async (tx) => {
      const id = sessionId ?? uid();
      const existing = await tx.get<DeviceSession>(userPK(userId), `DEVICE#${id}`);
      const status = existing ? await this.deviceStatus(tx, existing) : undefined;
      assert(
        !status?.revokedAt,
        'DEVICE_REVOKED',
        'This device has been revoked. Sign in again.',
        403,
      );
      assert(
        !existing?.devicePublicId ||
          !input.devicePublicId ||
          existing.devicePublicId === input.devicePublicId,
        'VALIDATION_ERROR',
        'A registered session cannot change its device identity.',
      );
      const devicePublicId = existing?.devicePublicId ?? (input.devicePublicId || null);
      const revocation = devicePublicId
        ? await tx.get<DeviceRevocation>(userPK(userId), deviceRevocationKey(devicePublicId))
        : undefined;
      const device: Device = {
        id,
        userId,
        name: input.name,
        platform: input.platform,
        appVersion: input.appVersion ?? null,
        devicePublicId,
        lastSeenAt: now(),
        createdAt: existing?.createdAt ?? now(),
        revokedAt: null,
      };
      await tx.put(userPK(userId), `DEVICE#${id}`, {
        ...device,
        revocationVersion: revocation?.version ?? 0,
      });
      await this.record(tx, userId, 'DEVICE_REGISTERED', id);
      return { device };
    });
  }
  async revokeDevice(userId: string, id: string) {
    return transact(this.repo, async (tx) => {
      const d = await tx.get<DeviceSession>(userPK(userId), `DEVICE#${id}`);
      assert(d, 'DEVICE_NOT_FOUND', 'Device was not found.', 404);
      d.revokedAt = now();
      if (d.devicePublicId) {
        const key = deviceRevocationKey(d.devicePublicId);
        const prior = await tx.get<DeviceRevocation>(userPK(userId), key);
        await tx.put(userPK(userId), key, {
          version: (prior?.version ?? 0) + 1,
          revokedAt: d.revokedAt,
        });
      }
      await tx.put(userPK(userId), `DEVICE#${id}`, d);
      await tx.delete(userPK(userId), `SYNCFOLDERS#${digest(syncDeviceKey(d))}`);
      await syncMembershipChanged(tx, userId);
      await this.record(tx, userId, 'DEVICE_REVOKED', id);
      return { device: await this.deviceStatus(tx, d) };
    });
  }
  async revokeSession(userId: string, id: string) {
    return transact(this.repo, async (tx) => {
      const d = await tx.get<DeviceSession>(userPK(userId), `DEVICE#${id}`);
      assert(d, 'DEVICE_NOT_FOUND', 'Device was not found.', 404);
      d.revokedAt = now();
      await tx.put(userPK(userId), `DEVICE#${id}`, d);
      await this.record(tx, userId, 'DEVICE_REVOKED', id);
      return { device: await this.deviceStatus(tx, d) };
    });
  }
  private async deviceStatus(tx: Transaction, session: DeviceSession): Promise<Device> {
    const { revocationVersion = 0, ...device } = session;
    if (device.devicePublicId) {
      const revocation = await tx.get<DeviceRevocation>(
        userPK(device.userId),
        deviceRevocationKey(device.devicePublicId),
      );
      if (revocation && revocationVersion < revocation.version)
        device.revokedAt ??= revocation.revokedAt;
    }
    return device;
  }
  async checkDevice(userId: string, id: string) {
    const tx = new Transaction(this.repo);
    const session = await tx.get<DeviceSession>(userPK(userId), `DEVICE#${id}`);
    const d = session ? await this.deviceStatus(tx, session) : undefined;
    assert(d && !d.revokedAt, 'DEVICE_REVOKED', 'This device is revoked. Sign in again.', 403);
    return d;
  }
  async devices(userId: string) {
    const tx = new Transaction(this.repo);
    const sessions = await tx.list<DeviceSession>(userPK(userId), 'DEVICE#');
    const installations = new Map<string, Device>();
    for (const session of sessions) {
      const device = await this.deviceStatus(tx, session);
      const key = device.devicePublicId
        ? `installation:${device.devicePublicId}`
        : `session:${device.id}`;
      const prior = installations.get(key);
      // Prefer an active session, then the most recently seen session, for display/revocation.
      if (!prior) installations.set(key, device);
      else {
        const latest =
          (Boolean(prior.revokedAt) && !device.revokedAt) ||
          (Boolean(prior.revokedAt) === Boolean(device.revokedAt) &&
            (device.lastSeenAt ?? '') > (prior.lastSeenAt ?? ''))
            ? device
            : prior;
        installations.set(key, {
          ...latest,
          createdAt: prior.createdAt < device.createdAt ? prior.createdAt : device.createdAt,
        });
      }
    }
    return { items: [...installations.values()] };
  }
  async setSyncFolders(userId: string, deviceId: string, folderIds: string[]) {
    const device = await this.checkDevice(userId, deviceId);
    const key = device.devicePublicId
      ? `installation:${device.devicePublicId}`
      : `session:${device.id}`;
    return transact(this.repo, async (tx) => {
      await tx.get(userPK(userId), 'SYNC_MEMBERSHIP');
      const ids: string[] = [];
      const removedFolderIds: string[] = [];
      const shareIds: Record<string, string> = {};
      const lookup = new Transaction(this.repo);
      for (const id of new Set(folderIds)) {
        try {
          const locator = await lookup.get<{ userId: string }>('ITEMOWNER', id);
          if (locator?.userId && locator.userId !== userId)
            await tx.get(userPK(locator.userId), 'SYNC_MEMBERSHIP');
          const { item, owner } = await this.authorized(lookup, userId, id, true);
          if (item.type !== 'FOLDER') continue;
          await assertBackupMutable(tx, owner, id, true);
          if (owner !== userId) {
            const grant = await lookup.get<ShareGrant>(userPK(userId), `ACCESS#${id}`);
            assert(
              grant?.syncState === 'ACCEPTED' && !grant.revokedAt,
              'FORBIDDEN',
              'Accept this shared sync folder first.',
              403,
            );
            shareIds[id] = grant.id;
          }
          ids.push(id);
        } catch (error) {
          if (
            error instanceof DomainError &&
            ['SYNC_REMOVED', 'FORBIDDEN', 'ITEM_NOT_FOUND', 'PARENT_NOT_FOUND'].includes(error.code)
          )
            removedFolderIds.push(id);
          else if (
            !(error instanceof DomainError) ||
            !['ITEM_NOT_FOUND', 'PARENT_NOT_FOUND'].includes(error.code)
          )
            throw error;
        }
      }
      const previous = await tx.get<SyncMapping>(userPK(userId), `SYNCFOLDERS#${digest(key)}`);
      const epochs = Object.fromEntries(
        ids.map((id) => [
          id,
          previous?.folderIds.includes(id) ? (previous.epochs?.[id] ?? 'legacy') : uid(),
        ]),
      );
      await tx.put(userPK(userId), `SYNCFOLDERS#${digest(key)}`, {
        key,
        folderIds: ids,
        epochs,
        shareIds,
      });
      await syncMembershipChanged(tx, userId);
      return { ok: true, removedFolderIds };
    });
  }
  async removeSyncFolder(userId: string, folderId: string) {
    return transact(this.repo, async (tx) => {
      const item = await tx.get<DriveItem>(userPK(userId), `ITEM#${folderId}`);
      assert(
        item?.type === 'FOLDER' && !item.deletedAt,
        'ITEM_NOT_FOUND',
        'Sync folder was not found.',
        404,
      );
      await assertBackupMutable(tx, userId, folderId, true);
      if (item.syncRemovedAt) return { ok: true };
      // Keep a tombstone so offline clients cannot silently restore this mapping.
      await tx.get(userPK(userId), 'SYNC_MEMBERSHIP');
      const mappings = await new Transaction(this.repo).list<SyncMapping>(
        userPK(userId),
        'SYNCFOLDERS#',
      );
      assert(
        mappings.some((mapping) => mapping.folderIds.includes(folderId)),
        'INVALID_STATE',
        'This folder is not linked for sync.',
        409,
      );
      await tx.put(userPK(userId), `ITEM#${item.id}`, { ...item, syncRemovedAt: now() });
      await syncMembershipChanged(tx, userId);
      // No FILE_DELETED event: every desktop must keep its local directory and contents.
      await this.record(tx, userId, 'SYNC_FOLDER_REMOVED', item.id);
      return { ok: true };
    });
  }
  async syncFolders(userId: string) {
    const tx = new Transaction(this.repo);
    const mappings = await tx.list<{ key: string; folderIds: string[] }>(
      userPK(userId),
      'SYNCFOLDERS#',
    );
    const ids = new Set(mappings.flatMap((mapping) => mapping.folderIds));
    const devices = (await this.devices(userId)).items.filter((device) => !device.revokedAt);
    const byKey = new Map(
      devices.map((device) => [
        device.devicePublicId ? `installation:${device.devicePublicId}` : `session:${device.id}`,
        device,
      ]),
    );
    const items: (DriveItem & { syncDevices: { id: string; name: string }[] })[] = [];
    for (const id of ids) {
      try {
        const { item } = await this.authorized(tx, userId, id);
        if (item.type === 'FOLDER' && !(await backupForItem(tx, item.ownerUserId, item.id)))
          items.push({
            ...item,
            syncDevices: mappings
              .filter((mapping) => mapping.folderIds.includes(id))
              .flatMap((mapping) => {
                const device = byKey.get(mapping.key);
                return device ? [{ id: device.id, name: device.name }] : [];
              })
              .sort((a, b) => a.name.localeCompare(b.name)),
          });
      } catch (error) {
        if (
          !(error instanceof DomainError) ||
          ![
            'FORBIDDEN',
            'ITEM_NOT_FOUND',
            'PARENT_NOT_FOUND',
            'ITEM_DELETING',
            'SYNC_REMOVED',
          ].includes(error.code)
        )
          throw error;
      }
    }
    return { items };
  }
  async changes(userId: string, cursor: number, limit: number) {
    const u = await this.account(new Transaction(this.repo), userId);
    assert(
      cursor >= u.minCursor,
      'SYNC_CURSOR_EXPIRED',
      'Perform a full metadata reconciliation.',
      410,
    );
    assert(cursor <= u.sequence, 'VALIDATION_ERROR', 'Sync cursor is ahead of the server.');
    const page = await this.repo.query(
      userPK(userId),
      'CHANGE#',
      limit,
      undefined,
      `CHANGE#${String(cursor).padStart(16, '0')}`,
    );
    const changes = page.rows.map((r) => r.data as SyncChange);
    return {
      changes,
      nextCursor: changes.at(-1)?.sequence ?? cursor,
      hasMore: page.cursor !== null,
    };
  }
  async checkpoint(userId: string, deviceId: string, cursor: number) {
    await this.checkDevice(userId, deviceId);
    return transact(this.repo, async (tx) => {
      const u = await this.account(tx, userId);
      assert(cursor <= u.sequence, 'VALIDATION_ERROR', 'Cursor is ahead of server.');
      const prior = await tx.get<{ cursor: number }>(userPK(userId), `CHECKPOINT#${deviceId}`);
      assert(
        !prior || cursor >= prior.cursor,
        'VALIDATION_ERROR',
        'Checkpoint cannot move backwards.',
      );
      await tx.put(userPK(userId), `CHECKPOINT#${deviceId}`, { cursor, updatedAt: now() });
      return { cursor };
    });
  }
  async notifications(userId: string, limit = 50, cursor?: string) {
    const page = await this.repo.query(userPK(userId), 'NOTIFICATION#', limit, cursor);
    return { items: page.rows.map((r) => r.data), nextCursor: page.cursor };
  }
  async markNotification(userId: string, id: string) {
    return transact(this.repo, async (tx) => {
      const locator = await tx.get<{ key: string }>(userPK(userId), `NOTIFICATION_ID#${id}`);
      assert(locator, 'ITEM_NOT_FOUND', 'Notification was not found.', 404);
      const notification = await tx.get<{ readAt: string | null }>(userPK(userId), locator.key);
      assert(notification, 'ITEM_NOT_FOUND', 'Notification was not found.', 404);
      notification.readAt = now();
      await tx.put(userPK(userId), locator.key, notification);
      return { notification };
    });
  }
  async updateProfile(
    userId: string,
    input: {
      operationId: string;
      username?: string;
      displayName?: string;
      appearance?: AppearancePreference;
    },
  ) {
    return this.operation(
      userId,
      input.operationId,
      { action: 'profile', ...input },
      async (tx) => {
        const user = (await this.account(tx, userId)) as Account & { usernameChangedAt?: string };
        if (input.username && input.username !== user.username) {
          assert(
            !user.usernameChangedAt ||
              Date.parse(user.usernameChangedAt) < Date.now() - 30 * 86400_000,
            'USERNAME_CHANGE_LIMIT',
            'You can change your username once every 30 days.',
            429,
          );
          const normalized = usernameSchema.parse(input.username);
          const claim = await tx.get<{ userId: string; email?: string }>('USERNAME', normalized);
          assert(
            !claim || claim.userId === userId,
            'USERNAME_TAKEN',
            'This username is taken.',
            409,
          );
          await tx.delete('USERNAME', user.username);
          await tx.put('USERNAME', normalized, { userId });
          user.username = normalized;
          user.usernameChangedAt = now();
        }
        if (input.displayName) user.displayName = input.displayName;
        if (input.appearance) user.appearance = input.appearance;
        user.updatedAt = now();
        await tx.put(userPK(userId), 'PROFILE', user);
        await this.record(tx, userId, 'PROFILE_UPDATED', userId);
        return { user };
      },
    );
  }
  async backupRoot(userId: string, input: { operationId: string; deviceId: string; name: string }) {
    await this.checkDevice(userId, input.deviceId);
    return this.operation(userId, input.operationId, { action: 'backup', ...input }, async (tx) => {
      const backupId = uid();
      const item = this.newItem(
        userId,
        null,
        filename.parse(`${input.name.slice(0, 200)} — backup ${backupId.slice(0, 8)}`),
        'FOLDER',
      );
      await this.reserveName(tx, item);
      const root = {
        id: backupId,
        userId,
        deviceId: input.deviceId,
        localPathDisplayName: input.name,
        remoteRootDriveItemId: item.id,
        state: 'ACTIVE',
        createdAt: now(),
        updatedAt: now(),
      };
      await tx.put(userPK(userId), `BACKUP#${root.id}`, root);
      await this.record(tx, item.ownerUserId, 'FOLDER_CREATED', item.id, item);
      return { root };
    });
  }
  async backups(userId: string) {
    const tx = new Transaction(this.repo);
    const roots = await tx.list<BackupRoot>(userPK(userId), 'BACKUP#');
    return {
      items: await Promise.all(
        roots.map(async (root) => ({
          ...root,
          deviceName:
            (await tx.get<Device>(userPK(userId), `DEVICE#${root.deviceId}`))?.name ??
            'Source computer',
        })),
      ),
    };
  }
  async runJobs(sendEmail?: (to: string, sender: string) => Promise<void>) {
    const deadline = Date.now() + 210_000;
    const page = await this.repo.due(now());
    for (const row of page.rows) {
      if (Date.now() >= deadline) break;
      const job = row.data as Job;
      try {
        const workflows = new TransferWorkflows(this);
        let complete = true;
        if (job.type === 'CLOUD_COPY') complete = await new CloudCopies(this).step(job.entityId!);
        if (job.type === 'CLOUD_MIRROR')
          complete = await new CloudCopies(this).mirror(job.entityId!);
        if (job.type === 'SYNC_RELEASE')
          complete = await new SyncRelay(this).release(job.userId!, job.entityId!);
        if (job.type === 'ARCHIVE_BUILD')
          complete = await new ArchiveWorkflows(this).step(
            job.entityId!,
            Math.min(deadline, Date.now() + 120_000),
          );
        if (job.type === 'ARCHIVE_EXPIRE')
          complete = await new ArchiveWorkflows(this).cleanup(
            job.entityId!,
            Math.min(deadline, Date.now() + 30_000),
          );
        if (job.type === 'PERMANENT_DELETE')
          complete = await new DeletionWorkflows(this).step(job.userId!, job.entityId!);
        if (job.type === 'TRANSFER_BUILD') complete = await workflows.build(job.entityId!);
        if (job.type === 'TRANSFER_SAVE') complete = await workflows.saveBatch(job.entityId!);
        if (job.type === 'TRANSFER_RELEASE') complete = await workflows.release(job.entityId!);
        if (job.type === 'TRANSFER_EXPIRE') complete = await workflows.expire(job.entityId!);
        if (!complete) {
          await transact(this.repo, (tx) =>
            this.job(tx, {
              ...job,
              dueAt: new Date(
                Date.now() + (['SYNC_RELEASE', 'CLOUD_MIRROR'].includes(job.type) ? 60000 : 1000),
              ).toISOString(),
            }),
          );
          continue;
        }
        if (job.type === 'UPLOAD_EXPIRE') {
          const u = await this.getUpload(job.userId!, job.entityId!);
          if (u.expiresAt <= now()) await this.abortUpload(job.userId!, job.entityId!, 'EXPIRED');
        }
        if (job.type === 'OBJECT_DELETE') {
          // Zero-reference objects cannot acquire new references: every reference source itself pins the object.
          const object = await new Transaction(this.repo).get<StoredObject>(
            'OBJECT',
            job.entityId!,
          );
          if (!object || object.references === 0) {
            await this.storage.remove(object?.key ?? job.key!);
            await transact(this.repo, async (tx) => {
              const current = await tx.get<StoredObject>('OBJECT', job.entityId!);
              if (current?.references === 0) await tx.delete('OBJECT', job.entityId!);
            });
          }
        }
        if (job.type === 'EMAIL') {
          assert(
            sendEmail,
            'EMAIL_NOT_CONFIGURED',
            'Invitation email delivery is not configured.',
            503,
          );
          await sendEmail(job.to!, job.sender!);
        }
        await transact(this.repo, (tx) => tx.delete('JOB', job.id));
      } catch {
        await transact(this.repo, async (tx) => {
          const current = await tx.get<Job>('JOB', job.id);
          if (current) {
            current.attempts++;
            current.dueAt = new Date(
              Date.now() + Math.min(86400, 60 * 2 ** Math.min(10, current.attempts)) * 1000,
            ).toISOString();
            await this.job(tx, current);
          }
        });
        console.error(
          JSON.stringify({ event: 'job_failed', jobType: job.type, attempts: job.attempts + 1 }),
        );
      }
    }
    return { processed: page.rows.length };
  }
}
