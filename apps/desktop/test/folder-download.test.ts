import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  ZipReader,
  Uint8ArrayReader,
  TextWriter,
  ZipWriter,
  Uint8ArrayWriter,
  TextReader,
} from '@zip.js/zip.js';
import { ApiClient } from '@harbor/api-client';
import { downloadFolderZip } from '../src/transfers';

let directory: string;
const folder = { id: 'folder', name: 'Documents' };
let archive: Uint8Array;
const requests: string[] = [];
const api = new ApiClient(async (path, init) => {
  requests.push(path);
  if (path === '/v1/folder-downloads')
    return {
      id: 'job',
      name: 'Documents.zip',
      state: 'READY',
      files: 1,
      bytes: 5,
      sizeBytes: archive.length,
      downloadUrl: 'https://storage.test/archive',
    };
  if (path === '/v1/downloads') {
    expect(init?.body).toEqual({ folderDownloadId: 'job' });
    return {
      downloadUrl: 'https://storage.test/archive',
      sizeBytes: archive.length,
      contentHash: createHash('sha256').update(archive).digest('hex'),
    };
  }
  throw new Error('Unexpected per-file request');
});
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'harbor-zip-'));
  requests.length = 0;
  const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false });
  await writer.add('Documents/hello.txt', new TextReader('Hello'));
  archive = await writer.close();
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(directory, { recursive: true, force: true });
});
it('saves a valid archive and removes its temporary file', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(Buffer.from(archive))),
  );
  const destination = join(directory, 'Documents.zip');
  const onProgress = vi.fn();
  await downloadFolderZip(api, folder, destination, onProgress);
  expect(onProgress).toHaveBeenCalledWith(
    expect.objectContaining({
      phase: 'downloading',
      currentFile: null,
      fileSize: archive.length,
    }),
  );
  expect(requests).toEqual(['/v1/folder-downloads', '/v1/downloads']);
  const reader = new ZipReader(new Uint8ArrayReader(await readFile(destination)), {
    useWebWorkers: false,
  });
  const entries = await reader.getEntries();
  const file = entries.find((entry) => entry.filename === 'Documents/hello.txt')!;
  expect(!file.directory && (await file.getData(new TextWriter()))).toBe('Hello');
  await reader.close();
  expect(await readdir(directory)).toEqual(['Documents.zip']);
});
it('keeps an existing file and removes partial output when a download fails', async () => {
  const destination = join(directory, 'Documents.zip');
  await writeFile(destination, 'original');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('Wrong')),
  );
  await expect(downloadFolderZip(api, folder, destination)).rejects.toThrow('integrity');
  expect(await readFile(destination, 'utf8')).toBe('original');
  expect(await readdir(directory)).toEqual(['Documents.zip']);
});
it('refuses a symbolic-link destination', async () => {
  const destination = join(directory, 'Documents.zip');
  const original = join(directory, 'original');
  await writeFile(original, 'original');
  await symlink(original, destination);
  await expect(downloadFolderZip(api, folder, destination)).rejects.toThrow('symbolic link');
  expect(await readFile(original, 'utf8')).toBe('original');
});
