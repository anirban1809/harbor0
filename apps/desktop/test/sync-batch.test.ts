import { expect, it, vi } from 'vitest';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ApiClient } from '@harbor/api-client';
import type { Journal, Root } from '../src/journal';
import { tick, twoComputers } from './two-computers';

// Changes are queued as the watcher reports them, with each file's type and size.
vi.mock('../src/local-watcher', async () => {
  const { EventEmitter } = await import('node:events');
  return { watchTree: () => Object.assign(new EventEmitter(), { close: async () => {} }) };
});

type Computer = { api: ApiClient; journal: Journal; root: Root; localPath: string };
const write = async (computer: Computer, relative: string, contents: string | Buffer) => {
  const full = path.join(computer.localPath, relative);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, contents);
  const info = await stat(full);
  computer.journal.enqueue(computer.root.id, relative, 'upsert', {
    type: 'FILE',
    sizeBytes: info.size,
    updatedAt: info.mtime.toISOString(),
  });
};
const watch = (computer: Computer) => {
  const requests: string[] = [];
  const request = computer.api.request.bind(computer.api);
  vi.spyOn(computer.api, 'request').mockImplementation(async (url, init) => {
    requests.push(`${init?.method ?? 'GET'} ${url.replace(/\/[0-9a-f-]{36}/g, '/:id')}`);
    return request(url, init);
  });
  return (pattern: RegExp) => requests.filter((r) => pattern.test(r)).length;
};

it('uploads many small new files with two requests per batch', async () => {
  const { computers, folder, cloud } = await twoComputers();
  const [first, second] = computers;
  const count = watch(first);
  for (let index = 0; index < 30; index++)
    await write(first, `Album ${index % 3}/photo-${index}.jpg`, `photo ${index}`);
  await tick(first);
  // 25 + 5 files; the three album folders are created as the files need them.
  expect(count(/^POST \/v1\/uploads\/batch$/)).toBe(2);
  expect(count(/^POST \/v1\/uploads\/batch\/finish$/)).toBe(2);
  expect(count(/^POST \/v1\/uploads$/)).toBe(0);
  expect(first.journal.jobs()).toEqual([]);
  expect(first.engine.state.issues).toEqual([]);
  const albums = (await cloud.list(folder.id)).items;
  expect(albums.map((album) => album.name).sort()).toEqual(['Album 0', 'Album 1', 'Album 2']);
  // The other computer gets every file as it was written.
  await tick(second);
  await tick(second);
  expect((await readdir(path.join(second.localPath, 'Album 1'))).length).toBe(10);
  expect(await readFile(path.join(second.localPath, 'Album 2/photo-5.jpg'), 'utf8')).toBe(
    'photo 5',
  );
});

it('uploads edits to synced files in a batch, as new versions', async () => {
  const { computers } = await twoComputers();
  const [first, second] = computers;
  for (const name of ['a.txt', 'b.txt', 'c.txt']) await write(first, name, `${name} one`);
  await tick(first);
  await tick(second);
  const count = watch(first);
  for (const name of ['a.txt', 'b.txt']) await write(first, name, `${name} two`);
  await tick(first);
  expect(count(/^POST \/v1\/uploads\/batch$/)).toBe(1);
  expect(first.journal.file(first.root.id, 'a.txt')).toMatchObject({ revision: 2 });
  await tick(second);
  await tick(second);
  expect(await readFile(path.join(second.localPath, 'a.txt'), 'utf8')).toBe('a.txt two');
  expect(await readFile(path.join(second.localPath, 'c.txt'), 'utf8')).toBe('c.txt one');
});

it('keeps both copies when a batched edit meets a newer one from another computer', async () => {
  const { computers } = await twoComputers();
  const [first, second] = computers;
  await write(first, 'plan.txt', 'original');
  await write(first, 'other.txt', 'other');
  await tick(first);
  await tick(second);
  await write(second, 'plan.txt', 'second computer');
  await tick(second);
  // Not yet seen by the first computer, which edits the version it has.
  await write(first, 'plan.txt', 'first computer');
  await write(first, 'other.txt', 'other edited');
  await first.engine.tick();
  const names = await readdir(first.localPath);
  const conflict = names.find((name) => name.startsWith('plan') && name !== 'plan.txt');
  expect(conflict).toBeDefined();
  expect(await readFile(path.join(first.localPath, conflict!), 'utf8')).toBe('first computer');
  await tick(first);
  expect(await readFile(path.join(first.localPath, 'plan.txt'), 'utf8')).toBe('second computer');
  // The other file in the batch was saved as usual.
  expect(first.journal.file(first.root.id, 'other.txt')).toMatchObject({ revision: 2 });
});

it('uploads a large file on its own alongside a batch', async () => {
  const { computers, folder, cloud } = await twoComputers();
  const [first] = computers;
  const count = watch(first);
  await write(first, 'small.txt', 'small');
  await write(first, 'large.bin', Buffer.alloc(9 * 1024 * 1024, 1));
  await tick(first);
  expect(count(/^POST \/v1\/uploads$/)).toBe(1);
  expect(count(/^POST \/v1\/uploads\/batch$/)).toBe(1);
  expect(first.journal.jobs()).toEqual([]);
  expect((await cloud.list(folder.id)).items.map((item) => item.name).sort()).toEqual([
    'large.bin',
    'small.txt',
  ]);
});

it('confirms a synced batch in one request, without looking its own uploads up again', async () => {
  const { computers } = await twoComputers();
  const [first] = computers;
  const count = watch(first);
  for (let index = 0; index < 30; index++) await write(first, `notes-${index}.txt`, `${index}`);
  await tick(first);
  const receipts = (
    first.engine as unknown as {
      receipts: { flush(): Promise<void>; audit(): Promise<void>; pendingRoots(): string[] };
    }
  ).receipts;
  await receipts.flush();
  // The uploads coming back in the change feed are revisions this computer already has.
  expect(count(/\/versions$/)).toBe(0);
  // 31 copies (the files and the folder itself): one batch, or two if the background check
  // took one of them first.
  const confirmations = () => count(/^POST \/v1\/sync\/items\/(:id\/)?acknowledge$/);
  expect(confirmations()).toBeLessThanOrEqual(2);
  expect(count(/^POST \/v1\/sync\/items\/acknowledge$/)).toBe(1);
  expect(receipts.pendingRoots()).toEqual([]);
  // Every copy is confirmed, so a check finds nothing to send again.
  const sent = confirmations();
  await receipts.audit();
  await receipts.flush();
  expect(confirmations()).toBe(sent);
});
