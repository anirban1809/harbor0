import { beforeEach, expect, it } from 'vitest';
import type { BackupRoot, BackupRun } from '../../../packages/contracts/src/backups';
import { DevelopmentAuth } from '../src/auth';
import { StorageService, userPK } from '../src/domain';
import { MemoryRepository, transact } from '../src/repository';
import { MemoryStorage } from '../src/storage';
import { backupPartition } from '../src/backups';
import { createAdminApp } from '../src/admin/api';
import { backupRuns, redactBackupError } from '../src/admin/backup-runs';
import { DevelopmentDirectory } from '../src/admin/directory';
import { DevelopmentStaffAuth } from '../src/admin/staff-auth';

const ORIGIN = 'http://console.test';
let service: StorageService;
let auth: DevelopmentAuth;

const root: BackupRoot = {
  id: 'root-1',
  userId: 'alice',
  deviceId: 'mac',
  deviceName: 'Alices-MacBook.local',
  localPathDisplayName: 'library',
  remoteRootDriveItemId: 'remote-1',
  state: 'ACTIVE',
  createdAt: '2026-10-17T16:29:43.959Z',
  updatedAt: '2026-10-17T16:29:43.959Z',
};
const run = (id: string, startedAt: string, extra: Partial<BackupRun> = {}): BackupRun => ({
  id,
  rootId: root.id,
  deviceId: 'mac',
  trigger: 'AUTOMATIC',
  state: 'COMPLETED',
  startedAt,
  completedAt: startedAt,
  fileCount: 1,
  sizeBytes: 10,
  ...extra,
});

beforeEach(async () => {
  service = new StorageService(new MemoryRepository(), new MemoryStorage());
  auth = new DevelopmentAuth();
  for (const identity of auth.users.values()) await service.ensureUser(identity);
  await transact(service.repo, async (tx) => {
    await tx.put(userPK('alice'), `BACKUP#${root.id}`, root);
    for (let n = 0; n < 12; n++)
      await tx.put(
        backupPartition('alice', root.id),
        `RUN#old-${n}`,
        run(`old-${n}`, `2026-10-0${Math.floor(n / 4) + 1}T0${n % 4}:00:00.000Z`),
      );
    await tx.put(
      backupPartition('alice', root.id),
      'RUN#live',
      run('live', '2026-10-17T16:33:25.246Z', {
        state: 'RUNNING',
        completedAt: null,
        fileCount: 9978,
        sizeBytes: 12_360_000_000,
        plannedFileCount: 31_426,
        plannedSizeBytes: 52_000_000_000,
        lastSavedAt: '2026-10-17T20:47:13.659Z',
        error: 'admin/2023/2023-03-31/IMG_4883.MP4.xmp: This upload cannot accept parts.',
      }),
    );
  });
});

it('removes file and folder names from what devices write about a run', () => {
  expect(redactBackupError(undefined)).toBeNull();
  expect(
    redactBackupError(
      '8,685 files were not backed up: there is not enough cloud storage (61.8 KB free). admin/2023/2023-03-31/IMG_4883.MP4.xmp: This upload cannot accept parts.',
    ),
  ).toBe(
    '8,685 files were not backed up: there is not enough cloud storage (61.8 KB free). A file failed: This upload cannot accept parts.',
  );
  expect(redactBackupError('notes.txt: The file could not be uploaded.')).toBe(
    'A file failed: The file could not be uploaded.',
  );
  expect(
    redactBackupError(
      'harbor0 does not have permission to read these folders: Photos/Private, Taxes and 3 more.',
    ),
  ).toBe('harbor0 does not have permission to read some folders.');
  expect(
    redactBackupError('1 file was not backed up: there is not enough cloud storage (0 B free).'),
  ).toBe('1 file was not backed up: there is not enough cloud storage (0 B free).');
  // Nothing that looks like a path survives, whatever the wording.
  expect(redactBackupError('Backup folder disconnected while saving /Users/a/b.txt')).not.toContain(
    '/Users',
  );
});

it("lists each folder's newest runs with progress, the account's storage and no paths", async () => {
  const result = await backupRuns(service.repo, 'alice');
  expect(result.storage.quotaBytes).toBeGreaterThan(0);
  expect(result.backups).toHaveLength(1);
  const [backup] = result.backups;
  expect(backup).toMatchObject({ folderName: 'library', deviceName: 'Alices-MacBook.local' });
  expect(backup.runCount).toBe(13);
  expect(backup.runs).toHaveLength(10);
  expect(backup.runs[0]).toEqual({
    id: 'live',
    trigger: 'AUTOMATIC',
    state: 'RUNNING',
    startedAt: '2026-10-17T16:33:25.246Z',
    completedAt: null,
    fileCount: 9978,
    sizeBytes: 12_360_000_000,
    plannedFileCount: 31_426,
    plannedSizeBytes: 52_000_000_000,
    lastSavedAt: '2026-10-17T20:47:13.659Z',
    error: 'A file failed: This upload cannot accept parts.',
  });
  // Runs from older app versions have no plan.
  expect(backup.runs[1]).toMatchObject({ plannedFileCount: null, lastSavedAt: null });
});

it('serves the backups to signed-in staff only', async () => {
  const app = createAdminApp(service, new DevelopmentDirectory(auth), new DevelopmentStaffAuth(), {
    origins: [ORIGIN],
    secureCookies: false,
  }).app;
  expect((await app.request('/api/v1/admin/users/alice/backups')).status).toBe(401);
  const login = await app.request('/api/v1/admin/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ email: 'support@example.test', password: 'Development-only-123!' }),
  });
  const cookie = login.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  const response = await app.request('/api/v1/admin/users/alice/backups', {
    headers: { Cookie: cookie, Origin: ORIGIN },
  });
  expect(response.status).toBe(200);
  const body = await response.text();
  expect(body).toContain('"folderName":"library"');
  expect(body).not.toContain('IMG_4883');
});
