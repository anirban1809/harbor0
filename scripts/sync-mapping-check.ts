import { _electron as electron, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
const directory = await mkdtemp(path.join(os.tmpdir(), 'harbor-sync-mapping-'));
const local = path.join(directory, 'Selected');
await mkdir(local);
const items = [
  { id: 'projects', name: 'Projects', parentId: null, type: 'FOLDER' },
  { id: 'selected', name: 'editor', parentId: 'projects', type: 'FOLDER' },
  { id: 'child', name: 'From cloud', parentId: 'selected', type: 'FOLDER' },
  { id: 'other', name: 'Unselected', parentId: null, type: 'FOLDER' },
  { id: 'cloud-only', name: 'Cloud-only.pdf', parentId: 'other', type: 'FILE' },
].map((item) => ({
  ...item,
  normalizedName: item.name.toLowerCase(),
  revision: 1,
  deletedAt: null,
  sizeBytes: 0,
}));
const requests: { endpoint: string; method: string; body: any }[] = [];
const server = createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  const input = body ? JSON.parse(body) : undefined;
  const url = new URL(req.url!, 'http://fixture');
  requests.push({ endpoint: url.pathname, method: req.method!, body: input });
  res.setHeader('Content-Type', 'application/json');
  let data: unknown;
  if (url.pathname === '/v1/auth/login' || url.pathname === '/v1/auth/refresh')
    data = { accessToken: 'fixture', refreshToken: 'fixture-refresh', expiresIn: 900 };
  else if (url.pathname === '/v1/auth/session')
    data = { device: { id: 'device', name: 'Fixture Mac', devicePublicId: 'public' } };
  else if (url.pathname === '/v1/users/me')
    data = {
      user: { id: 'fixture' },
      storage: {
        usedBytes: 0,
        quotaBytes: 100000000000,
        reservedBytes: 0,
        availableBytes: 100000000000,
      },
    };
  else if (url.pathname === '/v1/sync/changes')
    data = {
      changes: items
        .filter((item) => ['child', 'cloud-only'].includes(item.id))
        .map((item) => ({ item })),
      nextCursor: 1,
      hasMore: false,
    };
  else if (/\/folders\/[^/]+\/children$/.test(url.pathname)) {
    const parent = url.pathname.split('/').at(-2)!;
    data = {
      items: items.filter((item) => item.parentId === (parent === 'root' ? null : parent)),
      nextCursor: null,
    };
  } else if (url.pathname === '/v1/drive/folders' && req.method === 'POST') {
    if (items.some((item) => item.parentId === input.parentId && item.name === input.name)) {
      res.statusCode = 409;
      res.end(JSON.stringify({ error: { code: 'NAME_CONFLICT', message: 'Name already used.' } }));
      return;
    }
    const item = {
      id: `auto-${items.length}`,
      name: input.name,
      parentId: input.parentId,
      type: 'FOLDER',
      normalizedName: input.name.toLowerCase(),
      revision: 1,
      deletedAt: null,
      sizeBytes: 0,
    };
    items.push(item);
    data = { item };
  } else if (url.pathname.startsWith('/v1/drive/items/'))
    data = { item: items.find((item) => item.id === url.pathname.split('/').at(-1)) };
  else data = {};
  res.end(JSON.stringify(data));
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const app = await electron.launch({
  args: ['apps/desktop', `--user-data-dir=${directory}/profile`],
  env: {
    ...process.env,
    HARBOR_DEV_AUTH: 'true',
    HARBOR_API_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
  },
});
try {
  const page = await app.firstWindow();
  await expect(page.getByRole('heading', { name: 'Sign in to harbor0' })).toBeVisible();
  await page.getByLabel('Password', { exact: true }).fill('fixture-password');
  await page.getByRole('button', { name: 'Sign in to local development' }).click();
  await expect(page.getByRole('heading', { name: 'My Drive', exact: true })).toBeVisible();
  await app.evaluate(({ dialog }, local) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [local] })) as any;
  }, local);
  const selection = await page.evaluate(() => window.harbor.selectSyncLocal());
  assert(selection);
  assert.deepEqual(await readdir(local), []);
  assert.equal((await page.evaluate(() => window.harbor.status())).roots.length, 0);
  await assert.rejects(
    page.evaluate((input) => window.harbor.addSyncRoot(input), {
      selectionId: selection.selectionId,
      cloudFolderId: null,
    }),
    /Choose a cloud folder/,
  );
  await page.evaluate((input) => window.harbor.addSyncRoot(input), {
    selectionId: selection.selectionId,
    cloudFolderId: 'selected',
  });
  await expect.poll(async () => (await readdir(local)).includes('From cloud')).toBe(true);
  const status = await page.evaluate(() => window.harbor.status());
  assert.equal(status.roots[0].remoteId, 'selected');
  assert.equal(status.roots[0].cloudPath, 'My Drive / Projects / editor');
  assert.equal(status.deviceName, 'Fixture Mac');
  assert.deepEqual(await readdir(local), ['From cloud']);
  assert(!requests.some((request) => request.endpoint === '/v1/downloads'));
  await page.evaluate((id) => window.harbor.stopSyncRoot({ id }), status.roots[0].id);
  assert.equal((await page.evaluate(() => window.harbor.status())).roots.length, 0);
  assert((await stat(path.join(local, 'From cloud'))).isDirectory());
  assert(!requests.some((request) => request.method === 'DELETE'));
  // Local-only setup provisions its own reference; repeating a name does not attach unrelated files.
  for (let attempt = 0; attempt < 2; attempt++) {
    const localSelection = await page.evaluate(() => window.harbor.selectSyncLocal());
    assert(localSelection);
    const added = await page.evaluate(
      (selectionId) => window.harbor.addSyncRoot({ selectionId }),
      localSelection.selectionId,
    );
    const automaticStatus = await page.evaluate(() => window.harbor.status());
    const automaticRoot = automaticStatus.roots.find((root: any) => root.id === added.id);
    assert(automaticRoot.remoteId.startsWith('auto-'));
    assert.equal(automaticRoot.localPath, localSelection.path);
    assert(automaticRoot.cloudPath.startsWith('My Drive / Selected'));
    const countBeforeOverlap = requests.filter(
      (request) => request.endpoint === '/v1/drive/folders',
    ).length;
    const duplicate = await page.evaluate(() => window.harbor.selectSyncLocal());
    assert(duplicate);
    await assert.rejects(
      page.evaluate(
        (selectionId) => window.harbor.addSyncRoot({ selectionId }),
        duplicate.selectionId,
      ),
      /must not overlap/,
    );
    assert.equal(
      requests.filter((request) => request.endpoint === '/v1/drive/folders').length,
      countBeforeOverlap,
    );
    await page.evaluate((id) => window.harbor.stopSyncRoot({ id }), added.id);
  }
  console.log(
    'PASS: real Electron bridge, native selection, local-only setup, automatic name collision recovery, overlap rejection, existing mappings, scoped reconciliation, cloud-only isolation, registered device name, and stop without deleting either copy',
  );
} finally {
  await app.close();
  server.close();
  await rm(directory, { recursive: true, force: true });
}
