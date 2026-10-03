import type { Device } from '@harbor/contracts';
import type { BackupRoot } from '../../../packages/contracts/src/backups';
import { userPK } from './domain';
import { transact, Transaction, type Repository } from './repository';

type Counts = { devices: number; pushes: number; backups: number };

/**
 * Forgets every signed-in device of an account so each one registers again at its next sign-in.
 * Existing sessions stop working (their device is gone) and must sign in again. Device key pins
 * and installation revocations are kept, so a device can't claim another's identity afterwards.
 *
 * Backups are tied to the installation first: they were matched through the session that created
 * them, and that session's device record is about to be removed.
 */
export async function resetDevices(repo: Repository, userId: string, apply: boolean) {
  const pk = userPK(userId);
  const read = new Transaction(repo);
  const devices = await read.list<Device>(pk, 'DEVICE#');
  const roots = await read.list<BackupRoot>(pk, 'BACKUP#');
  const pushes = await read.list<{ deviceId: string }>(pk, 'PUSH#');
  const byId = new Map(devices.map((device) => [device.id, device]));
  const unlinked = roots.filter((root) => !root.devicePublicId);
  const counts: Counts = { devices: devices.length, pushes: pushes.length, backups: 0 };
  for (const root of unlinked) {
    const source = byId.get(root.deviceId);
    if (!source?.devicePublicId) continue;
    counts.backups++;
    if (apply)
      await transact(repo, async (tx) => {
        const current = await tx.get<BackupRoot>(pk, `BACKUP#${root.id}`);
        if (current && !current.devicePublicId)
          await tx.put(pk, `BACKUP#${root.id}`, {
            ...current,
            devicePublicId: source.devicePublicId,
            deviceName: current.deviceName ?? source.name,
          });
      });
  }
  if (apply) {
    for (const device of devices)
      await transact(repo, async (tx) => tx.delete(pk, `DEVICE#${device.id}`));
    for (const push of pushes)
      await transact(repo, async (tx) => tx.delete(pk, `PUSH#${push.deviceId}`));
  }
  return counts;
}
