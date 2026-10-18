import { beforeEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ActivityEvent } from '../../../packages/contracts/src/activity';
import type { BackupRoot } from '../../../packages/contracts/src/backups';
import { StorageService, userPK, watchedBackup } from '../src/domain';
import { MemoryRepository, Transaction } from '../src/repository';
import { MemoryStorage } from '../src/storage';
import { Backups } from '../src/backups';
import { DeviceActivity } from '../src/device-activity';

let service: StorageService, activity: DeviceActivity, backups: Backups, root: BackupRoot;
let synced: string;
const event = (e: Partial<ActivityEvent> & Pick<ActivityEvent, 'scope' | 'action' | 'status'>) =>
  ({ id: randomUUID(), at: new Date().toISOString(), ...e }) as ActivityEvent;
const backupState = async () =>
  (await new Transaction(service.repo).get<BackupRoot>(userPK('alice'), `BACKUP#${root.id}`))!
    .state;

beforeEach(async () => {
  service = new StorageService(new MemoryRepository(), new MemoryStorage());
  activity = new DeviceActivity(service);
  backups = new Backups(service);
  await service.ensureUser({
    id: 'alice',
    email: 'alice@example.test',
    emailVerified: true,
    username: 'alice',
    displayName: 'Alice',
  });
  for (const id of ['mac', 'pc'])
    await service.registerDevice('alice', { name: id, platform: 'MACOS', devicePublicId: id }, id);
  root = (
    await service.backupRoot('alice', {
      operationId: randomUUID(),
      deviceId: 'mac',
      name: 'Photos',
    })
  ).root as BackupRoot;
  synced = (
    await service.createFolder('alice', { parentId: null, name: 'Work', operationId: randomUUID() })
  ).item.id;
  await service.setSyncFolders('alice', 'mac', [synced]);
});

it('pauses and resumes a backup folder from its own computer, ending its reminders meanwhile', async () => {
  await activity.record('alice', 'mac', [
    event({
      scope: 'BACKUP',
      folderId: root.id,
      action: 'PAUSED',
      status: 'PAUSED',
      reason: 'USER',
    }),
  ]);
  expect(await backupState()).toBe('PAUSED');
  expect(watchedBackup({ ...root, state: 'PAUSED' })).toBe(false);
  await activity.record('alice', 'mac', [
    event({ scope: 'BACKUP', folderId: root.id, action: 'RESUMED', status: 'IDLE' }),
  ]);
  expect(await backupState()).toBe('ACTIVE');

  // Another computer can't pause it.
  await activity.record('alice', 'pc', [
    event({
      scope: 'BACKUP',
      folderId: root.id,
      action: 'PAUSED',
      status: 'PAUSED',
      reason: 'USER',
    }),
  ]);
  expect(await backupState()).toBe('ACTIVE');
});

it('a run starting on a paused folder sets it going again, in case the resume was lost', async () => {
  await activity.record('alice', 'mac', [
    event({
      scope: 'BACKUP',
      folderId: root.id,
      action: 'PAUSED',
      status: 'PAUSED',
      reason: 'ALL',
    }),
  ]);
  await backups.start('alice', root.id, 'mac', { id: 'run', trigger: 'AUTOMATIC' });
  expect(await backupState()).toBe('ACTIVE');
});

it('keeps each subject newest status, writing only when it changes', async () => {
  const at = (s: number) => new Date(Date.UTC(2026, 9, 18, 12, 0, s)).toISOString();
  const first = await activity.record('alice', 'mac', [
    event({
      scope: 'SYNC',
      folderId: synced,
      action: 'STARTED',
      status: 'ACTIVE',
      files: 12,
      at: at(1),
    }),
    event({
      scope: 'SYNC',
      folderId: synced,
      action: 'FINISHED',
      status: 'IDLE',
      files: 12,
      at: at(9),
    }),
    event({
      scope: 'ENGINE',
      action: 'BLOCKED',
      status: 'BLOCKED',
      reason: 'STORAGE_FULL',
      at: at(5),
    }),
  ]);
  // The newest of each subject: the sync folder finished, the engine blocked.
  expect(first.changed).toBe(2);
  // A late event changes nothing, nor does the same status again.
  const again = await activity.record('alice', 'mac', [
    event({ scope: 'SYNC', folderId: synced, action: 'STARTED', status: 'ACTIVE', at: at(3) }),
    event({
      scope: 'ENGINE',
      action: 'BLOCKED',
      status: 'BLOCKED',
      reason: 'STORAGE_FULL',
      at: at(20),
    }),
  ]);
  expect(again.changed).toBe(0);
  const states = await activity.states('alice');
  expect(states.find((s) => s.scope === 'SYNC')).toMatchObject({
    deviceKey: 'installation:mac',
    folderId: synced,
    status: 'IDLE',
    action: 'FINISHED',
    files: 12,
    since: at(9),
  });
  expect(states.find((s) => s.scope === 'ENGINE')).toMatchObject({
    status: 'BLOCKED',
    reason: 'STORAGE_FULL',
    folderId: null,
  });
});

it("ignores folders the device doesn't sync and backups that aren't there", async () => {
  const { changed } = await activity.record('alice', 'pc', [
    event({ scope: 'SYNC', folderId: synced, action: 'STARTED', status: 'ACTIVE' }),
    event({
      scope: 'BACKUP',
      folderId: 'nope',
      action: 'PAUSED',
      status: 'PAUSED',
      reason: 'USER',
    }),
  ]);
  expect(changed).toBe(0);
  expect(await activity.states('alice')).toEqual([]);
});
