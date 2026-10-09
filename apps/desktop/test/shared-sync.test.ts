import { it, expect, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ApiClient, ApiError } from '@harbor/api-client';
import { StorageService } from '../../backend/src/domain';
import { MemoryRepository } from '../../backend/src/repository';
import { MemoryStorage } from '../../backend/src/storage';
import { DevelopmentAuth } from '../../backend/src/auth';
import { createApp } from '../../backend/src/api';
import { Journal, type Root } from '../src/journal';
import { SyncEngine } from '../src/sync';

// Trigger watcher jobs deterministically; use real files, engine, API, permissions and hashes.
vi.mock('../src/local-watcher', () => ({
  watchTree: () => ({
    on() {
      return this;
    },
    async close() {},
  }),
}));
// Windows paths are full of backslashes.
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
it('syncs real files across separate accounts, preserves conflicts and detaches safely on revocation', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'harbor-shared-sync-'));
  const storage = new MemoryStorage();
  const service = new StorageService(new MemoryRepository(), storage);
  const { app } = createApp(service, new DevelopmentAuth());
  const clients = new Map<
    string,
    { api: ApiClient; journal: Journal; engine: SyncEngine; root: Root }
  >();
  vi.stubGlobal('fetch', async (raw: string, init?: RequestInit) => {
    const url = new URL(raw);
    if (url.protocol !== 'memory:') throw new Error('Unexpected network request: ' + raw);
    if (init?.method === 'PUT') {
      storage.uploads
        .get(url.hostname)!
        .parts.set(Number(url.pathname.slice(1)), new Uint8Array(init.body as Buffer));
      return new Response('', { headers: { etag: 'part-1' } });
    }
    return new Response(Buffer.from(storage.objects.get(url.pathname.slice(1))!));
  });
  try {
    for (const user of ['alice', 'bob']) {
      const api = new ApiClient(async (endpoint, init) => {
        const response = await app.request(endpoint, {
          method: init?.method,
          headers: { Authorization: `Bearer dev-${user}`, 'Content-Type': 'application/json' },
          body: init?.body ? JSON.stringify(init.body) : undefined,
        });
        const data = await response.json();
        if (!response.ok) throw new ApiError(data.error.code, data.error.message, response.status);
        return data;
      });
      await api.request('/v1/auth/session', {
        method: 'POST',
        body: { name: user, platform: 'MACOS', devicePublicId: user },
      });
      const localPath = path.join(directory, user);
      await mkdir(localPath);
      const journal = new Journal(':memory:');
      const root: Root = {
        id: user,
        localPath,
        remoteId: null,
        mode: 'sync',
        paused: false,
        excluded: [],
        needsReconcile: true,
      };
      const engine = new SyncEngine(api, journal, `dev-${user}`, () => {});
      clients.set(user, { api, journal, root, engine });
    }
    const alice = clients.get('alice')!,
      bob = clients.get('bob')!;
    const folder = (await alice.api.createFolder('Shared project')).item;
    alice.root.remoteId = folder.id;
    alice.journal.root(alice.root);
    await alice.api.request('/v1/sync/folders', {
      method: 'PUT',
      body: { folderIds: [folder.id] },
    });
    const { share } = await alice.api.request('/v1/sync/shares', {
      method: 'POST',
      body: {
        operationId: crypto.randomUUID(),
        driveItemId: folder.id,
        recipient: { type: 'EMAIL', value: 'bob@example.test' },
      },
    });
    await bob.api.request(`/v1/sync/shares/${share.id}/respond`, {
      method: 'POST',
      body: { action: 'ACCEPTED' },
    });
    bob.root.remoteId = folder.id;
    bob.root.shareId = share.id;
    bob.journal.root(bob.root);
    await bob.api.request('/v1/sync/folders', { method: 'PUT', body: { folderIds: [folder.id] } });
    const tick = async (user: typeof alice) => {
      await user.engine.tick();
      expect(user.engine.state.issues.filter((i) => i.code !== 'CONFLICT')).toEqual([]);
    };
    const edit = async (user: typeof alice, name: string, content: string) => {
      await writeFile(path.join(user.root.localPath, name), content);
      user.journal.enqueue(user.root.id, name, 'upsert');
    };
    await edit(alice, 'notes.txt', 'from Alice');
    await tick(alice);
    await tick(bob);
    expect(await readFile(path.join(bob.root.localPath, 'notes.txt'), 'utf8')).toBe('from Alice');
    await edit(bob, 'notes.txt', 'edited by Bob');
    await tick(bob);
    await tick(alice);
    expect(await readFile(path.join(alice.root.localPath, 'notes.txt'), 'utf8')).toBe(
      'edited by Bob',
    );
    await mkdir(path.join(bob.root.localPath, 'Nested'));
    await edit(bob, 'Nested/new.txt', 'created by Bob');
    await tick(bob);
    await tick(alice);
    expect(await readFile(path.join(alice.root.localPath, 'Nested/new.txt'), 'utf8')).toBe(
      'created by Bob',
    );
    const file = (await alice.api.list(folder.id)).items.find((i) => i.name === 'notes.txt')!;
    await alice.api.request(`/v1/drive/items/${file.id}`, {
      method: 'PATCH',
      body: { operationId: crypto.randomUUID(), baseRevision: file.revision, name: 'renamed.txt' },
    });
    await tick(alice);
    await tick(bob);
    expect(await readFile(path.join(bob.root.localPath, 'renamed.txt'), 'utf8')).toBe(
      'edited by Bob',
    );
    // Two offline edits must survive; the recipient's copy becomes a conflict file.
    await edit(alice, 'renamed.txt', 'Alice concurrent');
    await edit(bob, 'renamed.txt', 'Bob concurrent');
    await tick(alice);
    await tick(bob);
    const conflict = (await readdir(bob.root.localPath)).find((name) =>
      name.includes('(Conflict'),
    )!;
    expect(conflict).toBeTruthy();
    expect(await readFile(path.join(bob.root.localPath, conflict), 'utf8')).toBe('Bob concurrent');
    expect(await readFile(path.join(bob.root.localPath, 'renamed.txt'), 'utf8')).toBe(
      'Alice concurrent',
    );
    // Recipient deletion travels back to the owner, without deleting the whole shared root.
    await rm(path.join(bob.root.localPath, 'Nested/new.txt'));
    bob.journal.enqueue(bob.root.id, 'Nested/new.txt', 'delete');
    await tick(bob);
    await tick(alice);
    await expect(readFile(path.join(alice.root.localPath, 'Nested/new.txt'))).rejects.toMatchObject(
      { code: 'ENOENT' },
    );
    await edit(bob, 'kept-local.txt', 'not uploaded after revoke');
    await alice.api.request(`/v1/shares/${share.id}`, {
      method: 'DELETE',
      body: { operationId: crypto.randomUUID() },
    });
    await bob.engine.tick();
    expect(bob.journal.roots()).toEqual([]);
    // The folder leaves the list with a notice that says why and where the files are.
    expect(bob.engine.state.issues).toEqual([
      expect.objectContaining({
        code: 'SYNC_DETACHED',
        message: expect.stringMatching(
          new RegExp(
            `stopped sharing “bob” with you\\. Your local files are still in ${escapeRegExp(bob.root.localPath)}`,
          ),
        ),
      }),
    ]);
    expect(await readFile(path.join(bob.root.localPath, 'kept-local.txt'), 'utf8')).toBe(
      'not uploaded after revoke',
    );
    expect((await alice.api.list(folder.id)).items.some((i) => i.name === 'kept-local.txt')).toBe(
      false,
    );
  } finally {
    for (const client of clients.values()) {
      await client.engine.stop();
      client.journal.close();
    }
    vi.unstubAllGlobals();
    await rm(directory, { recursive: true, force: true });
  }
});
