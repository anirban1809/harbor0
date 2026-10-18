import type { Device } from '@harbor/contracts';
import type { ActivityEvent, ActivityState } from '../../../packages/contracts/src/activity';
import type { BackupRoot } from '../../../packages/contracts/src/backups';
import { StorageService, userPK } from './domain';
import { Backups } from './backups';
import { DomainError } from './errors';
import { Transaction, transact } from './repository';
import { syncDeviceKey, type SyncMapping } from './sync-relay';

/** One status row per device and subject (see docs/specs/device-activity.md). */
export const activityKey = (deviceKey: string, scope: string, folderId?: string | null) =>
  `ACTIVITY#${deviceKey}#${scope}#${folderId ?? '-'}`;
const subject = (e: ActivityEvent) => `${e.scope}#${e.folderId ?? '-'}`;

/**
 * Keeps the current status of what a device's engine is doing, from the events it reports. A
 * row changes only when the status or reason does, and only for an event newer than the one it
 * holds. Backup events also pause and resume the backup folder itself.
 */
export class DeviceActivity {
  private backups: Backups;
  constructor(private service: StorageService) {
    this.backups = new Backups(service);
  }

  async record(userId: string, deviceId: string, events: ActivityEvent[]) {
    const device = await this.service.checkDevice(userId, deviceId);
    const deviceKey = syncDeviceKey(device);
    // Only each subject's newest event can change its status.
    const latest = new Map<string, ActivityEvent>();
    for (const event of events) {
      const known = latest.get(subject(event));
      if (!known || event.at >= known.at) latest.set(subject(event), event);
    }
    const synced = [...latest.values()].some((e) => e.scope === 'SYNC')
      ? await this.syncedFolders(userId, deviceKey)
      : new Set<string>();
    let changed = 0;
    for (const event of latest.values()) {
      if (event.scope === 'SYNC' && !synced.has(event.folderId!)) continue;
      if (await this.apply(userId, device, deviceKey, event)) changed++;
    }
    return { changed };
  }

  /** Every status the account's devices last reported. */
  async states(userId: string) {
    return new Transaction(this.service.repo).list<ActivityState>(userPK(userId), 'ACTIVITY#');
  }

  private async syncedFolders(userId: string, deviceKey: string) {
    const mappings = await new Transaction(this.service.repo).list<SyncMapping>(
      userPK(userId),
      'SYNCFOLDERS#',
    );
    return new Set(mappings.find((m) => m.key === deviceKey)?.folderIds ?? []);
  }

  private async apply(userId: string, device: Device, deviceKey: string, e: ActivityEvent) {
    const key = activityKey(deviceKey, e.scope, e.folderId);
    return transact(this.service.repo, async (tx) => {
      const known = await tx.get<ActivityState>(userPK(userId), key);
      // A late event, or nothing new: no write.
      if (known && known.since > e.at) return false;
      if (known && known.status === e.status && known.reason === (e.reason ?? null)) return false;
      if (e.scope === 'BACKUP') {
        const root = await this.ownedBackup(tx, userId, device, e.folderId!);
        if (!root) return false;
        const paused = e.status === 'PAUSED';
        if (paused && (root.state === 'ACTIVE' || root.state === 'ERROR'))
          await tx.put(userPK(userId), `BACKUP#${root.id}`, {
            ...root,
            state: 'PAUSED',
            updatedAt: new Date().toISOString(),
          } satisfies BackupRoot);
        else if (!paused && root.state === 'PAUSED')
          await tx.put(userPK(userId), `BACKUP#${root.id}`, {
            ...root,
            state: 'ACTIVE',
            updatedAt: new Date().toISOString(),
          } satisfies BackupRoot);
      }
      await tx.put(userPK(userId), key, {
        deviceKey,
        deviceId: device.id,
        scope: e.scope,
        folderId: e.folderId ?? null,
        status: e.status,
        reason: e.reason ?? null,
        since: e.at,
        action: e.action,
        files: e.files ?? null,
        bytes: e.bytes ?? null,
        failed: e.failed ?? null,
        runId: e.runId ?? null,
        reportedAt: new Date().toISOString(),
      } satisfies ActivityState);
      return true;
    });
  }

  /** The backup folder, when it exists and belongs to this device; otherwise nothing changes. */
  private async ownedBackup(tx: Transaction, userId: string, device: Device, id: string) {
    try {
      const root = await this.backups.root(tx, userId, id, device.id);
      return root.state === 'REMOVED' ? null : root;
    } catch (error) {
      if (error instanceof DomainError) return null;
      throw error;
    }
  }
}
