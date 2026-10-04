import { expect, it, vi } from 'vitest';
import { writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { userPK, type Account } from '../../backend/src/domain';
import { transact } from '../../backend/src/repository';
import { storageNeed, type SyncIssue } from '../src/sync-state';
import { storageText } from '../src/storage-text';
import { tick, twoComputers } from './two-computers';

vi.mock('../src/local-watcher', () => ({
  watchTree: () => ({
    on() {
      return this;
    },
    async close() {},
  }),
}));

/** Storage uploads fail while `broken` is set, leaving the upload started but unfinished. */
function breakStorage() {
  const real = globalThis.fetch;
  const control = { broken: true };
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (control.broken && init?.method === 'PUT') throw new TypeError('fetch failed');
    return real(url, init);
  });
  return control;
}
async function setQuota(
  service: Awaited<ReturnType<typeof twoComputers>>['service'],
  quota: (account: Account) => number,
  announce = false,
) {
  await transact(service.repo, async (tx) => {
    const account = (await tx.get<Account>(userPK('alice'), 'PROFILE'))!;
    await tx.put(userPK('alice'), 'PROFILE', { ...account, storageQuotaBytes: quota(account) });
    // As the admin console does: signed-in apps learn of the new limit through the feed.
    if (announce) await service.record(tx, 'alice', 'PROFILE_UPDATED', 'alice');
  });
}

it('frees the reserved storage of an upload whose file was deleted before it finished', async () => {
  const { computers, cloud } = await twoComputers();
  const [first] = computers;
  const storage = breakStorage();
  await writeFile(path.join(first.localPath, 'big.bin'), Buffer.alloc(150_000, 1));
  first.journal.enqueue(first.root.id, 'big.bin', 'upsert');
  await first.engine.tick();
  expect((await cloud.me()).storage.reservedBytes).toBe(150_000);
  expect(first.journal.jobs()[0].payload.upload.uploadId).toBeTruthy();

  await rm(path.join(first.localPath, 'big.bin'));
  storage.broken = false;
  await tick(first);
  expect(first.journal.jobs()).toEqual([]);
  expect((await cloud.me()).storage).toMatchObject({ reservedBytes: 0, usedBytes: 0 });
  expect(first.journal.abandonedUploads()).toEqual([]);
});

it('cancels the old upload when a file changes before its upload finished', async () => {
  const { computers, cloud, folder } = await twoComputers();
  const [first] = computers;
  const storage = breakStorage();
  await writeFile(path.join(first.localPath, 'draft.txt'), 'first draft');
  first.journal.enqueue(first.root.id, 'draft.txt', 'upsert');
  await first.engine.tick();
  expect((await cloud.me()).storage.reservedBytes).toBe('first draft'.length);

  await writeFile(path.join(first.localPath, 'draft.txt'), 'the second, longer draft');
  first.journal.enqueue(first.root.id, 'draft.txt', 'upsert');
  storage.broken = false;
  await tick(first);
  expect((await cloud.list(folder.id)).items.map((i) => [i.name, i.sizeBytes])).toEqual([
    ['draft.txt', 'the second, longer draft'.length],
  ]);
  expect((await cloud.me()).storage).toMatchObject({
    reservedBytes: 0,
    usedBytes: 'the second, longer draft'.length,
  });
});

it('frees the reserved storage of unfinished uploads when their folder stops syncing', async () => {
  const { computers, cloud } = await twoComputers();
  const [first] = computers;
  breakStorage();
  await writeFile(path.join(first.localPath, 'a.bin'), Buffer.alloc(1000));
  first.journal.enqueue(first.root.id, 'a.bin', 'upsert');
  await first.engine.tick();
  expect((await cloud.me()).storage.reservedBytes).toBe(1000);
  await first.engine.removeRoot(first.root.id);
  // Restarting after the change runs a pass of its own.
  await vi.waitFor(async () => expect((await cloud.me()).storage.reservedBytes).toBe(0));
});

it('explains a refused upload with sizes, keeps smaller files syncing, and resumes once storage is freed', async () => {
  const { computers, cloud, folder, service } = await twoComputers();
  const [first] = computers;
  await setQuota(service, () => 1000);
  await writeFile(path.join(first.localPath, 'big.bin'), Buffer.alloc(2000));
  await writeFile(path.join(first.localPath, 'small.txt'), 'fits');
  // The order a scan reports them in: the file that does not fit comes first.
  for (const [name, size] of [
    ['big.bin', 2000],
    ['small.txt', 4],
  ] as const) {
    first.journal.enqueue(first.root.id, name, 'upsert', {
      type: 'FILE',
      sizeBytes: size,
      updatedAt: new Date().toISOString(),
    });
    await new Promise((resolve) => setTimeout(resolve, 5)); // Queued in this order.
  }
  await first.engine.tick();
  expect((await cloud.list(folder.id)).items.map((i) => i.name)).toEqual(['small.txt']);
  const [issue] = first.engine.state.issues;
  expect(issue).toMatchObject({
    code: 'STORAGE_QUOTA_EXCEEDED',
    relativePath: 'big.bin',
    storage: { requiredBytes: 2000, availableBytes: 1000 },
  });
  expect(storageText(issue)).toBe(
    'This file is too big for your remaining cloud storage (needs 2 KB, 1 KB free). Smaller files keep syncing.',
  );

  // More storage arrives through the feed; the refused file does not wait out its retry delay.
  await setQuota(service, () => 10_000, true);
  await first.engine.tick();
  await first.engine.tick();
  expect((await cloud.list(folder.id)).items.map((i) => i.name).sort()).toEqual([
    'big.bin',
    'small.txt',
  ]);
  expect(first.engine.state.issues).toEqual([]);
});

it('blames the folder owner, not the user, when a shared folder owner is out of storage', () => {
  const ownerFull = Object.assign(new Error('Full.'), {
    code: 'OWNER_STORAGE_FULL',
    details: { requiredBytes: 10, availableBytes: 5 },
  });
  // The owner's free space is not the recipient's business.
  expect(storageNeed(ownerFull, false)).toEqual({ owner: true });
  const quota = Object.assign(new Error('Full.'), {
    code: 'STORAGE_QUOTA_EXCEEDED',
    details: { requiredBytes: 10, availableBytes: 5 },
  });
  expect(storageNeed(quota, true)).toEqual({ owner: true });
  const issue = (storage: SyncIssue['storage']): SyncIssue => ({
    id: 'job:1',
    rootId: 'r',
    code: 'STORAGE_QUOTA_EXCEEDED',
    message: 'There is not enough available storage.',
    at: '',
    storage,
  });
  expect(storageText(issue({ owner: true }))).toMatch(/^The owner of this shared folder is out of/);
  expect(storageText(issue({ requiredBytes: 200_000, availableBytes: 0 }))).toBe(
    'Your cloud storage is full (this file needs 200 KB). Syncing resumes once space is freed.',
  );
  expect(storageText(issue({}))).not.toMatch(/full/);
});
