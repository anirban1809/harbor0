import {
  _electron as electron,
  expect,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Journal } from '../apps/desktop/src/journal';

// Isolated profile and local test accounts. No user folders or production accounts are changed.
const base = process.env.HARBOR_TEST_API ?? 'http://127.0.0.1:8787';
const directory = await mkdtemp(path.join(os.tmpdir(), 'harbor-switch-check-'));
const profile = path.join(directory, 'profile');
const local = path.join(directory, 'alice-files');
await mkdir(profile);
await mkdir(local);
await writeFile(path.join(local, 'keep.txt'), 'Original account local file');
const response = await fetch(base + '/v1/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'alice@example.test', password: 'Development-only-123!' }),
});
assert(response.ok);
const tokens = await response.json();
const { user: alice } = await (
  await fetch(base + '/v1/users/me', { headers: { Authorization: `Bearer ${tokens.accessToken}` } })
).json();
const legacy = new Journal(path.join(profile, 'harbor.sqlite'));
legacy.set('accountId', alice.id);
legacy.set('paused', true);
legacy.set('publicId', crypto.randomUUID());
legacy.root({
  id: 'original-root',
  localPath: local,
  remoteId: null,
  mode: 'backup',
  paused: true,
  excluded: [],
});
legacy.enqueue('original-root', 'keep.txt', 'upsert');
legacy.close();
let app: ElectronApplication | undefined;
let page!: Page;
async function launch() {
  app = await electron.launch({
    args: ['apps/desktop', `--user-data-dir=${profile}`],
    env: { ...process.env, HARBOR_DEV_AUTH: 'true', HARBOR_API_URL: base },
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(10000);
}
async function login(email: string) {
  await expect(page.getByRole('heading', { name: 'Sign in to harbor0' })).toBeVisible();
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill('Development-only-123!');
  await page.getByRole('button', { name: 'Sign in to local development' }).click();
  await expect(page.getByRole('heading', { name: 'My Drive', exact: true })).toBeVisible();
  return page.evaluate(() => window.harbor.status());
}
async function logout() {
  await page.evaluate(() => window.harbor.logout());
  await expect(page.getByRole('heading', { name: 'Sign in to harbor0' })).toBeVisible();
  const status = await page.evaluate(() => window.harbor.status());
  assert.deepEqual(status.roots, []);
  assert.deepEqual(status.jobs, []);
  assert.equal(status.accountId, null);
}
try {
  await launch();
  const first = await login('alice@example.test');
  assert.equal(first.roots.length, 1);
  assert.equal(first.jobs.length, 1);
  assert.equal(first.sync.paused, true);
  await logout();
  const bob = await login('bob@example.test');
  assert.notEqual(bob.accountId, alice.id);
  assert.notEqual(bob.deviceId, first.deviceId);
  assert.deepEqual(bob.roots, []);
  assert.deepEqual(bob.jobs, []);
  assert.equal(bob.sync.paused, false);
  // Native picker fixture attempts to reuse the other account's folder.
  await app!.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [folder] })) as any;
  }, local);
  const conflict = await page.evaluate(async () => {
    const selected = await window.harbor.selectSyncLocal();
    try {
      await window.harbor.addSyncRoot({ selectionId: selected!.selectionId });
      return '';
    } catch (error) {
      return (error as Error).message;
    }
  });
  assert.match(conflict, /another account/);
  await app!.close();
  await launch();
  await expect(page.getByRole('heading', { name: 'My Drive', exact: true })).toBeVisible();
  assert.equal((await page.evaluate(() => window.harbor.status())).accountId, bob.accountId);
  await logout();
  const restored = await login('alice@example.test');
  assert.equal(restored.accountId, alice.id);
  assert.equal(restored.roots[0].id, 'original-root');
  assert.equal(restored.jobs.length, 1);
  assert.equal(restored.sync.paused, true);
  assert.equal(await readFile(path.join(local, 'keep.txt'), 'utf8'), 'Original account local file');
  console.log(
    'PASS Alice → Bob → restart → Alice: separate roots, jobs, device identities, restored settings, and unchanged local files.',
  );
  console.log('PASS Cross-account local folder reuse is rejected.');
} finally {
  await app?.close().catch(() => {});
  await rm(directory, { recursive: true, force: true });
}
