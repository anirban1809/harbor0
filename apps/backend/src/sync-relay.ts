import { createHash } from 'node:crypto';
import type { Device, DriveItem, FileVersion, SyncItemStatus, ShareGrant } from '@harbor/contracts';
import { StorageService, userPK } from './domain';
import { Transaction, transact } from './repository';
import { assert } from './errors';

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
// Receipts only report sync progress: synced files always keep their bytes in the cloud.
type Delivery = { version: string; receipts: Record<string, Receipt> };
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
      const linked =
        !!required[
          digest(
            owner === userId ? syncDeviceKey(device) : `account:${userId}:${syncDeviceKey(device)}`,
          )
        ];
      // The owner's other app devices (e.g. a phone opening the file on demand) may ask for a
      // legacy released file too; shared-folder members still need to be linked to the folder.
      assert(
        linked || owner === userId,
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
  /**
   * Files released before synced folders kept their bytes in the cloud are asked back from the
   * devices that hold them. A device uploads the content again, which makes it AVAILABLE.
   */
  async rehydrate(userId: string, apply: boolean) {
    let cursor: string | undefined;
    let requested = 0;
    do {
      const page = await this.service.repo.query(userPK(userId), 'ITEM#', 100, cursor);
      for (const row of page.rows) {
        const listed = row.data as DriveItem;
        if (listed.type !== 'FILE' || listed.deletedAt || listed.cloudState !== 'RELEASED')
          continue;
        requested++;
        if (apply)
          await transact(this.service.repo, async (tx) => {
            const item = await tx.get<DriveItem>(userPK(userId), `ITEM#${listed.id}`);
            if (!item || item.deletedAt || item.cloudState !== 'RELEASED') return;
            item.cloudState = 'REQUESTED';
            await tx.put(userPK(userId), `ITEM#${item.id}`, item);
            await this.service.record(tx, userId, 'SYNC_CONTENT_REQUESTED', item.id, item);
          });
      }
      cursor = page.cursor ?? undefined;
    } while (cursor);
    return requested;
  }
  async statuses(userId: string, ids: string[], deviceId?: string, recursive = true) {
    const device = deviceId ? await this.service.checkDevice(userId, deviceId) : undefined;
    const tx = new Transaction(this.service.repo);
    // Promises, so children visited in parallel share one lookup per owner.
    const mappingCache = new Map<string, Promise<SyncMapping[]>>();
    let visited = 0;
    const cache = new Map<string, SyncItemStatus | null>();
    const visit = async (item: DriveItem): Promise<SyncItemStatus | null> => {
      if (cache.has(item.id)) return cache.get(item.id)!;
      const owner = item.ownerUserId;
      if (!mappingCache.has(owner)) mappingCache.set(owner, this.mappings(tx, owner));
      const mappings = await mappingCache.get(owner)!;
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
          // Each child is a separate read; one at a time, a large folder took longer than
          // clients wait for an answer.
          const children = await Promise.all(page.items.map(visit));
          for (const childStatus of children) {
            hasChildren = true;
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
