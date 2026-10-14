import { expect, it, vi } from 'vitest';
import { writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { userPK, type Account } from '../../backend/src/domain';
import { transact } from '../../backend/src/repository';
import { folderState, storageNeed, type SyncIssue } from '../src/sync-state';
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

it('pauses uploads that do not fit as the account being full, keeps smaller files syncing, and resumes once storage is freed', async () => {
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
  // One account-wide state, not a problem per file; the refused file waits without an error.
  expect(first.engine.state.storageFull).toMatchObject({
    availableBytes: 1000,
    requiredBytes: 2000,
  });
  expect(first.engine.state.issues).toEqual([]);
  expect(first.engine.state.message).toBe('Storage full · uploads paused');
  expect(first.journal.jobs()).toEqual([
    expect.objectContaining({ relativePath: 'big.bin', error: null, attempts: 0 }),
  ]);
  // The folder says why, instead of "Action required".
  expect(
    folderState(
      { ...first.root, localPathDisplayName: '', fileCount: 0, folderCount: 0 },
      first.engine.state,
      first.journal.jobs(),
    ),
  ).toBe('Sync paused · storage full');
  // Later passes leave it waiting instead of being refused again.
  const request = first.api.request.bind(first.api);
  const tried: string[] = [];
  vi.spyOn(first.api, 'request').mockImplementation(async (url, init) => {
    if (/^\/v1\/uploads(\/batch)?$/.test(url)) tried.push(url);
    return request(url, init);
  });
  await first.engine.tick();
  expect(tried).toEqual([]);

  // More storage arrives through the feed; the waiting file goes up and the state clears.
  await setQuota(service, () => 10_000, true);
  await first.engine.tick();
  await first.engine.tick();
  expect((await cloud.list(folder.id)).items.map((i) => i.name).sort()).toEqual([
    'big.bin',
    'small.txt',
  ]);
  expect(first.engine.state.storageFull).toBeUndefined();
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

it('clears a refusal an older version left on a file without a problem of its own', async () => {
  const { computers, service } = await twoComputers();
  const [first] = computers;
  await setQuota(service, () => 10);
  for (const name of ['a.bin', 'b.bin']) {
    await writeFile(path.join(first.localPath, name), Buffer.alloc(100));
    first.journal.enqueue(first.root.id, name, 'upsert', {
      type: 'FILE',
      sizeBytes: 100,
      updatedAt: new Date().toISOString(),
    });
  }
  const [job] = first.journal.jobs();
  // Only the error, as the server worded it; no retry delay, so the other file is refused first.
  first.journal.saveJob({ ...job, error: 'There is not enough available storage.', attempts: 1 });
  await first.engine.tick();
  expect(first.engine.state.storageFull).toBeDefined();
  expect(first.journal.jobs().map((j) => j.error)).toEqual([null, null]);
});

it('turns files an older version refused one by one into ones waiting for storage', async () => {
  const { computers, service } = await twoComputers();
  const [first] = computers;
  await setQuota(service, () => 10);
  await writeFile(path.join(first.localPath, 'a.bin'), Buffer.alloc(100));
  first.journal.enqueue(first.root.id, 'a.bin', 'upsert', {
    type: 'FILE',
    sizeBytes: 100,
    updatedAt: new Date().toISOString(),
  });
  // As an older version left it: an error, a retry delay and a problem of its own.
  const [job] = first.journal.jobs();
  first.journal.saveJob({
    ...job,
    error: 'There is not enough available storage.',
    attempts: 1,
    payload: { ...job.payload, retryAt: Date.now() + 60_000 },
  });
  first.engine.state.issues.push({
    id: `job:${job.id}`,
    rootId: first.root.id,
    code: 'STORAGE_QUOTA_EXCEEDED',
    relativePath: 'a.bin',
    message: 'There is not enough available storage.',
    jobId: job.id,
    scope: 'item',
    at: '',
  });
  await writeFile(path.join(first.localPath, 'b.bin'), Buffer.alloc(100));
  first.journal.enqueue(first.root.id, 'b.bin', 'upsert', {
    type: 'FILE',
    sizeBytes: 100,
    updatedAt: new Date().toISOString(),
  });
  await first.engine.tick();
  expect(first.engine.state.storageFull).toBeDefined();
  expect(first.engine.state.issues).toEqual([]);
  // Queued in the same millisecond, so in either order.
  expect(
    first.journal
      .jobs()
      .map((j) => [j.relativePath, j.error, j.payload.retryAt])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  ).toEqual([
    ['a.bin', null, undefined],
    ['b.bin', null, undefined],
  ]);
});

it('knows the account is full before uploading, and resumes as soon as the trash is emptied', async () => {
  const { computers, cloud, folder, service } = await twoComputers();
  const [first] = computers;
  // Some of the storage is held by a file in the trash.
  await writeFile(path.join(first.localPath, 'old.bin'), Buffer.alloc(500));
  first.journal.enqueue(first.root.id, 'old.bin', 'upsert', {
    type: 'FILE',
    sizeBytes: 500,
    updatedAt: new Date().toISOString(),
  });
  await tick(first);
  const old = (await cloud.list(folder.id)).items.find((item) => item.name === 'old.bin')!;
  await cloud.request(`/v1/drive/items/${old.id}`, {
    method: 'DELETE',
    body: { operationId: crypto.randomUUID(), baseRevision: old.revision },
  });
  await setQuota(service, (account) => account.storageUsedBytes, true);
  const fresh = new (first.engine.constructor as typeof import('../src/sync').SyncEngine)(
    first.api,
    first.journal,
    'device',
    () => {},
  );
  const tried: string[] = [];
  const request = first.api.request.bind(first.api);
  vi.spyOn(first.api, 'request').mockImplementation(async (url, init) => {
    if (/^\/v1\/uploads(\/batch)?$/.test(url)) tried.push(url);
    return request(url, init);
  });
  try {
    await fresh.tick();
    // Full from the start: shown on the folder even with nothing waiting to upload.
    expect(fresh.state.storageFull).toMatchObject({ availableBytes: 0 });
    expect(
      folderState(
        { ...first.root, localPathDisplayName: '', fileCount: 0, folderCount: 0 },
        fresh.state,
        [],
      ),
    ).toBe('Sync paused · storage full');
    await writeFile(path.join(first.localPath, 'new.txt'), 'new');
    first.journal.enqueue(first.root.id, 'new.txt', 'upsert', {
      type: 'FILE',
      sizeBytes: 3,
      updatedAt: new Date().toISOString(),
    });
    await fresh.tick();
    // Not even tried.
    expect(tried).toEqual([]);
    // Emptying the trash frees the space at once; the next pass uploads.
    await cloud.request('/v1/drive/trash/empty', {
      method: 'POST',
      body: { operationId: crypto.randomUUID() },
    });
    await fresh.tick();
    await fresh.tick();
    expect(fresh.state.storageFull).toBeUndefined();
    expect(fresh.state.storage?.availableBytes).toBeGreaterThan(0);
    expect((await cloud.list(folder.id)).items.map((item) => item.name)).toContain('new.txt');
  } finally {
    await fresh.stop();
  }
});
