import type { DriveItem, Device } from '@harbor/contracts';
import type { BackupRoot, BackupRun } from '../../../packages/contracts/src/backups';
import type { Transaction } from './repository';
import { assert } from './errors';
export type BackupWrite = { rootId: string; runId: string; deviceId: string };
const pk = (userId: string) => `USER#${userId}`;
const cached = new WeakMap<Transaction, Map<string, Promise<BackupRoot[]>>>();
async function roots(tx: Transaction, owner: string) {
  let cache = cached.get(tx);
  if (!cache) {
    cache = new Map();
    cached.set(tx, cache);
  }
  if (!cache.has(owner)) cache.set(owner, tx.list<BackupRoot>(pk(owner), 'BACKUP#'));
  return (await cache.get(owner)!).filter((root) => root.state !== 'REMOVED');
}
async function ancestors(tx: Transaction, owner: string, id: string | null) {
  const ids = new Set<string>();
  while (id && !ids.has(id)) {
    ids.add(id);
    assert(ids.size <= 34, 'VALIDATION_ERROR', 'Folder hierarchy is invalid.');
    id = (await tx.get<DriveItem>(pk(owner), `ITEM#${id}`))?.parentId ?? null;
  }
  return ids;
}
export async function backupForItem(tx: Transaction, owner: string, id: string | null) {
  if (!id) return undefined;
  const active = await roots(tx, owner);
  if (!active.length) return undefined;
  const path = await ancestors(tx, owner, id);
  return active.find((root) => path.has(root.remoteRootDriveItemId));
}
export async function assertBackupMutable(
  tx: Transaction,
  owner: string,
  id: string | null,
  descendants = false,
) {
  if (!id) return;
  let protectedRoot = await backupForItem(tx, owner, id);
  if (!protectedRoot && descendants) {
    for (const root of await roots(tx, owner)) {
      if ((await ancestors(tx, owner, root.remoteRootDriveItemId)).has(id)) {
        protectedRoot = root;
        break;
      }
    }
  }
  assert(
    !protectedRoot,
    'BACKUP_IMMUTABLE',
    'This backup is read-only. Disconnect the backup folder before changing its cloud files.',
    409,
  );
}
export async function assertBackupWrite(
  tx: Transaction,
  owner: string,
  targetId: string | null,
  context: BackupWrite,
) {
  const root = await tx.get<BackupRoot>(pk(owner), `BACKUP#${context.rootId}`);
  assert(
    root && root.state !== 'REMOVED',
    'BACKUP_DISCONNECTED',
    'This folder is no longer connected for backup.',
    409,
  );
  const device = await tx.get<Device>(pk(owner), `DEVICE#${context.deviceId}`);
  const original = await tx.get<Device>(pk(owner), `DEVICE#${root.deviceId}`);
  assert(
    device &&
      !device.revokedAt &&
      (root.deviceId === device.id ||
        (device.devicePublicId && device.devicePublicId === original?.devicePublicId)),
    'FORBIDDEN',
    'Only the source computer can append backup versions.',
    403,
  );
  const run = await tx.get<BackupRun>(`${pk(owner)}#BACKUP#${root.id}`, `RUN#${context.runId}`);
  assert(
    run?.state === 'RUNNING',
    'BACKUP_RUN_CLOSED',
    'Start a new backup run before saving files.',
    409,
  );
  assert(
    (await ancestors(tx, owner, targetId)).has(root.remoteRootDriveItemId),
    'FORBIDDEN',
    'The backup destination is outside its folder.',
    403,
  );
}
