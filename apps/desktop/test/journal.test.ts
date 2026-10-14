import { it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Journal } from '../src/journal';
it('retains pending transfer receipts and checkpoints across restart', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harbor-journal-'));
  try {
    const file = path.join(root, 'journal.sqlite');
    let journal = new Journal(file);
    journal.root({
      id: 'root',
      localPath: root,
      remoteId: null,
      mode: 'sync',
      paused: false,
      excluded: ['Archive'],
    });
    journal.enqueue('root', 'large.mov', 'upsert');
    journal.enqueue('root', 'large.mov', 'upsert');
    expect(journal.jobs()).toHaveLength(1);
    const job = journal.jobs()[0];
    job.payload = { upload: { uploadId: 'upload', parts: [{ partNumber: 1, etag: 'receipt' }] } };
    journal.saveJob(job);
    journal.set('cursor', 42);
    journal.close();
    journal = new Journal(file);
    expect(journal.jobs()[0].payload.upload.parts[0].etag).toBe('receipt');
    expect(journal.get('cursor')).toBe(42);
    expect(journal.roots()[0].excluded).toEqual(['Archive']);
    journal.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('persists the installation identity before registration and reuses it after restart', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harbor-device-'));
  try {
    const file = path.join(root, 'journal.sqlite');
    let journal = new Journal(file);
    const id = journal.devicePublicId();
    expect(id).toBeTruthy();
    expect(journal.devicePublicId()).toBe(id);
    journal.close();
    // No successful network registration is required to retain the identity.
    journal = new Journal(file);
    expect(journal.devicePublicId()).toBe(id);
    journal.set('publicId', 'existing-installation');
    expect(journal.devicePublicId()).toBe('existing-installation');
    journal.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('counts tracked files and folders per root without including other roots', () => {
  const journal = new Journal(':memory:');
  try {
    const file = {
      rootId: 'sync',
      relativePath: 'notes.txt',
      itemId: 'file',
      revision: 1,
      hash: null,
      type: 'FILE' as const,
    };
    journal.putFile(file);
    journal.putFile({ ...file, relativePath: 'Projects', itemId: 'folder', type: 'FOLDER' });
    journal.putFile({ ...file, rootId: 'backup', relativePath: 'copy.txt' });
    expect(journal.fileCounts('sync')).toEqual({ fileCount: 1, folderCount: 1 });
    expect(journal.fileCounts('backup')).toEqual({ fileCount: 1, folderCount: 0 });
    expect(journal.fileCounts('empty')).toEqual({ fileCount: 0, folderCount: 0 });
    journal.deleteFile('sync', 'notes.txt');
    expect(journal.fileCounts('sync')).toEqual({ fileCount: 0, folderCount: 1 });
  } finally {
    journal.close();
  }
});

it('looks up remote identities within their root and counts queued work without loading payloads', () => {
  const journal = new Journal(':memory:');
  try {
    const file = {
      rootId: 'one',
      relativePath: 'notes.txt',
      itemId: 'shared-id',
      revision: 1,
      hash: 'hash',
      type: 'FILE' as const,
    };
    journal.putFile(file);
    journal.putFile({ ...file, rootId: 'two', relativePath: 'different.txt' });
    expect(journal.fileByItem('one', 'shared-id')).toEqual(file);
    journal.deleteFile('one', 'notes.txt');
    journal.putFile({ ...file, relativePath: 'renamed.txt' });
    expect(journal.fileByItem('one', 'shared-id')?.relativePath).toBe('renamed.txt');
    expect(journal.fileByItem('two', 'shared-id')?.relativePath).toBe('different.txt');
    expect(journal.fileByItem('missing', 'shared-id')).toBeUndefined();
    journal.enqueue('one', 'renamed.txt', 'upsert');
    journal.enqueue('two', 'different.txt', 'upsert');
    expect(journal.jobCount()).toBe(2);
    journal.finish(journal.jobs()[0].id);
    expect(journal.jobCount()).toBe(1);
  } finally {
    journal.close();
  }
});

it('lists only the items directly inside a folder', () => {
  const journal = new Journal(':memory:');
  try {
    const file = { rootId: 'sync', itemId: 'i', revision: 1, hash: null, type: 'FILE' as const };
    for (const relativePath of [
      'top.txt',
      '😀 top.txt',
      'Docs',
      'Docs/a.txt',
      'Docs/😀 b.txt',
      'Docs/Inner',
      'Docs/Inner/c.txt',
      'Docs 2/d.txt',
    ])
      journal.putFile({ ...file, relativePath });
    journal.putFile({ ...file, rootId: 'other', relativePath: 'Docs/e.txt' });
    const names = (folder: string) =>
      journal
        .children('sync', folder)
        .map((f) => f.relativePath)
        .sort();
    expect(names('')).toEqual(['Docs', 'top.txt', '😀 top.txt']);
    expect(names('Docs')).toEqual(['Docs/Inner', 'Docs/a.txt', 'Docs/😀 b.txt']);
    expect(names('Docs/Inner')).toEqual(['Docs/Inner/c.txt']);
    expect(names('Missing')).toEqual([]);
  } finally {
    journal.close();
  }
});

it('finds one queued job by id or path and summarizes a large queue for the window', () => {
  const journal = new Journal(':memory:');
  try {
    for (const id of ['one', 'two'])
      journal.root({
        id,
        localPath: `/${id}`,
        remoteId: id,
        mode: 'sync',
        paused: false,
        excluded: [],
      });
    const id = journal.enqueue('one', 'a.txt', 'upsert');
    journal.enqueue('one', 'b.txt', 'upsert');
    journal.enqueue('two', 'c.txt', 'delete');
    expect(journal.job(id)?.relativePath).toBe('a.txt');
    expect(journal.pendingJob('one', 'b.txt', 'upsert')?.relativePath).toBe('b.txt');
    expect(journal.pendingJob('one', 'b.txt', 'delete')).toBeUndefined();
    expect(journal.jobs('two').map((job) => job.relativePath)).toEqual(['c.txt']);
    expect(journal.pendingPaths('one')).toEqual(new Set(['a.txt', 'b.txt']));
    const failed = journal.pendingJob('one', 'b.txt', 'upsert')!;
    journal.saveJob({ ...failed, attempts: 1, error: 'Denied' });
    // One job per busy folder plus every failure, never the whole queue.
    expect(journal.jobSummary()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rootId: 'one', relativePath: 'b.txt', error: 'Denied' }),
        expect.objectContaining({ rootId: 'two' }),
      ]),
    );
    expect(journal.jobSummary().filter((job) => job.rootId === 'one')).toHaveLength(2);
  } finally {
    journal.close();
  }
});

it('queues a hundred thousand files in seconds, not hours', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'harbor-journal-'));
  const journal = new Journal(path.join(directory, 'journal.sqlite'));
  try {
    const started = Date.now();
    for (let start = 0; start < 100_000; start += 16)
      journal.transaction(() => {
        for (let index = start; index < start + 16; index++) {
          const relative = `Photos/${index % 500}/IMG_${index}.jpg`;
          // What a folder scan does for every file it finds.
          journal.pendingJob('root', relative, 'upsert');
          journal.enqueue('root', relative, 'upsert');
        }
      });
    expect(journal.jobCount()).toBe(100_000);
    expect(Date.now() - started).toBeLessThan(30_000);
  } finally {
    journal.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

it('reads the queue a page at a time and leaves out jobs queued after the pass began', () => {
  const journal = new Journal(':memory:');
  try {
    for (let index = 0; index < 7; index++) journal.enqueue('one', `f${index}`, 'upsert');
    journal.enqueue('two', 'other', 'upsert');
    const before = Date.now();
    const seen: string[] = [];
    let after: { createdAt: number; id: string } | null = null;
    for (;;) {
      const page = journal.jobsPage(['one'], after, before, 3);
      if (!page.jobs.length) break;
      expect(page.jobs.length).toBeLessThanOrEqual(3);
      seen.push(...page.jobs.map((job) => job.relativePath));
      after = page.last;
      // Queued during the pass: it waits for the next one.
      journal.enqueue('one', `late${seen.length}`, 'upsert');
      const db = (journal as any).db;
      db.prepare('UPDATE jobs SET created_at=? WHERE relative_path LIKE ?').run(
        before + 1,
        'late%',
      );
    }
    expect(seen.sort()).toEqual(['f0', 'f1', 'f2', 'f3', 'f4', 'f5', 'f6']);
    expect(journal.jobsOfKind('one', 'upsert')).toHaveLength(10);
  } finally {
    journal.close();
  }
});
