import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { BACKUP_STALE_MS, StorageService, userPK } from '../src/domain';
import { Backups } from '../src/backups';
import { composeEmail, type Email } from '../src/emails';
import { MemoryRepository, transact } from '../src/repository';
import { MemoryStorage } from '../src/storage';

let service: StorageService;
const sent: Email[] = [];
const deliver = async () => {
  sent.length = 0;
  // Emails queued by a run (e.g. a backup check) go out on the next one.
  for (let run = 0; run < 2; run++) await service.runJobs(async (email) => void sent.push(email));
  return sent.filter((email) => email.template !== 'WELCOME' && email.template !== 'NEW_SIGNUP');
};
const signIn = (sessionId: string, devicePublicId: string, name = 'MacBook') =>
  service.registerDevice('alice', { name, platform: 'MACOS', devicePublicId }, sessionId);

beforeEach(async () => {
  service = new StorageService(new MemoryRepository(), new MemoryStorage());
  await service.ensureUser({
    id: 'alice',
    email: 'alice@example.test',
    emailVerified: true,
    username: 'alice',
    displayName: 'Alice',
  });
});
afterEach(() => vi.useRealTimers());

describe('storage alerts', () => {
  const use = (usedBytes: number) =>
    transact(service.repo, async (tx) => {
      const account = await service.account(tx, 'alice');
      account.storageQuotaBytes = 1000;
      account.storageUsedBytes = usedBytes;
      await service.storageAlert(tx, account);
      await tx.put(userPK('alice'), 'PROFILE', account);
    });
  const levels = async () =>
    (await deliver()).map((email) => email.template === 'STORAGE' && email.level);

  it('emails once per threshold crossed and re-arms after usage drops', async () => {
    await use(500);
    expect(await levels()).toEqual([]);
    await use(850);
    expect(await levels()).toEqual([80]);
    await use(900);
    expect(await levels()).toEqual([]);
    await use(990);
    expect(await levels()).toEqual([95]);
    await use(1000);
    expect(await levels()).toEqual([100]);
    await use(400);
    await use(810);
    expect(await levels()).toEqual([80]);
  });

  it('sends only the highest threshold when one change crosses several', async () => {
    await use(1000);
    expect(await levels()).toEqual([100]);
  });
});

describe('stale backup reminders', () => {
  it('sends one reminder per computer for folders that stopped finishing runs', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.now();
    const { device } = await signIn('session-1', 'install-1');
    const create = async (name: string) =>
      (await service.backupRoot('alice', { operationId: randomUUID(), deviceId: device.id, name }))
        .root.id;
    const documents = await create('Documents');
    const photos = await create('Photos');
    const desktop = await create('Desktop');
    const backups = new Backups(service);
    // Photos finishes a run on day 3, so it is not stale when the others are.
    vi.setSystemTime(start + 3 * 86400_000);
    const { run } = await backups.start('alice', photos, device.id, {
      id: randomUUID(),
      trigger: 'AUTOMATIC',
    });
    const { run: finished } = await backups.finish('alice', photos, device.id, run.id);
    // Desktop is stopped, so it never reminds.
    await backups.disconnect('alice', desktop);

    vi.setSystemTime(start + BACKUP_STALE_MS + 60_000);
    expect(await deliver()).toEqual([
      expect.objectContaining({
        template: 'BACKUP_STALE',
        device: 'MacBook',
        folders: [{ name: 'Documents', lastBackupAt: null }],
      }),
    ]);
    expect(await deliver()).toEqual([]);
    expect(documents).toBeTruthy();

    vi.setSystemTime(start + 3 * 86400_000 + BACKUP_STALE_MS + 60_000);
    expect(await deliver()).toEqual([
      expect.objectContaining({
        folders: [{ name: 'Photos', lastBackupAt: finished.completedAt }],
      }),
    ]);
  });

  it('groups folders from one computer that go stale together', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.now();
    const { device } = await signIn('session-1', 'install-1');
    for (const name of ['Documents', 'Photos'])
      await service.backupRoot('alice', { operationId: randomUUID(), deviceId: device.id, name });
    vi.setSystemTime(start + BACKUP_STALE_MS + 60_000);
    const [email, ...rest] = await deliver();
    expect(rest).toEqual([]);
    expect(email.template === 'BACKUP_STALE' && email.folders.map((f) => f.name).sort()).toEqual([
      'Documents',
      'Photos',
    ]);
  });

  it('treats a folder its computer checked with nothing new as backed up', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.now();
    const { device } = await signIn('session-1', 'install-1');
    const { root } = await service.backupRoot('alice', {
      operationId: randomUUID(),
      deviceId: device.id,
      name: 'Documents',
    });
    const backups = new Backups(service);
    const { run } = await backups.start('alice', root.id, device.id, {
      id: randomUUID(),
      trigger: 'AUTOMATIC',
    });
    const { run: finished } = await backups.finish('alice', root.id, device.id, run.id);
    // Nothing changes for a week, but the computer keeps checking in.
    vi.setSystemTime(start + 6 * 86400_000);
    expect(await backups.checked('alice', root.id, device.id)).toEqual({ checked: true });
    vi.setSystemTime(start + BACKUP_STALE_MS + 60_000);
    expect(await deliver()).toEqual([]);
    // Once it stops checking in, the reminder still names the last real backup.
    vi.setSystemTime(start + 6 * 86400_000 + BACKUP_STALE_MS + 60_000);
    expect(await deliver()).toEqual([
      expect.objectContaining({
        folders: [{ name: 'Documents', lastBackupAt: finished.completedAt }],
      }),
    ]);
  });

  it('re-arms an unarchived folder and backfills folders from before reminders', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.now();
    const { device } = await signIn('session-1', 'install-1');
    const create = async (name: string) =>
      (await service.backupRoot('alice', { operationId: randomUUID(), deviceId: device.id, name }))
        .root.id;
    const archived = await create('Archived');
    const older = await create('Older');
    const backups = new Backups(service);
    await backups.archive('alice', archived, device.id, true);
    // Older predates reminders: it has no check.
    await transact(service.repo, (tx) => tx.delete('JOB', `backup-check-${older}`));
    expect(await backups.backfillChecks('alice', false)).toBe(1);
    expect(await backups.backfillChecks('alice', true)).toBe(1);
    expect(await backups.backfillChecks('alice', true)).toBe(0);

    vi.setSystemTime(start + BACKUP_STALE_MS + 60_000);
    expect((await deliver()).map((e) => e.template === 'BACKUP_STALE' && e.folders)).toEqual([
      [{ name: 'Older', lastBackupAt: null }],
    ]);
    await backups.archive('alice', archived, device.id, false);
    vi.setSystemTime(start + 2 * BACKUP_STALE_MS + 120_000);
    expect((await deliver()).map((e) => e.template === 'BACKUP_STALE' && e.folders)).toEqual([
      [{ name: 'Archived', lastBackupAt: null }],
    ]);
  });
});

describe('new sign-in emails', () => {
  it('skips the first installation and repeat sessions, and emails for a new one', async () => {
    await signIn('session-1', 'install-1');
    await signIn('session-2', 'install-1');
    await signIn('session-2', 'install-1');
    expect(await deliver()).toEqual([]);
    await signIn('session-3', 'install-2', 'Pixel 9');
    expect(await deliver()).toEqual([
      expect.objectContaining({
        template: 'NEW_SIGN_IN',
        to: 'alice@example.test',
        device: 'Pixel 9',
        platform: 'MACOS',
      }),
    ]);
    await signIn('session-4', 'install-2', 'Pixel 9');
    expect(await deliver()).toEqual([]);
  });

  it('stays quiet when installations registered before these emails register again', async () => {
    await signIn('session-1', 'install-1');
    await signIn('session-2', 'install-2', 'Pixel 9');
    await deliver();
    // Accounts from before sign-in emails have no record of the installations they announced.
    const known = await service.repo.query(userPK('alice'), 'KNOWN_DEVICE#', 100);
    await transact(service.repo, async (tx) => {
      for (const row of known.rows) await tx.delete(userPK('alice'), row.sk);
    });
    await signIn('session-1', 'install-1');
    await signIn('session-2', 'install-2', 'Pixel 9');
    expect(await deliver()).toEqual([]);
  });
});

describe('notice templates', () => {
  const base = { to: 'a@example.test', name: 'Ada' };
  const purgeAt = '2026-11-02T10:00:00.000Z';
  const emails: Email[] = [
    { template: 'STORAGE', ...base, level: 80, usedBytes: 40e9, quotaBytes: 50e9 },
    { template: 'STORAGE', ...base, level: 95, usedBytes: 47.5e9, quotaBytes: 50e9 },
    { template: 'STORAGE', ...base, level: 100, usedBytes: 50e9, quotaBytes: 50e9 },
    {
      template: 'BACKUP_STALE',
      ...base,
      device: 'MacBook',
      folders: [{ name: 'Documents', lastBackupAt: '2026-09-27T08:00:00.000Z' }],
    },
    {
      template: 'NEW_SIGN_IN',
      ...base,
      device: 'Pixel 9',
      platform: 'ANDROID',
      at: '2026-10-04T08:30:00.000Z',
    },
    { template: 'PASSWORD_CHANGED', ...base, at: '2026-10-04T08:30:00.000Z' },
    { template: 'SIGNED_OUT', ...base },
    { template: 'SIGNED_OUT', ...base, device: 'Pixel 9' },
    ...(['USER_REQUEST', 'TERMS_VIOLATION', 'ABUSE', 'DUPLICATE', 'OTHER'] as const).map(
      (reason): Email => ({ template: 'ACCOUNT_CLOSED', ...base, purgeAt, reason }),
    ),
  ];

  it('renders every notice as branded HTML with a matching plain-text part', () => {
    for (const email of emails) {
      const { subject, html, text } = composeEmail(email, 'https://app.harbor0.com');
      expect(subject).toBeTruthy();
      expect(html).toContain('https://harbor0.com/icon.png');
      expect(text).not.toMatch(/<[a-z]/);
      expect(text).not.toMatch(/&(amp|lt|gt|quot|#39);/);
    }
  });

  it('writes a different message for each staff deletion reason', () => {
    const intros = emails
      .filter((email) => email.template === 'ACCOUNT_CLOSED')
      .map((email) => composeEmail(email, 'https://app.harbor0.com').text.split('\n\n')[1]);
    expect(new Set(intros).size).toBe(5);
    expect(intros[0]).toContain('as you asked');
  });

  it('reports storage in readable units', () => {
    const { text } = composeEmail(emails[0], 'https://app.harbor0.com');
    expect(text).toContain('40 GB of your 50 GB');
    expect(text).toContain('Available: 10 GB');
  });
});
