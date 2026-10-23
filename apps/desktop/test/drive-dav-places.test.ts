import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Device, SyncFolderItem } from '@harbor/contracts';
import type { BackupRoot } from '../../../packages/contracts/src/backups';
import { DriveDav, type DavDrive, type DavEntry } from '../src/drive-dav';
import { placesDrive, type PlaceCatalog } from '../src/drive-dav-places';

const now = '2026-10-01T10:00:00.000Z';
const entry = (id: string, parentId: string | null, name: string, data?: string) => ({
  id,
  parentId,
  name,
  folder: data === undefined,
  size: data?.length ?? 0,
  mimeType: 'text/plain',
  created: now,
  modified: now,
  etag: `${id}-v1`,
  data,
});
const device = (id: string, name: string, platform: Device['platform'] = 'MACOS') =>
  ({ id, name, platform, devicePublicId: `pub-${id}` }) as Device;
const backup = (id: string, itemId: string, name: string, state: BackupRoot['state']) =>
  ({
    id,
    deviceId: 'mac',
    devicePublicId: 'pub-mac',
    localPathDisplayName: name,
    remoteRootDriveItemId: itemId,
    state,
  }) as BackupRoot;

let items: ReturnType<typeof entry>[];
let catalog: PlaceCatalog | Error;
let calls: string[];
let dav: DriveDav;
let root: string;
const auth = 'Basic ' + Buffer.from('harbor0:secret').toString('base64');
const propfind = async (pathname: string) => {
  const res = await fetch(root + pathname, {
    method: 'PROPFIND',
    headers: { Authorization: auth, Depth: '1' },
  });
  const names = [...(await res.text()).matchAll(/<D:href>([^<]+)<\/D:href>/g)].map((m) =>
    decodeURIComponent(m[1]!),
  );
  return { status: res.status, names: names.slice(1).sort() };
};

beforeEach(async () => {
  items = [
    entry('test', null, 'Test'),
    entry('books', null, 'Books — backup e43c63c7'),
    entry('book', 'books', 'book.txt', 'chapter one'),
    entry('music', null, 'Music — backup 1eea6501'),
    entry('photos', null, 'Photos'),
    entry('nested-sync', 'test', 'Deep sync'),
  ];
  catalog = {
    devices: [device('mac', 'MacBook'), device('web', 'Chrome', 'WEB')],
    syncFolders: [
      {
        id: 'photos',
        syncDevices: [
          { id: 'mac', name: 'MacBook' },
          { id: 'pc', name: 'Desk PC' },
        ],
      },
      { id: 'nested-sync', syncDevices: [{ id: 'mac', name: 'MacBook' }] },
    ] as SyncFolderItem[],
    backups: [backup('b1', 'books', 'Books', 'ACTIVE'), backup('b2', 'music', 'Music', 'ARCHIVED')],
  };
  calls = [];
  const drive: DavDrive = {
    async list(folderId) {
      return items.filter((item) => item.parentId === folderId);
    },
    async open(file) {
      const data = Buffer.from(items.find((item) => item.id === file.id)!.data!);
      return { size: data.length, read: async (a, b) => new Uint8Array(data.subarray(a, b)) };
    },
    async write(parentId, name) {
      calls.push(`write ${parentId} ${name}`);
      return entry('new', parentId, name, '') as DavEntry;
    },
    async mkdir(parentId, name) {
      calls.push(`mkdir ${parentId} ${name}`);
      const made = entry(`dir-${name}`, parentId, name);
      items.push(made);
      return made;
    },
    async move(moved, parentId, name) {
      calls.push(`move ${moved.id} ${parentId} ${name}`);
    },
    async remove(removed) {
      calls.push(`remove ${removed.id}`);
    },
  };
  dav = new DriveDav({
    drive: placesDrive(drive, async () => {
      if (catalog instanceof Error) throw catalog;
      return catalog;
    }),
    username: 'harbor0',
    password: 'secret',
    port: 0,
    listingTtlMs: 0,
    tempDir: await mkdtemp(path.join(os.tmpdir(), 'drive-dav-places-')),
  });
  await dav.start();
  root = `http://127.0.0.1:${dav.port}/harbor0`;
});
afterEach(() => dav.stop());

it('arranges the top into places by device, as the app does', async () => {
  expect((await propfind('/')).names).toEqual([
    '/harbor0/Archives/',
    '/harbor0/Backups/',
    '/harbor0/Synced Folders/',
    '/harbor0/Test/',
  ]);
  expect((await propfind('/Synced Folders/')).names).toEqual([
    '/harbor0/Synced Folders/Desk PC/',
    '/harbor0/Synced Folders/MacBook/',
  ]);
  // A synced folder deeper in My Drive stays where it is.
  expect((await propfind('/Synced Folders/MacBook/')).names).toEqual([
    '/harbor0/Synced Folders/MacBook/Photos/',
  ]);
  expect((await propfind('/Backups/MacBook/')).names).toEqual(['/harbor0/Backups/MacBook/Books/']);
  expect((await propfind('/Archives/MacBook/')).names).toEqual([
    '/harbor0/Archives/MacBook/Music/',
  ]);
  const file = await fetch(root + '/Backups/MacBook/Books/book.txt', {
    headers: { Authorization: auth },
  });
  expect(await file.text()).toBe('chapter one');
});

it('keeps the places and device folders to the app, and the folders inside them open', async () => {
  const at = (pathname: string, method: string, headers: Record<string, string> = {}) =>
    fetch(root + pathname, { method, headers: { Authorization: auth, ...headers } });
  expect((await at('/Backups/MacBook/New', 'MKCOL')).status).toBe(403);
  expect((await at('/Backups/Stray', 'MKCOL')).status).toBe(403);
  expect((await at('/Backups/MacBook/Books', 'DELETE')).status).toBe(403);
  expect((await at('/Backups', 'DELETE')).status).toBe(403);
  expect(
    (await at('/Backups/MacBook/Books', 'MOVE', { Destination: `${root}/Elsewhere` })).status,
  ).toBe(403);
  expect((await at('/Backups/MacBook/Books/Chapter 2', 'MKCOL')).status).toBe(201);
  expect((await at('/New', 'MKCOL')).status).toBe(201);
  expect(calls).toEqual(['mkdir books Chapter 2', 'mkdir null New']);
});

it('gives way to a cloud folder of the same name', async () => {
  items.push(entry('mine', null, 'Backups'));
  expect((await propfind('/')).names).toContain('/harbor0/Backups (2)/');
  expect((await propfind('/Backups/')).names).toEqual([]);
});

it('shows the top as it is when the devices and backups can’t be read', async () => {
  catalog = new Error('offline');
  expect((await propfind('/')).names).toEqual([
    '/harbor0/Books — backup e43c63c7/',
    '/harbor0/Music — backup 1eea6501/',
    '/harbor0/Photos/',
    '/harbor0/Test/',
  ]);
});
