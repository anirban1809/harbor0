import { beforeEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ActivityEvent } from '../../../packages/contracts/src/activity';
import type { BackupRoot } from '../../../packages/contracts/src/backups';
import { StorageService } from '../src/domain';
import { MemoryRepository } from '../src/repository';
import { MemoryStorage } from '../src/storage';
import { DeviceActivity } from '../src/device-activity';
import { backupRuns } from '../src/admin/backup-runs';
import { deviceActivityLog, syncActivity } from '../src/admin/sync-activity';

let service: StorageService, activity: DeviceActivity, folder: string, root: BackupRoot;
const event = (e: Partial<ActivityEvent> & Pick<ActivityEvent, 'scope' | 'action' | 'status'>) =>
  ({ id: randomUUID(), at: new Date().toISOString(), ...e }) as ActivityEvent;

beforeEach(async () => {
  service = new StorageService(new MemoryRepository(), new MemoryStorage());
  activity = new DeviceActivity(service);
  await service.ensureUser({
    id: 'alice',
    email: 'alice@example.test',
    emailVerified: true,
    username: 'alice',
    displayName: 'Alice',
  });
  await service.registerDevice(
    'alice',
    { name: 'Alices-MacBook.local', platform: 'MACOS', devicePublicId: 'mac' },
    'mac',
  );
  folder = (
    await service.createFolder('alice', { parentId: null, name: 'Work', operationId: randomUUID() })
  ).item.id;
  await service.setSyncFolders('alice', 'mac', [folder]);
  root = (
    await service.backupRoot('alice', {
      operationId: randomUUID(),
      deviceId: 'mac',
      name: 'Photos',
    })
  ).root as BackupRoot;
});

it("lists each device's synced folders by name with what the device last reported", async () => {
  await activity.record('alice', 'mac', [
    event({ scope: 'ENGINE', action: 'PAUSED', status: 'PAUSED', reason: 'USER' }),
    event({ scope: 'SYNC', folderId: folder, action: 'PAUSED', status: 'PAUSED', reason: 'ALL' }),
  ]);
  const { devices } = await syncActivity(service, 'alice');
  expect(devices).toHaveLength(1);
  expect(devices[0]).toMatchObject({
    deviceKey: 'installation:mac',
    deviceName: 'Alices-MacBook.local',
    platform: 'MACOS',
    signedIn: true,
    engine: { status: 'PAUSED', reason: 'USER' },
  });
  expect(devices[0]!.folders).toEqual([
    expect.objectContaining({
      folderId: folder,
      name: 'Work',
      encrypted: false,
      shared: false,
      status: expect.objectContaining({ status: 'PAUSED', reason: 'ALL' }),
    }),
  ]);
});

it('shows a backup folder paused by its computer, and the engine beside it', async () => {
  await activity.record('alice', 'mac', [
    event({ scope: 'ENGINE', action: 'BLOCKED', status: 'BLOCKED', reason: 'STORAGE_FULL' }),
    event({
      scope: 'BACKUP',
      folderId: root.id,
      action: 'PAUSED',
      status: 'PAUSED',
      reason: 'USER',
    }),
  ]);
  const [backup] = (await backupRuns(service.repo, 'alice')).backups;
  expect(backup).toMatchObject({
    state: 'PAUSED',
    status: { status: 'PAUSED', reason: 'USER' },
    engine: { status: 'BLOCKED', reason: 'STORAGE_FULL' },
  });
});

it("reads the account's activity reports from the log, newest first, within the account", async () => {
  let query = '';
  const rows: Record<string, string>[] = [
    {
      at: '2026-10-18T12:00:05.000Z',
      scope: 'SYNC',
      folderId: 'f',
      action: 'FINISHED',
      status: 'IDLE',
      files: '4',
    },
    {
      at: '2026-10-18T12:00:01.000Z',
      scope: 'ENGINE',
      action: 'RESUMED',
      status: 'ACTIVE',
      platform: 'MACOS',
    },
  ];
  const log = await deviceActivityLog(
    async (q) => {
      query = q;
      return rows;
    },
    'alice',
    { range: '7d', scope: 'ALL' },
  );
  expect(query).toContain('filter event = "activity" and userId = "alice"');
  expect(log.more).toBe(false);
  expect(log.events[0]).toMatchObject({
    scope: 'SYNC',
    action: 'FINISHED',
    files: 4,
    reason: null,
  });
  expect(log.events[1]).toMatchObject({ scope: 'ENGINE', folderId: null, platform: 'MACOS' });
});
