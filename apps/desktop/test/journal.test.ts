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
