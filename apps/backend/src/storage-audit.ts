import type { DriveItem, FileVersion, StorageAuditRow, Device } from '@harbor/contracts';
import { storageUsage } from '@harbor/contracts';
import type { BackupRoot } from '../../../packages/contracts/src/backups';
import { emptied, StorageService, userPK } from './domain';
import { Transaction } from './repository';
import type { Save, StagedItem } from './workflows';

type Place = {
  path: string;
  location: StorageAuditRow['location'];
  locationDetail: string | null;
  purging: boolean;
};
type AuditItem = StagedItem & { purging?: boolean };

/**
 * Lists every stored file version the account is charged for, page by page over the owner's
 * items. Bytes are counted as the quota ledger counts them: every version of every file, trash
 * included, except legacy content held only on devices. Items being permanently deleted are listed
 * without counted bytes, since their bytes left the ledger when the user deleted them.
 */
export async function storageAudit(
  s: StorageService,
  userId: string,
  limit: number,
  cursor?: string,
): Promise<{
  rows: StorageAuditRow[];
  storage: ReturnType<typeof storageUsage>;
  nextCursor: string | null;
}> {
  const tx = new Transaction(s.repo);
  const account = await s.account(tx, userId);
  const sessions = await tx.list<Device>(userPK(userId), 'DEVICE#');
  const deviceNames = new Map(sessions.map((d) => [d.id, d.name]));
  const backups = (await tx.list<BackupRoot>(userPK(userId), 'BACKUP#')).filter(
    (root) => root.state !== 'REMOVED',
  );
  const backupByFolder = new Map(
    backups.map((root) => [
      root.remoteRootDriveItemId,
      `${root.deviceName ?? deviceNames.get(root.deviceId) ?? 'Unknown device'} · ${root.localPathDisplayName}`,
    ]),
  );
  const syncByFolder = new Map(
    (await s.syncFolders(userId)).items
      .filter((folder) => folder.ownerUserId === userId)
      .map((folder) => [
        folder.id,
        folder.syncDevices.length
          ? `${folder.name} (${folder.syncDevices.map((d) => d.name).join(', ')})`
          : folder.name,
      ]),
  );

  const places = new Map<string, Place | null>();
  const place = async (id: string, depth = 0): Promise<Place | null> => {
    if (places.has(id)) return places.get(id)!;
    const item = await tx.get<AuditItem>(userPK(userId), `ITEM#${id}`);
    if (!item) return null;
    const parent = item.parentId && depth < 64 ? await place(item.parentId, depth + 1) : null;
    let location: Place['location'] = parent?.location ?? 'MY_DRIVE';
    let locationDetail = parent?.locationDetail ?? null;
    // Most specific reason wins: deleting > trash > backup > sync > drive.
    const rank = { MY_DRIVE: 0, SYNC: 1, BACKUP: 2, TRASH: 3, DELETING: 4 } as const;
    const raise = (next: Place['location'], detail: string | null) => {
      if (rank[next] < rank[location]) return;
      if (rank[next] > rank[location] || !locationDetail) locationDetail = detail;
      location = next;
    };
    if (syncByFolder.has(item.id)) raise('SYNC', syncByFolder.get(item.id)!);
    if (backupByFolder.has(item.id)) raise('BACKUP', backupByFolder.get(item.id)!);
    if (item.deletedAt) raise('TRASH', locationDetail);
    if (item.purging || emptied(item, account)) raise('DELETING', locationDetail);
    const result: Place = {
      path: `${parent?.path ?? ''}/${item.name}`,
      location,
      locationDetail,
      purging: !!item.purging || emptied(item, account) || !!parent?.purging,
    };
    places.set(id, result);
    return result;
  };

  const page = await s.repo.query(userPK(userId), 'ITEM#', limit, cursor);
  const rows: StorageAuditRow[] = [];
  for (const row of page.rows) {
    const item = row.data as AuditItem & DriveItem;
    if (item.type !== 'FILE') continue;
    // Files of a transfer save still in progress are counted as reserved, not used.
    if (
      item.stagingId &&
      (await tx.get<Save>(`SAVE#${item.stagingId}`, 'META'))?.state !== 'COMPLETED'
    )
      continue;
    const where = await place(item.id);
    if (!where) continue;
    const versions = await tx.list<FileVersion>(userPK(userId), `VERSION#${item.id}#`);
    for (const v of versions.sort((a, b) => b.versionNumber - a.versionNumber)) {
      const released = v.cloudState === 'RELEASED';
      const pinned =
        where.purging &&
        !!(await tx.get<{ count: number }>(`PIN#${v.storageObjectId}`, userId))?.count;
      rows.push({
        itemId: item.id,
        versionId: v.id,
        path: where.path,
        location: where.location,
        locationDetail: where.locationDetail,
        state: released
          ? 'ON_DEVICES_ONLY'
          : pinned
            ? 'RETAINED_FOR_TRANSFER'
            : v.id === item.currentVersionId
              ? 'CURRENT'
              : 'PREVIOUS_VERSION',
        versionNumber: v.versionNumber,
        sizeBytes: v.sizeBytes,
        countedBytes: released || where.purging ? 0 : v.sizeBytes,
        contentHash: v.contentHash,
        uploadedAt: v.createdAt,
        uploadedFrom: v.sourceDeviceId ? (deviceNames.get(v.sourceDeviceId) ?? null) : null,
      });
    }
  }
  return { rows, storage: storageUsage(account), nextCursor: page.cursor ?? null };
}
