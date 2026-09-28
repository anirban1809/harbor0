import { createHash } from 'node:crypto';
import type { Device, DriveItem, FileVersion, SyncItemStatus, ShareGrant } from '@harbor/contracts';
import { StorageService, userPK, type StoredObject } from './domain';
import { Transaction, transact } from './repository';
import { assert, DomainError } from './errors';
import type { CloudMirrorLinks, CopyWait } from './cloud-copies';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const syncDeviceKey = (device: Pick<Device, 'id' | 'devicePublicId'>) =>
  device.devicePublicId ? `installation:${device.devicePublicId}` : `session:${device.id}`;
export type SyncMapping = {
  key: string;
  folderIds: string[];
  epochs?: Record<string, string>;
  shareIds?: Record<string, string>;
};
type Receipt = { epoch: string; at: string };
type Delivery = {
  version: string;
  receipts: Record<string, Receipt>;
  cleanupCursor?: string;
  retained?: boolean;
};
const versionKey = (item: DriveItem) =>
  item.type === 'FILE' ? item.currentVersionId! : `folder:${item.revision}`;

// The generation guard makes membership changes conflict with acknowledgements
// and cleanup, without placing every device row in the same DynamoDB transaction.
export async function syncMembershipChanged(tx: Transaction, userId: string) {
  const old = await tx.get<{ generation: number }>(userPK(userId), 'SYNC_MEMBERSHIP');
  await tx.put(userPK(userId), 'SYNC_MEMBERSHIP', { generation: (old?.generation ?? 0) + 1 });
}
export class SyncRelay {
  constructor(private service: StorageService) {}
  private async mappings(tx: Transaction, userId: string) {
    await tx.get(userPK(userId), 'SYNC_MEMBERSHIP');
    const result: SyncMapping[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.service.repo.query(userPK(userId), 'SYNCFOLDERS#', 100, cursor);
      result.push(...page.rows.map((row) => row.data as SyncMapping));
      cursor = page.cursor ?? undefined;
    } while (cursor);
    const shares = await new Transaction(this.service.repo).list<ShareGrant>(
      userPK(userId),
      'SHARE#',
    );
    for (const share of shares) {
      if (share.syncState !== 'ACCEPTED' || share.revokedAt) continue;
      await tx.get(userPK(share.recipientUserId), 'SYNC_MEMBERSHIP');
      const mappings = await new Transaction(this.service.repo).list<SyncMapping>(
        userPK(share.recipientUserId),
        'SYNCFOLDERS#',
      );
      for (const mapping of mappings) {
        if (
          !mapping.folderIds.includes(share.driveItemId) ||
          mapping.shareIds?.[share.driveItemId] !== share.id
        )
          continue;
        const key = `account:${share.recipientUserId}:${mapping.key}`;
        let entry = result.find((m) => m.key === key);
        if (!entry) {
          entry = { key, folderIds: [], epochs: {} };
          result.push(entry);
        }
        entry.folderIds.push(share.driveItemId);
        entry.epochs![share.driveItemId] =
          `${share.id}:${mapping.epochs?.[share.driveItemId] ?? 'legacy'}`;
      }
    }
    return result;
  }
  private async participants(
    tx: Transaction,
    userId: string,
    item: DriveItem,
    mappings: SyncMapping[],
  ) {
    const ancestors = new Set<string>([item.id]);
    let id = item.parentId;
    while (id) {
      assert(
        !ancestors.has(id) && ancestors.size <= 33,
        'INVALID_PARENT',
        'The sync folder path is invalid.',
      );
      ancestors.add(id);
      const parent = await this.service.owned(tx, userId, id);
      id = parent.parentId;
    }
    const result: Record<string, string> = {};
    for (const mapping of mappings) {
      const roots = mapping.folderIds.filter((id) => ancestors.has(id)).sort();
      if (roots.length)
        result[digest(mapping.key)] = digest(
          roots.map((id) => `${id}:${mapping.epochs?.[id] ?? 'legacy'}`).join('|'),
        );
    }
    return result;
  }
  private counts(item: DriveItem, required: Record<string, string>, delivery?: Delivery) {
    const participants = Object.entries(required);
    const confirmed =
      delivery?.version === versionKey(item)
        ? participants.filter(([key, epoch]) => delivery.receipts[key]?.epoch === epoch).length
        : 0;
    return { requiredDevices: participants.length, confirmedDevices: confirmed };
  }
  async acknowledge(
    userId: string,
    deviceId: string,
    itemId: string,
    input: { versionId: string | null; revision: number; contentHash: string | null },
  ) {
    const device = await this.service.checkDevice(userId, deviceId);
    assert(
      device.platform !== 'WEB',
      'FORBIDDEN',
      'Only a syncing desktop can confirm a local copy.',
      403,
    );
    return transact(this.service.repo, async (tx) => {
      const { item, owner } = await this.service.authorized(tx, userId, itemId, true);
      const mappings = await this.mappings(tx, owner);
      assert(
        item.revision === input.revision && item.currentVersionId === input.versionId,
        'REVISION_CONFLICT',
        'Confirm the current file version.',
        409,
      );
      const required = await this.participants(tx, owner, item, mappings);
      const key = digest(
        owner === userId ? syncDeviceKey(device) : `account:${userId}:${syncDeviceKey(device)}`,
      );
      assert(required[key], 'FORBIDDEN', 'This device is not linked to this sync folder.', 403);
      if (item.type === 'FILE') {
        const version = await tx.get<FileVersion>(
          userPK(owner),
          `VERSION#${item.id}#${item.currentVersionId}`,
        );
        assert(
          version && version.contentHash === input.contentHash,
          'HASH_MISMATCH',
          'The local copy does not match this version.',
          409,
        );
      } else
        assert(
          input.contentHash === null,
          'VALIDATION_ERROR',
          'Folders do not have a content hash.',
        );
      let delivery = await tx.get<Delivery>(userPK(owner), `SYNCSTATE#${item.id}`);
      if (delivery?.version !== versionKey(item))
        delivery = { version: versionKey(item), receipts: {} };
      delivery!.receipts[key] = { epoch: required[key], at: new Date().toISOString() };
      assert(
        Object.keys(delivery!.receipts).length <= 1000,
        'OPERATION_TOO_LARGE',
        'Too many linked devices.',
      );
      await tx.put(userPK(owner), `SYNCSTATE#${item.id}`, delivery);
      const counts = this.counts(item, required, delivery);
      if (
        item.type === 'FILE' &&
        counts.requiredDevices > 0 &&
        counts.confirmedDevices === counts.requiredDevices
      ) {
        await this.service.job(tx, {
          id: `sync-release-${item.id}`,
          type: 'SYNC_RELEASE',
          userId: owner,
          entityId: item.id,
          dueAt: new Date().toISOString(),
          attempts: 0,
        });
      }
      return { ok: true, ...counts };
    });
  }
  async requestContent(userId: string, deviceId: string, itemId: string) {
    const device = await this.service.checkDevice(userId, deviceId);
    assert(device.platform !== 'WEB', 'FORBIDDEN', 'A linked desktop is required.', 403);
    return transact(this.service.repo, async (tx) => {
      const { item, owner } = await this.service.authorized(tx, userId, itemId, true);
      const mappings = await this.mappings(tx, owner);
      const required = await this.participants(tx, owner, item, mappings);
      assert(
        required[
          digest(
            owner === userId ? syncDeviceKey(device) : `account:${userId}:${syncDeviceKey(device)}`,
          )
        ],
        'FORBIDDEN',
        'This device is not linked to this folder.',
        403,
      );
      assert(item.type === 'FILE', 'VALIDATION_ERROR', 'Choose a file.');
      if (item.cloudState === 'RELEASED') {
        item.cloudState = 'REQUESTED';
        await tx.put(userPK(owner), `ITEM#${item.id}`, item);
        await this.service.record(tx, owner, 'SYNC_CONTENT_REQUESTED', item.id, item);
      }
      return { item };
    });
  }
  // Metadata is retained. Releasing bytes must never produce a FILE_DELETED event.
  async release(userId: string, itemId: string): Promise<boolean> {
    return transact(this.service.repo, async (tx) => {
      const wait = await tx.get<CopyWait>(userPK(userId), `CLOUDCOPYWAIT#${itemId}`);
      if (
        wait &&
        Object.values(wait.copies).some((expiresAt) => expiresAt > new Date().toISOString())
      )
        return false;
      const mappings = await this.mappings(tx, userId);
      const item = await tx.get<DriveItem & { purging?: boolean }>(
        userPK(userId),
        `ITEM#${itemId}`,
      );
      if (
        !item ||
        item.deletedAt ||
        item.purging ||
        item.type !== 'FILE' ||
        item.cloudState === 'REQUESTED'
      )
        return true;
      let required: Record<string, string>;
      try {
        required = await this.participants(tx, userId, item, mappings);
      } catch (error) {
        if (error instanceof DomainError && error.code === 'SYNC_REMOVED') return true;
        throw error;
      }
      const delivery = await tx.get<Delivery>(userPK(userId), `SYNCSTATE#${item.id}`);
      const counts = this.counts(item, required, delivery);
      if (!counts.requiredDevices || counts.confirmedDevices !== counts.requiredDevices)
        return true;
      // A backup remains durable even if someone also maps its folder for sync.
      let parent: DriveItem | undefined = item;
      const path = new Set<string>();
      while (parent) {
        path.add(parent.id);
        const mirrors = await tx.get<CloudMirrorLinks>(userPK(userId), `CLOUDMIRROR#${parent.id}`);
        if (mirrors?.copies.length) return true;
        parent = parent.parentId
          ? await tx.get<DriveItem>(userPK(userId), `ITEM#${parent.parentId}`)
          : undefined;
      }
      const backups = await new Transaction(this.service.repo).list<{
        remoteRootDriveItemId: string;
      }>(userPK(userId), 'BACKUP#');
      if (backups.some((backup) => path.has(backup.remoteRootDriveItemId))) return true;
      const page = await this.service.repo.query(
        userPK(userId),
        `VERSION#${item.id}#`,
        8,
        delivery!.cleanupCursor,
      );
      // Multiple versions of this file can reference the same object (Restore).
      // Count our live references so only references held by other features defer cleanup.
      const ownReferences = new Map<string, number>();
      let versionCursor: string | undefined;
      do {
        const versions = await this.service.repo.query(
          userPK(userId),
          `VERSION#${item.id}#`,
          100,
          versionCursor,
        );
        for (const row of versions.rows) {
          const version = row.data as FileVersion;
          if (version.cloudState !== 'RELEASED')
            ownReferences.set(
              version.storageObjectId,
              (ownReferences.get(version.storageObjectId) ?? 0) + 1,
            );
        }
        versionCursor = versions.cursor ?? undefined;
      } while (versionCursor);
      let retained = delivery!.retained ?? false;
      let releasedBytes = 0;
      for (const row of page.rows) {
        const version = await tx.get<FileVersion>(row.pk, row.sk);
        if (!version || version.cloudState === 'RELEASED') continue;
        const object = await tx.get<StoredObject>('OBJECT', version.storageObjectId);
        // Sent copies, saved copies, and archives keep their existing references.
        if (!object || object.references !== ownReferences.get(version.storageObjectId)) {
          retained = true;
          continue;
        }
        const released = await this.service.reference(tx, version.storageObjectId, -1);
        ownReferences.set(version.storageObjectId, ownReferences.get(version.storageObjectId)! - 1);
        if (released.references === 0)
          await this.service.job(tx, {
            id: `object-${released.id}`,
            type: 'OBJECT_DELETE',
            entityId: released.id,
            key: released.key,
            dueAt: new Date().toISOString(),
            attempts: 0,
          });
        await tx.put(row.pk, row.sk, { ...version, cloudState: 'RELEASED' });
        releasedBytes += version.sizeBytes;
        if (version.id === item.currentVersionId) {
          item.cloudState = 'RELEASED';
          await tx.put(userPK(userId), `ITEM#${item.id}`, item);
          await this.service.record(tx, userId, 'SYNC_CONTENT_RELEASED', item.id, item);
        }
      }
      const account = await this.service.account(tx, userId);
      account.storageUsedBytes = Math.max(0, account.storageUsedBytes - releasedBytes);
      await tx.put(userPK(userId), 'PROFILE', account);
      await tx.put(userPK(userId), `SYNCSTATE#${item.id}`, {
        ...delivery!,
        cleanupCursor: page.cursor ?? undefined,
        retained: page.cursor ? retained : false,
      });
      return !page.cursor && !retained;
    });
  }
  async statuses(userId: string, ids: string[], deviceId?: string, recursive = true) {
    const device = deviceId ? await this.service.checkDevice(userId, deviceId) : undefined;
    const tx = new Transaction(this.service.repo);
    const mappingCache = new Map<string, SyncMapping[]>();
    let visited = 0;
    const cache = new Map<string, SyncItemStatus | null>();
    const visit = async (item: DriveItem): Promise<SyncItemStatus | null> => {
      if (cache.has(item.id)) return cache.get(item.id)!;
      const owner = item.ownerUserId;
      if (!mappingCache.has(owner)) mappingCache.set(owner, await this.mappings(tx, owner));
      const mappings = mappingCache.get(owner)!;
      const deviceKey = device
        ? digest(
            owner === userId ? syncDeviceKey(device) : `account:${userId}:${syncDeviceKey(device)}`,
          )
        : undefined;
      const required = await this.participants(tx, owner, item, mappings);
      if (!Object.keys(required).length) {
        cache.set(item.id, null);
        return null;
      }
      const delivery = await tx.get<Delivery>(userPK(owner), `SYNCSTATE#${item.id}`);
      const counts = this.counts(item, required, delivery);
      const status: SyncItemStatus = {
        itemId: item.id,
        revision: item.revision,
        ...(deviceKey
          ? {
              deviceConfirmed:
                !!required[deviceKey] &&
                delivery?.version === versionKey(item) &&
                delivery.receipts[deviceKey]?.epoch === required[deviceKey],
            }
          : {}),
        state:
          counts.confirmedDevices === counts.requiredDevices
            ? 'SYNCED'
            : counts.confirmedDevices
              ? 'SYNCING'
              : 'PENDING',
        ...counts,
        cloudState: item.cloudState ?? 'AVAILABLE',
        pendingItems: 0,
      };
      if (++visited > 2000) {
        status.state = 'UNKNOWN';
        return status;
      }
      if (recursive && item.type === 'FOLDER') {
        let cursor: string | undefined;
        let hasChildren = false;
        let unknown = false;
        let progressing = false;
        do {
          const page = await this.service.list(owner, item.id, 100, cursor);
          for (const child of page.items) {
            hasChildren = true;
            const childStatus = await visit(child);
            if (childStatus?.state === 'UNKNOWN') unknown = true;
            if (childStatus && childStatus.state !== 'SYNCED') status.pendingItems++;
            if (childStatus?.state === 'SYNCING' || childStatus?.state === 'SYNCED')
              progressing = true;
            if (visited > 2000) {
              unknown = true;
              break;
            }
          }
          cursor = page.nextCursor ?? undefined;
        } while (cursor && !unknown);
        if (unknown) status.state = 'UNKNOWN';
        else if (hasChildren)
          status.state = status.pendingItems ? (progressing ? 'SYNCING' : 'PENDING') : 'SYNCED';
      }
      cache.set(item.id, status);
      return status;
    };
    const items: SyncItemStatus[] = [];
    for (const id of new Set(ids)) {
      const { item } = await this.service.authorized(tx, userId, id);
      const status = await visit(item);
      if (status) items.push(status);
    }
    return { items };
  }
}
