import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { expect } from '@playwright/test';
import { ApiClient, createTransport } from '@harbor/api-client';
import { uploadFile, downloadFile, type UploadState } from '../apps/desktop/src/transfers';
import { Journal, type Root } from '../apps/desktop/src/journal';
import { SyncEngine } from '../apps/desktop/src/sync';

const base = process.env.HARBOR_TEST_API ?? 'http://127.0.0.1:8787';
const dir = await mkdtemp(path.join(os.tmpdir(), 'harbor-resilience-'));
const evidence = path.resolve('test-results/desktop-resilience');
await mkdir(evidence, { recursive: true });
const results: { name: string; status: string; detail?: string }[] = [];
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    results.push({ name, status: 'PASS' });
    console.log('PASS ' + name);
  } catch (e) {
    const detail = (e as Error).message;
    results.push({ name, status: 'FAIL', detail });
    console.log('FAIL ' + name + ': ' + detail.slice(0, 400));
  }
  await writeFile(path.join(evidence, 'results.json'), JSON.stringify(results, null, 2));
}
const login = (await fetch(base + '/v1/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    email: 'bob@example.test',
    password: 'Development-only-123!',
    deviceName: 'Desktop resilience',
    platform: 'MACOS',
  }),
}).then((r) => r.json())) as any;
const transport = createTransport(base, async () => login.accessToken);
const api = new ApiClient(transport);
const folder = (await api.createFolder('Resilience ' + Date.now())).item;
const source = path.join(dir, 'source.bin');
const bytes = Buffer.alloc(65 * 1024 * 1024, 67);
await writeFile(source, bytes);
let largeItem: any;
const op = () => ({ operationId: crypto.randomUUID() });
try {
  await check(
    'Multipart upload resumes after interruption without resending its completed first part',
    async () => {
      let state: UploadState = { ...op() };
      let saved = '';
      const requested: number[] = [];
      const broken = new ApiClient(async (p, i) => {
        if (p.endsWith('/parts') && (i?.body as any)?.partNumbers.includes(2))
          throw new TypeError('Injected network outage');
        return transport(p, i);
      });
      await assert.rejects(
        uploadFile(broken, source, 'multipart.bin', folder.id, state, () => {
          saved = JSON.stringify(state);
        }),
        /Injected network outage/,
      );
      assert.equal(state.parts?.length, 1);
      state = JSON.parse(saved);
      const resumed = new ApiClient(async (p, i) => {
        if (p.endsWith('/parts')) requested.push(...(i?.body as any).partNumbers);
        return transport(p, i);
      });
      largeItem = await uploadFile(resumed, source, 'multipart.bin', folder.id, state, () => {});
      assert.deepEqual(requested, [2]);
      assert.equal(largeItem.sizeBytes, bytes.length);
      const replay = await uploadFile(api, source, 'multipart.bin', folder.id, state, () => {});
      assert.equal(replay.id, largeItem.id);
    },
  );
  await check('Partial download resumes with a Range request and matches all 65 MiB', async () => {
    const dest = path.join(dir, 'resumed.bin');
    await writeFile(dest + '.harbor-part', bytes.subarray(0, 1024 * 1024));
    let loaded = 0;
    await downloadFile(api, { driveItemId: largeItem.id }, dest, (n) => {
      loaded = n;
    });
    assert.equal(loaded, bytes.length);
    assert.deepEqual(await readFile(dest), bytes);
    await assert.rejects(stat(dest + '.harbor-part'), { code: 'ENOENT' });
  });
  await check(
    'Download hash mismatch preserves original and deletes the corrupt temporary file',
    async () => {
      const dest = path.join(dir, 'integrity.txt');
      await writeFile(dest, 'original');
      const fake = new ApiClient(async () => ({
        downloadUrl: 'data:application/octet-stream;base64,YmFk',
        sizeBytes: 3,
        contentHash: '0'.repeat(64),
      }));
      await assert.rejects(downloadFile(fake, { driveItemId: 'fixture' }, dest), /integrity/);
      assert.equal(await readFile(dest, 'utf8'), 'original');
      await assert.rejects(stat(dest + '.harbor-part'), { code: 'ENOENT' });
    },
  );
  await check('Download rejects a symlink destination without changing the target', async () => {
    const target = path.join(dir, 'target.txt');
    const link = path.join(dir, 'link.txt');
    await writeFile(target, 'safe');
    await symlink(target, link);
    await assert.rejects(downloadFile(api, { driveItemId: largeItem.id }, link), /symbolic/);
    assert.equal(await readFile(target, 'utf8'), 'safe');
  });
  await check('Empty files upload and download with correct content hash', async () => {
    const empty = path.join(dir, 'empty.txt');
    await writeFile(empty, '');
    const item = await uploadFile(api, empty, 'empty.txt', folder.id, op(), () => {});
    const dest = path.join(dir, 'empty-downloaded.txt');
    await downloadFile(api, { driveItemId: item.id }, dest);
    assert.equal((await stat(dest)).size, 0);
  });
  await check(
    'Changed file restarts its incomplete upload and retains only the new bytes',
    async () => {
      const file = path.join(dir, 'changing.txt');
      await writeFile(file, 'before');
      const state: UploadState = op();
      const broken = new ApiClient(async (p, i) => {
        if (p.endsWith('/parts')) throw new TypeError('Injected outage');
        return transport(p, i);
      });
      await assert.rejects(
        uploadFile(broken, file, 'changing.txt', folder.id, state, () => {}),
        /Injected outage/,
      );
      const previous = state.uploadId;
      await writeFile(file, 'after with a different size');
      const item = await uploadFile(api, file, 'changing.txt', folder.id, state, () => {});
      assert.notEqual(previous, state.uploadId);
      assert.equal((await api.request(`/v1/uploads/${previous}`)).upload.state, 'ABORTED');
      const dest = path.join(dir, 'changed-downloaded.txt');
      await downloadFile(api, { driveItemId: item.id }, dest);
      assert.equal(await readFile(dest, 'utf8'), 'after with a different size');
    },
  );
  // Each scenario gets an independent engine and folder; real storage and journal.
  async function withEngine(
    name: string,
    fn: (ctx: {
      engine: SyncEngine;
      journal: Journal;
      root: Root;
      remote: string;
      local: string;
    }) => Promise<void>,
    mode: 'sync' | 'backup' = 'sync',
  ) {
    const remote = (await api.createFolder(name, folder.id)).item.id;
    const local = path.join(dir, name);
    await mkdir(local);
    const journal = new Journal(path.join(dir, name + '.sqlite'));
    const root: Root = {
      id: crypto.randomUUID(),
      localPath: local,
      remoteId: remote,
      mode,
      paused: false,
      excluded: [],
    };
    journal.root(root);
    // Start from current cursor so unrelated account data is not part of this scenario.
    let cursor = 0;
    let more = true;
    while (more) {
      const feed = await api.changes(cursor);
      cursor = feed.nextCursor;
      more = feed.hasMore;
    }
    journal.set('cursor', cursor);
    const engine = new SyncEngine(api, journal, login.device.id, () => {});
    try {
      await fn({ engine, journal, root, remote, local });
    } finally {
      await engine.stop();
      journal.close();
    }
  }
  await check(
    'Local edits create new cloud versions; historical versions still download',
    async () => {
      await withEngine('versions', async ({ engine, journal, root, remote, local }) => {
        const file = path.join(local, 'notes.txt');
        await writeFile(file, 'version one');
        journal.enqueue(root.id, 'notes.txt', 'upsert');
        await engine.tick();
        const first = (await api.list(remote)).items[0];
        assert(first);
        await writeFile(file, 'version two');
        journal.enqueue(root.id, 'notes.txt', 'upsert');
        await engine.tick();
        assert.equal(journal.jobs().length, 0);
        const versions = (await api.request(`/v1/drive/items/${first.id}/versions`)).items;
        assert.equal(versions.length, 2);
        const dest = path.join(dir, 'historical.txt');
        await downloadFile(
          api,
          { driveItemId: first.id, versionId: first.currentVersionId! },
          dest,
        );
        assert.equal(await readFile(dest, 'utf8'), 'version one');
      });
    },
  );
  await check(
    'Local deletion trashes the cloud file; remote deletion removes a clean local file',
    async () => {
      await withEngine('deletions', async ({ engine, journal, root, remote, local }) => {
        const file = path.join(local, 'notes.txt');
        await writeFile(file, 'notes');
        journal.enqueue(root.id, 'notes.txt', 'upsert');
        await engine.tick();
        const item = (await api.list(remote)).items[0];
        await rm(file);
        journal.enqueue(root.id, 'notes.txt', 'delete');
        await engine.tick();
        assert.equal((await api.list(remote)).items.length, 0);
        const current = (await api.request('/v1/search?trash=true')).items.find(
          (i: any) => i.id === item.id,
        );
        assert(current);
        await api.request(`/v1/drive/items/${item.id}/restore`, {
          method: 'POST',
          body: { ...op(), baseRevision: current.revision },
        });
        await engine.tick();
        assert.equal(await readFile(file, 'utf8'), 'notes');
        const restored = (await api.list(remote)).items[0];
        await api.request(`/v1/drive/items/${item.id}`, {
          method: 'DELETE',
          body: { ...op(), baseRevision: restored.revision },
        });
        await engine.tick();
        await assert.rejects(stat(file), { code: 'ENOENT' });
      });
    },
  );
  await check(
    'Concurrent local and cloud edits preserve both versions as conflict copies',
    async () => {
      await withEngine('conflicts', async ({ engine, journal, root, remote, local }) => {
        const file = path.join(local, 'notes.txt');
        await writeFile(file, 'original');
        journal.enqueue(root.id, 'notes.txt', 'upsert');
        await engine.tick();
        const original = (await api.list(remote)).items[0];
        const external = path.join(dir, 'external.txt');
        await writeFile(external, 'cloud update');
        await uploadFile(api, external, 'notes.txt', remote, op(), () => {}, {
          itemId: original.id,
          revision: original.revision,
        });
        await writeFile(file, 'local update');
        journal.enqueue(root.id, 'notes.txt', 'upsert');
        await engine.tick();
        await engine.tick();
        assert.equal(await readFile(file, 'utf8'), 'cloud update');
        const conflict = (await readdir(local)).find((f) => f.includes('(Conflict'));
        assert(conflict);
        assert.equal(await readFile(path.join(local, conflict), 'utf8'), 'local update');
        assert((await api.list(remote)).items.some((i) => i.name.includes('(Conflict')));
      });
    },
  );
  await check('Paused roots catch up on remote changes after resuming', async () => {
    await withEngine('paused-root', async ({ engine, journal, root, remote, local }) => {
      journal.root({ ...root, paused: true });
      await api.createFolder('created-while-paused', remote);
      await engine.tick();
      await assert.rejects(stat(path.join(local, 'created-while-paused')), { code: 'ENOENT' });
      journal.root({ ...root, paused: false });
      await engine.tick();
      assert((await stat(path.join(local, 'created-while-paused'))).isDirectory());
    });
  });
  await check('Removing an exclusion downloads cloud content previously skipped', async () => {
    await withEngine('exclusion-catchup', async ({ engine, journal, root, remote, local }) => {
      journal.root({ ...root, excluded: ['Excluded'] });
      await api.createFolder('Excluded', remote);
      await engine.tick();
      await assert.rejects(stat(path.join(local, 'Excluded')), { code: 'ENOENT' });
      journal.root({ ...root, excluded: [] });
      await engine.tick();
      assert((await stat(path.join(local, 'Excluded'))).isDirectory());
    });
  });
  await check('Removing an exclusion makes the watcher pick up local files again', async () => {
    await withEngine('watch-exclusion', async ({ engine, journal, root, local }) => {
      const excluded = { ...root, excluded: ['Excluded'] };
      journal.root(excluded);
      await mkdir(path.join(local, 'Excluded'));
      await engine.watch(excluded);
      await new Promise((r) => setTimeout(r, 300));
      journal.root(root);
      await writeFile(path.join(local, 'Excluded', 'new.txt'), 'local');
      await expect
        .poll(() => journal.jobs().some((j) => j.relativePath === 'Excluded/new.txt'), {
          timeout: 3500,
        })
        .toBe(true);
    });
  });
  await check('Moving a cloud file out of a sync root removes its old local copy', async () => {
    await withEngine('move-out', async ({ engine, journal, root, remote, local }) => {
      const file = path.join(local, 'notes.txt');
      await writeFile(file, 'notes');
      journal.enqueue(root.id, 'notes.txt', 'upsert');
      await engine.tick();
      const item = (await api.list(remote)).items[0];
      const destination = (await api.createFolder('moved-out-target', folder.id)).item;
      await api.request(`/v1/drive/items/${item.id}/move`, {
        method: 'POST',
        body: { ...op(), baseRevision: item.revision, parentId: destination.id },
      });
      await engine.tick();
      await assert.rejects(stat(file), { code: 'ENOENT' });
    });
  });
  await check('Renaming a cloud folder keeps its local child mapping and content', async () => {
    await withEngine('folder-rename', async ({ engine, journal, root, remote, local }) => {
      await mkdir(path.join(local, 'old'));
      await writeFile(path.join(local, 'old', 'child.txt'), 'child');
      journal.enqueue(root.id, 'old/child.txt', 'upsert');
      await engine.tick();
      const item = (await api.list(remote)).items.find((i) => i.name === 'old')!;
      await api.request(`/v1/drive/items/${item.id}`, {
        method: 'PATCH',
        body: { ...op(), baseRevision: item.revision, name: 'new' },
      });
      await engine.tick();
      assert.equal(await readFile(path.join(local, 'new', 'child.txt'), 'utf8'), 'child');
      assert(journal.file(root.id, 'new/child.txt'));
    });
  });
  await check('Deleting a cloud folder preserves its local tree in a recovery folder', async () => {
    await withEngine('folder-delete', async ({ engine, journal, root, remote, local }) => {
      await mkdir(path.join(local, 'keep'));
      await writeFile(path.join(local, 'keep', 'child.txt'), 'keep me');
      journal.enqueue(root.id, 'keep/child.txt', 'upsert');
      await engine.tick();
      const item = (await api.list(remote)).items.find((i) => i.name === 'keep')!;
      await api.request(`/v1/drive/items/${item.id}`, {
        method: 'DELETE',
        body: { ...op(), baseRevision: item.revision },
      });
      await engine.tick();
      const recovered = (await readdir(local)).find((f) => f.includes('(Recovered by harbor0 '));
      assert(recovered);
      assert.equal(await readFile(path.join(local, recovered, 'child.txt'), 'utf8'), 'keep me');
    });
  });
  await check('Offline jobs stay queued and succeed once the network returns', async () => {
    await withEngine('offline', async ({ journal, root, remote, local }) => {
      let offline = true;
      const flaky = new ApiClient((p, i) => {
        if (offline) throw new TypeError('Injected offline');
        return transport(p, i);
      });
      const engine = new SyncEngine(flaky, journal, login.device.id, () => {});
      try {
        await writeFile(path.join(local, 'offline.txt'), 'queued');
        journal.enqueue(root.id, 'offline.txt', 'upsert');
        await engine.tick();
        assert.equal(engine.state.online, false);
        assert.equal(journal.jobs().length, 1);
        offline = false;
        await engine.tick();
        assert.equal(journal.jobs().length, 0);
        assert.equal(engine.state.online, true);
        assert((await api.list(remote)).items.some((i) => i.name === 'offline.txt'));
      } finally {
        await engine.stop();
      }
    });
  });
  await check('Backup local deletion preserves the cloud copy', async () => {
    await withEngine(
      'backup-delete',
      async ({ engine, journal, root, remote, local }) => {
        const file = path.join(local, 'notes.txt');
        await writeFile(file, 'backup');
        journal.enqueue(root.id, 'notes.txt', 'upsert');
        await engine.tick();
        await rm(file);
        journal.enqueue(root.id, 'notes.txt', 'delete');
        await engine.tick();
        assert((await api.list(remote)).items.some((i) => i.name === 'notes.txt'));
      },
      'backup',
    );
  });
  await check('Every downloaded large file matches the original SHA-256', async () => {
    const actual = createHash('sha256')
      .update(await readFile(path.join(dir, 'resumed.bin')))
      .digest('hex');
    assert.equal(actual, createHash('sha256').update(bytes).digest('hex'));
  });
} finally {
  await rm(dir, { recursive: true, force: true });
}
console.log(
  JSON.stringify({
    passed: results.filter((r) => r.status === 'PASS').length,
    failed: results.filter((r) => r.status === 'FAIL').length,
  }),
);
if (results.some((r) => r.status === 'FAIL')) process.exitCode = 1;
