import {
  _electron as electron,
  expect,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ApiClient, createTransport } from '@harbor/api-client';
import { uploadFile } from '../apps/desktop/src/transfers';

// Requires the local development API. Native picker results are automated; file I/O,
// OS encryption, Electron IPC, renderer actions, API calls, and storage are real.
const base = process.env.HARBOR_TEST_API ?? 'http://127.0.0.1:8787';
const run = Date.now().toString();
const dir = await mkdtemp(path.join(os.tmpdir(), 'harbor-functional-'));
const evidence = path.resolve('test-results/desktop-functional');
await mkdir(evidence, { recursive: true });
const results: { name: string; status: string; detail?: string }[] = [];
const errors: string[] = [];
let app!: ElectronApplication;
let page: Page;
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    results.push({ name, status: 'PASS' });
    console.log('PASS ' + name);
  } catch (e) {
    const detail = (e as Error).message;
    results.push({ name, status: 'FAIL', detail });
    console.log('FAIL ' + name + ': ' + detail.slice(0, 350));
    await page
      ?.screenshot({ path: path.join(evidence, `failure-${results.length}.png`) })
      .catch(() => {});
  }
  await writeFile(
    path.join(evidence, 'results.json'),
    JSON.stringify({ results, errors }, null, 2),
  );
}
let sessionCounter = 0;
async function loginApi(email: string) {
  const response = await fetch(base + '/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      password: 'Development-only-123!',
      deviceName: 'Desktop QA fixture ' + run + '-' + ++sessionCounter,
      platform: 'MACOS',
    }),
  });
  assert(response.ok);
  const session = (await response.json()) as any;
  return { api: new ApiClient(createTransport(base, async () => session.accessToken)), session };
}
const { api: alice } = await loginApi('alice@example.test');
const { api: bob } = await loginApi('bob@example.test');
const profile = path.join(dir, 'profile');
const source = path.join(dir, `sample-${run}.txt`);
const empty = path.join(dir, `empty-${run}.txt`);
const large = path.join(dir, `multipart-${run}.bin`);
await writeFile(source, 'harbor0 desktop functional verification\nUnicode: résumé ✓\n');
await writeFile(empty, '');
await writeFile(large, Buffer.alloc(11 * 1024 * 1024, 83));
async function launch() {
  app = await electron.launch({
    args: ['apps/desktop', `--user-data-dir=${profile}`],
    env: { ...process.env, HARBOR_DEV_AUTH: 'true', HARBOR_API_URL: base },
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(12000);
  page.on('pageerror', (e) => errors.push(e.message));
  app.process().stderr?.on('data', (b) => {
    if (/Error|failed/i.test(String(b))) errors.push(String(b));
  });
}
async function openFiles(files: string[], canceled = false) {
  await app.evaluate(
    ({ dialog }, input) => {
      dialog.showOpenDialog = (async () => ({
        canceled: input.canceled,
        filePaths: input.files,
      })) as any;
    },
    { files, canceled },
  );
}
async function saveAs(filePath: string, canceled = false) {
  await app.evaluate(
    ({ dialog }, input) => {
      dialog.showSaveDialog = (async () => input) as any;
    },
    { filePath, canceled },
  );
}
async function nav(name: string) {
  await page.locator('nav').getByRole('button', { name, exact: true }).click();
  await expect(
    page.getByRole('heading', { name: name === 'Sync' ? /^Sync on / : name, exact: true }),
  ).toBeVisible();
}
async function uiLogin(email = 'alice@example.test', password = 'Development-only-123!') {
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in to local development' }).click();
}
const row = (name: string) =>
  page
    .locator('.file-entry-row, .simple-row, .connected-folder')
    .filter({ has: page.locator('strong', { hasText: name }) });
async function fileAction(name: string, action: string) {
  await page.getByRole('button', { name: `Actions for ${name}`, exact: true }).click();
  await page.getByRole('menuitem', { name: action, exact: true }).click();
}
async function currentItem(name: string, parent: string | null = null) {
  const item = (await alice.list(parent)).items.find((i) => i.name === name);
  assert(item, 'Missing remote item ' + name);
  return item;
}
const op = () => ({ operationId: crypto.randomUUID() });
let folder: any;
let uploaded: any;
let syncRoot: any;
let backupRoot: any;
const folderName = 'Desktop QA ' + run;
const renamedFolder = folderName + ' renamed';
const syncPath = path.join(dir, 'sync');
const backupPath = path.join(dir, 'backup');
await mkdir(syncPath);
await mkdir(backupPath);
try {
  await launch();
  await check('Startup: sign-in screen, no renderer errors, sandbox and keychain', async () => {
    await expect(page.getByRole('heading', { name: 'Sign in to harbor0' })).toBeVisible();
    assert.equal(await page.locator('.error').count(), 0);
    const security = await app.evaluate(({ BrowserWindow, safeStorage }) => {
      const p = (BrowserWindow.getAllWindows()[0].webContents as any).getLastWebPreferences();
      return {
        sandbox: p.sandbox,
        isolated: p.contextIsolation,
        node: p.nodeIntegration,
        keychain: safeStorage.isEncryptionAvailable(),
      };
    });
    assert.deepEqual(security, { sandbox: true, isolated: true, node: false, keychain: true });
  });
  await check('Invalid password shows an error and keeps the user signed out', async () => {
    await uiLogin('alice@example.test', 'incorrect-password');
    await expect(page.locator('.error')).toContainText('Development-only-123!');
    assert.equal((await page.evaluate(() => window.harbor.status())).signedIn, false);
  });
  await check('Successful sign-in and encrypted credential persistence', async () => {
    await uiLogin();
    await expect(page.getByRole('heading', { name: 'My Drive', exact: true })).toBeVisible();
    const cred = await readFile(path.join(profile, 'credentials.bin'));
    assert(!cred.toString().includes('refreshToken'));
    assert.equal((await stat(path.join(profile, 'credentials.bin'))).mode & 0o777, 0o600);
    assert.equal((await page.evaluate(() => window.harbor.status())).signedIn, true);
  });
  await check('Create a folder through the desktop dialog', async () => {
    await page.getByRole('button', { name: 'New folder', exact: true }).click();
    await page.getByRole('dialog').getByLabel('Name', { exact: true }).fill(folderName);
    await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click();
    await expect(row(folderName)).toBeVisible();
    folder = await currentItem(folderName);
  });
  await check('Rename a folder through the desktop dialog', async () => {
    await fileAction(folderName, 'Rename');
    await page.getByRole('dialog').getByLabel('Name', { exact: true }).fill(renamedFolder);
    await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click();
    await expect(row(renamedFolder)).toBeVisible();
    folder = await currentItem(renamedFolder);
  });
  await check('Folder navigation and breadcrumbs', async () => {
    await row(renamedFolder).getByRole('button', { name: renamedFolder, exact: true }).click();
    await expect(page.locator('.file-toolbar')).toContainText(renamedFolder);
  });
  await check('Native file-picker cancellation leaves Drive unchanged', async () => {
    await openFiles([], true);
    await page.getByRole('button', { name: 'Upload files', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Upload files', exact: true })).toBeEnabled();
    assert.equal((await alice.list(folder.id)).items.length, 0);
  });
  await check('Upload multiple files: text, empty, and 11 MiB binary content', async () => {
    await openFiles([source, empty, large]);
    await page.getByRole('button', { name: 'Upload files', exact: true }).click();
    for (const file of [source, empty, large]) await expect(row(path.basename(file))).toBeVisible();
    uploaded = await currentItem(path.basename(source), folder.id);
    assert.equal((await currentItem(path.basename(large), folder.id)).sizeBytes, 11 * 1024 * 1024);
  });
  await check('Download through native save picker, verify exact content', async () => {
    const dest = path.join(dir, 'download.txt');
    await saveAs(dest);
    await row(path.basename(source))
      .getByRole('button', { name: path.basename(source), exact: true })
      .click();
    await expect
      .poll(async () => readFile(dest, 'utf8').catch(() => ''))
      .toBe(await readFile(source, 'utf8'));
  });
  await check('Download cancellation writes no file', async () => {
    const dest = path.join(dir, 'cancelled.txt');
    await saveAs(dest, true);
    const result = await page.evaluate(
      (id) => window.harbor.download({ driveItemId: id, name: 'cancelled.txt' }),
      uploaded.id,
    );
    assert.equal(result, null);
    await assert.rejects(stat(dest), { code: 'ENOENT' });
  });
  await check('Favorites displays a file marked favorite through the API', async () => {
    await alice.request(`/v1/drive/items/${uploaded.id}/favorite`, {
      method: 'PUT',
      body: { ...op(), baseRevision: uploaded.revision },
    });
    await nav('Favorites');
    await expect(row(path.basename(source))).toBeVisible();
  });
  await check('Opening a favorite folder navigates to its children', async () => {
    folder = (await alice.request(`/v1/drive/items/${folder.id}`)).item;
    await alice.request(`/v1/drive/items/${folder.id}/favorite`, {
      method: 'PUT',
      body: { ...op(), baseRevision: folder.revision },
    });
    await nav('My Drive');
    await nav('Favorites');
    await row(renamedFolder).getByRole('button', { name: renamedFolder, exact: true }).click();
    await expect(row(path.basename(empty))).toBeVisible({ timeout: 3000 });
  });
  await check('Trash a file and restore it', async () => {
    await nav('My Drive');
    await row(renamedFolder).getByRole('button', { name: renamedFolder, exact: true }).click();
    await fileAction(path.basename(empty), 'Move to trash');
    await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click();
    await nav('Trash');
    await expect(row(path.basename(empty))).toBeVisible();
    await fileAction(path.basename(empty), 'Restore');
    await expect(row(path.basename(empty))).toHaveCount(0);
    await currentItem(path.basename(empty), folder.id);
  });
  await check('Send a file to a local test recipient and cancel from Sent', async () => {
    await nav('My Drive');
    await row(renamedFolder).getByRole('button', { name: renamedFolder, exact: true }).click();
    await fileAction(path.basename(source), 'Send');
    await page.getByRole('dialog').getByLabel('To', { exact: true }).fill('@bob');
    await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click();
    await nav('Sent');
    const card = page
      .locator('.transfer-card')
      .filter({ hasText: path.basename(source) })
      .last();
    await expect(card).toContainText('PENDING');
    await card.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(card).toContainText('CANCELLED');
  });
  const incomingName = 'incoming-' + run + '.txt';
  const incoming = await uploadFile(
    bob,
    source,
    incomingName,
    null,
    { operationId: crypto.randomUUID() },
    () => {},
  );
  async function sendIncoming() {
    return (
      await bob.request('/v1/transfers', {
        method: 'POST',
        body: {
          ...op(),
          recipient: { type: 'USERNAME', value: 'alice' },
          items: [{ driveItemId: incoming.id }],
        },
      })
    ).transfer;
  }
  const incomingTransfer = await sendIncoming();
  await check('Accept a received transfer, download it, and save to Drive', async () => {
    await nav('Received');
    const card = page.locator('.transfer-card').filter({ hasText: incomingName }).last();
    await card.getByRole('button', { name: 'accept', exact: true }).click();
    await expect(card).toContainText('ACCEPTED');
    const dest = path.join(dir, 'received.txt');
    await saveAs(dest);
    await card.getByRole('button', { name: 'Download', exact: true }).click();
    await expect
      .poll(async () => readFile(dest, 'utf8').catch(() => ''))
      .toBe(await readFile(source, 'utf8'));
    await card.getByRole('button', { name: 'Save to My Drive', exact: true }).click();
    await expect(card.getByRole('button', { name: 'Saved', exact: true })).toBeDisabled();
    assert((await alice.list()).items.some((i) => i.name === incomingName));
  });
  await check('Decline a received transfer', async () => {
    const t = await sendIncoming();
    await nav('My Drive');
    await nav('Received');
    await page
      .locator('.transfer-card')
      .filter({ hasText: 'PENDING' })
      .filter({ hasText: incomingName })
      .getByRole('button', { name: 'decline', exact: true })
      .click();
    await expect
      .poll(
        async () =>
          (await alice.request('/v1/transfers/received')).items.find((i: any) => i.id === t.id)
            .state,
      )
      .toBe('DECLINED');
  });
  await check(
    'Devices lists sessions and revoking another test session blocks its access',
    async () => {
      const other = await loginApi('alice@example.test');
      await nav('Devices');
      const card = page
        .locator('.simple-row')
        .filter({ has: page.getByText(other.session.device.name, { exact: true }) });
      await card.getByRole('button', { name: 'Revoke', exact: true }).click();
      await expect(card).toContainText('Revoked');
      await assert.rejects(other.api.me(), /revoked/i);
    },
  );
  await check('Map a selected cloud folder to a local folder and reconcile its files', async () => {
    await nav('Sync');
    await openFiles([syncPath]);
    const selection = await page.evaluate(() => window.harbor.selectSyncLocal());
    assert(selection);
    await page.evaluate((input) => window.harbor.addSyncRoot(input), {
      selectionId: selection.selectionId,
      cloudFolderId: folder.id,
    });
    await nav('Devices');
    await nav('Sync');
    await expect(page.locator('.sync-folder-row')).toContainText('sync');
    syncRoot = (await page.evaluate(() => window.harbor.status())).roots.find(
      (r: any) => r.mode === 'sync',
    );
    assert(syncRoot);
    await expect
      .poll(
        async () => readFile(path.join(syncPath, path.basename(source)), 'utf8').catch(() => ''),
        { timeout: 20000 },
      )
      .toBe(await readFile(source, 'utf8'));
  });
  await check('Filesystem watcher uploads a newly created local file', async () => {
    await writeFile(path.join(syncPath, 'watcher-' + run + '.txt'), 'watcher upload');
    await expect
      .poll(
        async () =>
          (await alice.list(folder.id)).items.some((i) => i.name === 'watcher-' + run + '.txt'),
        { timeout: 20000 },
      )
      .toBe(true);
  });
  await check('Pause and resume global sync', async () => {
    await page.getByRole('button', { name: 'Pause sync', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Resume sync', exact: true })).toBeVisible();
    assert.equal((await page.evaluate(() => window.harbor.status())).sync.paused, true);
    await page.getByRole('button', { name: 'Resume sync', exact: true }).click();
    assert.equal((await page.evaluate(() => window.harbor.status())).sync.paused, false);
  });
  await check('Folder options persist pause and excluded paths', async () => {
    await page.getByRole('button', { name: 'Manage sync', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Pause folder sync', exact: true }).click();
    await page.getByRole('button', { name: 'Manage sync', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Manage exclusions', exact: true }).click();
    await page.getByRole('dialog').locator('textarea').fill('Excluded');
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Save exclusions', exact: true })
      .click();
    await expect(page.locator('.sync-folder-state')).toContainText('Paused');
    const root = (await page.evaluate(() => window.harbor.status())).roots.find(
      (r: any) => r.id === syncRoot.id,
    );
    assert.deepEqual(root.excluded, ['Excluded']);
    await page.evaluate(
      (id) => window.harbor.rootSettings({ id, paused: false, excluded: ['Excluded'] }),
      syncRoot.id,
    );
  });
  await check('Root validation rejects path traversal and overlapping sync folders', async () => {
    await assert.rejects(
      page.evaluate(
        (id) => window.harbor.rootSettings({ id, paused: false, excluded: ['../outside'] }),
        syncRoot.id,
      ),
    );
    await openFiles([syncPath]);
    await assert.rejects(
      page.evaluate(async (cloudFolderId) => {
        const selection = await window.harbor.selectSyncLocal();
        return window.harbor.addSyncRoot({ selectionId: selection!.selectionId, cloudFolderId });
      }, folder.id),
      /overlap/,
    );
  });
  await check('Choose a backup folder and upload its existing file', async () => {
    await writeFile(path.join(backupPath, 'backup-source.txt'), 'backup original');
    await nav('Backups');
    await openFiles([backupPath]);
    await page.getByRole('button', { name: 'Choose folder', exact: true }).click();
    await expect(row('backup')).toBeVisible();
    backupRoot = (await page.evaluate(() => window.harbor.status())).roots.find(
      (r: any) => r.mode === 'backup',
    );
    await expect
      .poll(
        async () =>
          (await alice.list(backupRoot.remoteId)).items.some((i) => i.name === 'backup-source.txt'),
        { timeout: 20000 },
      )
      .toBe(true);
  });
  await check('Backup cloud edits leave source files unchanged', async () => {
    const remote = await currentItem('backup-source.txt', backupRoot.remoteId);
    await alice.request(`/v1/drive/items/${remote.id}`, {
      method: 'PATCH',
      body: { ...op(), baseRevision: remote.revision, name: 'cloud-renamed.txt' },
    });
    await expect
      .poll(async () => (await page.evaluate(() => window.harbor.status())).sync.lastSync, {
        timeout: 15000,
      })
      .not.toBeNull();
    await new Promise((r) => setTimeout(r, 6000));
    assert.equal(
      await readFile(path.join(backupPath, 'backup-source.txt'), 'utf8'),
      'backup original',
    );
    await assert.rejects(stat(path.join(backupPath, 'cloud-renamed.txt')), { code: 'ENOENT' });
  });
  await check('Open backup folder calls the OS with the configured path', async () => {
    await app.evaluate(({ shell }) => {
      shell.openPath = async (p) => {
        (globalThis as any).__revealed = p;
        return '';
      };
    });
    await row('backup').getByRole('button', { name: 'Open', exact: true }).click();
    await expect.poll(() => app.evaluate(() => (globalThis as any).__revealed)).toBe(backupPath);
  });
  await check(
    'Export diagnostics contains sync information without tokens or full paths',
    async () => {
      await nav('Settings');
      const dest = path.join(dir, 'diagnostics.json');
      await saveAs(dest);
      await page.getByRole('button', { name: 'Export diagnostics', exact: true }).click();
      await expect
        .poll(async () =>
          stat(dest)
            .then((s) => s.size)
            .catch(() => 0),
        )
        .toBeGreaterThan(0);
      const raw = await readFile(dest, 'utf8');
      const data = JSON.parse(raw);
      assert.equal(data.platform, 'darwin');
      assert.equal(data.roots.length, 2);
      assert(!/accessToken|refreshToken|localPath/.test(raw));
      assert(!raw.includes(dir));
      await writeFile(path.join(evidence, 'diagnostics.json'), raw);
    },
  );
  await check(
    'Renderer API boundary rejects external URLs, traversal, and auth endpoints',
    async () => {
      for (const p of ['https://example.com', '/v1/drive/../auth/session', '/v1/auth/session'])
        await assert.rejects(page.evaluate((path) => window.harbor.request({ path }), p));
      assert.equal(await page.evaluate(() => typeof (window as any).require), 'undefined');
    },
  );
  await check('Closing the window keeps background app alive; activation reopens it', async () => {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    assert.equal(
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()),
      false,
    );
    await app.evaluate(({ app }) => app.emit('activate'));
    assert.equal(
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()),
      true,
    );
  });
  await check('Restart restores the session, roots, and global pause state', async () => {
    await page.evaluate(() => window.harbor.pause({ paused: true }));
    await app.close();
    await launch();
    await expect(page.locator('nav')).toBeVisible();
    const s = await page.evaluate(() => window.harbor.status());
    assert.equal(s.signedIn, true);
    assert.equal(s.roots.length, 2);
    assert.equal(s.sync.paused, true);
    await page.screenshot({ path: path.join(evidence, 'signed-in.png') });
  });
  await check('Sign out removes saved credentials and returns to login', async () => {
    await nav('Settings');
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Sign in to harbor0' })).toBeVisible();
    await assert.rejects(stat(path.join(profile, 'credentials.bin')), { code: 'ENOENT' });
  });
  await check('Another account gets a separate local sync profile', async () => {
    await uiLogin('bob@example.test');
    await expect(page.locator('nav')).toBeVisible();
    const status = await page.evaluate(() => window.harbor.status());
    assert.equal(status.signedIn, true);
    assert.equal(status.roots.length, 0);
    assert.equal(status.jobs.length, 0);
  });
  await check(
    'No uncaught renderer or main-process errors during functional workflows',
    async () => {
      assert.deepEqual(errors, []);
    },
  );
  // Prevent this fixture from silently becoming unused as scenarios evolve.
  assert(incomingTransfer.id);
} finally {
  await app?.close().catch(() => {});
  await rm(dir, { recursive: true, force: true });
  await writeFile(
    path.join(evidence, 'results.json'),
    JSON.stringify({ results, errors }, null, 2),
  );
}
console.log(
  JSON.stringify({
    passed: results.filter((r) => r.status === 'PASS').length,
    failed: results.filter((r) => r.status === 'FAIL').length,
  }),
);
if (results.some((r) => r.status === 'FAIL')) process.exitCode = 1;
