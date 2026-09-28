import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ApiClient, createTransport } from '@harbor/api-client';
import { Journal, type Root } from '../apps/desktop/src/journal';
import { SyncEngine } from '../apps/desktop/src/sync';
import { uploadFile } from '../apps/desktop/src/transfers';
const directory = await mkdtemp(path.join(os.tmpdir(), 'harbor-sync-e2e-'));
const local = path.join(directory, 'sync');
await mkdir(local);
const login = (await fetch('http://127.0.0.1:8787/v1/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    email: 'alice@example.test',
    password: 'Development-only-123!',
    deviceName: 'Sync integration',
    platform: 'MACOS',
  }),
}).then((r) => r.json())) as any;
const api = new ApiClient(createTransport('http://127.0.0.1:8787', async () => login.accessToken));
const { item: folder } = await api.createFolder('Sync verification ' + Date.now());
const journal = new Journal(path.join(directory, 'journal.sqlite'));
const root: Root = {
  id: 'root',
  localPath: local,
  remoteId: folder.id,
  mode: 'sync',
  paused: false,
  excluded: [],
};
journal.root(root);
const engine = new SyncEngine(api, journal, login.device.id, () => {});
try {
  await writeFile(path.join(local, 'local.txt'), 'Local changes reach the cloud.');
  journal.enqueue(root.id, 'local.txt', 'upsert');
  await engine.tick();
  if (journal.jobs().length)
    throw new Error(journal.jobs()[0].error ?? 'Local job remained pending');
  const remote = (await api.list(folder.id)).items.find((i) => i.name === 'local.txt');
  if (!remote) throw new Error('Local file did not upload.');
  const source = path.join(directory, 'remote.txt');
  await writeFile(source, 'Cloud changes reach this computer.');
  await uploadFile(
    api,
    source,
    'remote.txt',
    folder.id,
    { operationId: crypto.randomUUID() },
    () => {},
  );
  await engine.tick();
  if (
    (await readFile(path.join(local, 'remote.txt'), 'utf8')) !==
    'Cloud changes reach this computer.'
  )
    throw new Error('Remote file did not download.');
  await api.request(`/v1/drive/items/${remote.id}`, {
    method: 'PATCH',
    body: { operationId: crypto.randomUUID(), baseRevision: remote.revision, name: 'renamed.txt' },
  });
  await engine.tick();
  if (
    (await readFile(path.join(local, 'renamed.txt'), 'utf8')) !== 'Local changes reach the cloud.'
  )
    throw new Error('Remote rename was not applied.');
  console.log(
    'Desktop engine: local upload, remote download, hash validation, and remote rename passed against DynamoDB and object storage.',
  );
} finally {
  await engine.stop();
  journal.close();
  await rm(directory, { recursive: true, force: true });
}
