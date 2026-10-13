import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ApiClient, createTransport } from '@harbor/api-client';
import type { DriveItem } from '@harbor/contracts';
import {
  FileCipher,
  HEADER_SIZE,
  accountKeys,
  decryptName,
  encryptName,
  encryptedSize,
  isEncryptedName,
  newMasterKey,
  plainSize,
  wrapWithPassphrase,
  wrapWithRecovery,
  type AccountKeys,
} from '../packages/api-client/src/e2ee';
import { DynamoRepository, transact } from '../apps/backend/src/repository';
import { userPK } from '../apps/backend/src/domain';
import { FLAG_PK, emptyFlag } from '../apps/backend/src/flags';
import { uploadFile } from '../apps/desktop/src/transfers';

// End-to-end encryption in the desktop app, against a local API: while an encrypted account is
// locked, sync and backups wait without uploading, downloading or deleting anything; once it is
// unlocked with the passphrase, new files go up encrypted (names and content), files encrypted
// on the web come down decrypted, a file the web app re-encrypts keeps its local copy, and the
// key survives a restart until signing out removes this computer's copy. Backups saved before
// encryption are re-encrypted by the app, and turning encryption off decrypts them again, so
// turning off can finish; the run ends with the account unencrypted and nothing encrypted left.
// Needs a local API with its own table (see the api-e2ee-mac launch entry) and a built desktop.
// A run that stops part way can leave encrypted files behind, which keeps the next run from
// finishing turning off: recreate the table (`TABLE_NAME=harbor-e2ee-mac npm run local:setup`
// after deleting it) and restart the API.
const base = process.env.HARBOR_TEST_API ?? 'http://127.0.0.1:8847';
const table = process.env.HARBOR_TEST_TABLE ?? 'harbor-e2ee-mac';
const run = Date.now().toString();
const dir = await mkdtemp(path.join(os.tmpdir(), 'harbor-e2ee-desktop-'));
const evidence = path.resolve('test-results/desktop-e2ee');
await mkdir(evidence, { recursive: true });
const results: { name: string; status: string; detail?: string }[] = [];
const appErrors: string[] = [];
let app!: ElectronApplication;
let page!: Page;
let shot = 0;
const screenshot = (name: string) =>
  page.screenshot({ path: path.join(evidence, `${String(++shot).padStart(2, '0')}-${name}.png`) });
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    results.push({ name, status: 'PASS' });
    console.log('PASS ' + name);
  } catch (e) {
    const detail = (e as Error).message;
    results.push({ name, status: 'FAIL', detail });
    console.log('FAIL ' + name + ': ' + detail.slice(0, 400));
    await screenshot('failure').catch(() => {});
  }
  await writeFile(
    path.join(evidence, 'results.json'),
    JSON.stringify({ results, appErrors }, null, 2),
  );
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(what: string, fn: () => Promise<T>, timeout = 30_000) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await fn().catch(() => undefined);
    if (value) return value;
    if (Date.now() > end) throw new Error('Timed out waiting for ' + what);
    await sleep(500);
  }
}

/**
 * Turns the e2ee flag on for alice and her encryption off, straight in the test table, so each
 * run enrolls afresh. Files earlier runs encrypted stay in their own folders.
 */
async function resetEncryption() {
  await transact(new DynamoRepository(table, 'http://127.0.0.1:8100'), async (tx) => {
    await tx.put(FLAG_PK, 'e2ee', { ...emptyFlag('e2ee'), mode: 'TARGETED', userIds: ['alice'] });
    await tx.delete(userPK('alice'), 'E2EE');
    for (const d of await tx.list<{ id: string }>(userPK('alice'), 'E2EE_DEVICE#'))
      await tx.delete(userPK('alice'), `E2EE_DEVICE#${d.id}`);
    const profile = await tx.get<Record<string, unknown>>(userPK('alice'), 'PROFILE');
    if (profile?.e2ee) {
      delete profile.e2ee;
      await tx.put(userPK('alice'), 'PROFILE', profile);
    }
  });
}
await resetEncryption();
const login = await fetch(base + '/v1/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    email: 'alice@example.test',
    password: 'Development-only-123!',
    deviceName: 'E2EE web ' + run,
    platform: 'WEB',
  }),
}).then((r) => r.json() as Promise<any>);
/** The account as the server stores it: encrypted names and bytes stay as they are. */
const raw = new ApiClient(createTransport(base, async () => login.accessToken));
const op = () => ({ operationId: randomUUID() });
const rawItems = async (parentId: string) => (await raw.list(parentId)).items as DriveItem[];
const passphrase = 'correct horse battery staple ' + run;
let keys: AccountKeys | undefined;
const plainName = (name: string) =>
  isEncryptedName(name) && keys ? decryptName(keys, name) : Promise.resolve(name);
/** Plaintext names in a folder, decrypting the encrypted ones. */
const names = async (parentId: string) =>
  Promise.all((await rawItems(parentId)).map((i) => plainName(i.name)));
async function itemNamed(parentId: string, name: string) {
  for (const item of await rawItems(parentId))
    if ((await plainName(item.name)) === name) return item;
  return undefined;
}
/** Downloads a stored file and decrypts it, as the web app would. */
async function readStored(item: DriveItem) {
  const link = await raw.download({ driveItemId: item.id });
  const stored = new Uint8Array(await (await fetch(link.downloadUrl)).arrayBuffer());
  if (!item.encrypted) return Buffer.from(stored).toString('utf8');
  const cipher = await FileCipher.open(keys!, stored.subarray(0, HEADER_SIZE));
  const size = plainSize(stored.length);
  const range = cipher.cipherRange(size, 0, size);
  const plain = await cipher.decryptRange(size, 0, size, stored.subarray(range.start, range.end));
  return Buffer.from(plain).toString('utf8');
}
/** Uploads text or bytes encrypted, the way the web app does on an encrypted account. */
async function put(
  content: string | Uint8Array,
  name: string,
  parentId: string,
  replace?: Pick<DriveItem, 'id' | 'revision'>,
) {
  const plain = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  const cipher = await FileCipher.create(keys!);
  const stored = await cipher.encryptedRange(
    plain.length,
    0,
    encryptedSize(plain.length),
    async (b, e) => plain.subarray(b, e),
  );
  const { upload } = await raw.createUpload({
    ...op(),
    parentId,
    name: await encryptName(keys!, name),
    sizeBytes: stored.length,
    mimeType: 'application/octet-stream',
    encrypted: true,
    ...(replace ? { driveItemId: replace.id, baseRevision: replace.revision } : {}),
  } as any);
  const { parts } = await raw.parts(upload.id, [1]);
  const response = await fetch(parts[0].uploadUrl, { method: 'PUT', body: stored });
  assert(response.ok, 'Storage refused the part: ' + response.status);
  return (
    await raw.request(`/v1/uploads/${upload.id}/complete`, {
      method: 'POST',
      body: {
        parts: [{ partNumber: 1, etag: response.headers.get('etag') }],
        contentHash: createHash('sha256').update(stored).digest('hex'),
      },
    })
  ).item as DriveItem;
}

async function launch(profile: string) {
  app = await electron.launch({
    args: ['apps/desktop', `--user-data-dir=${profile}`],
    env: { ...process.env, HARBOR_DEV_AUTH: 'true', HARBOR_API_URL: base },
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(15_000);
  page.on('pageerror', (e) => appErrors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') appErrors.push('console: ' + m.text());
  });
}
async function openFolder(folder: string) {
  await app.evaluate(
    ({ dialog }, filePaths) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths })) as any;
    },
    [folder],
  );
}
const status = () => page.evaluate(() => (window as any).harbor.status());
const unlockHeading = () => page.getByRole('heading', { name: 'Unlock your encrypted files' });
const localNames = async (folder: string) =>
  (await readdir(folder)).filter((n) => !n.startsWith('.')).sort();

const profile = path.join(dir, 'profile');
const syncPath = path.join(dir, 'Desktop sync');
const backupPath = path.join(dir, 'Desktop backup');
await mkdir(syncPath);
await mkdir(backupPath);
const { item: cloud } = await raw.createFolder('Desktop sync ' + run);
const before = path.join(dir, 'cloud-before.txt');
await writeFile(before, 'Made on the web before encryption.');
await uploadFile(raw, before, 'cloud-before.txt', cloud.id, op(), () => {});
let backup: any;
try {
  await launch(profile);
  await check('Baseline: sign in to the desktop app', async () => {
    await page.getByLabel('Email', { exact: true }).fill('alice@example.test');
    await page.getByLabel('Password', { exact: true }).fill('Development-only-123!');
    await page.getByRole('button', { name: 'Sign in to local development' }).click();
    await until('sign-in', async () => (await status()).signedIn);
  });
  await check('Baseline: sync and backup work before encryption', async () => {
    await openFolder(syncPath);
    const selection = await page.evaluate(() => (window as any).harbor.selectSyncLocal());
    await page.evaluate((input) => (window as any).harbor.addSyncRoot(input), {
      selectionId: selection.selectionId,
      cloudFolderId: cloud.id,
    });
    await until('cloud-before.txt locally', () =>
      readFile(path.join(syncPath, 'cloud-before.txt'), 'utf8'),
    );
    await writeFile(path.join(syncPath, 'local-before.txt'), 'Made on this computer before.');
    await until('local-before.txt in the cloud', async () =>
      (await names(cloud.id)).includes('local-before.txt'),
    );
    await writeFile(path.join(backupPath, 'backup-before.txt'), 'Backed up before encryption.');
    await openFolder(backupPath);
    await page.evaluate(() => (window as any).harbor.chooseRoot({ mode: 'backup' }));
    backup = (await status()).roots.find((r: any) => r.mode === 'backup');
    // A new backup otherwise waits for the next server check, up to five minutes.
    await page.evaluate((id) => (window as any).harbor.backupNow({ id }), backup.id);
    await until(
      'backup-before.txt in the cloud',
      async () => (await names(backup.remoteId)).includes('backup-before.txt'),
      45_000,
    );
  });

  await check('Turn on end-to-end encryption from the web', async () => {
    const master = newMasterKey();
    const next = await accountKeys(master);
    const response = await raw.request('/v1/e2ee/enroll', {
      method: 'POST',
      body: {
        // The lowest cost the server accepts, to keep the test quick.
        passphrase: await wrapWithPassphrase(master, passphrase, {
          memoryKiB: 19_456,
          iterations: 2,
          parallelism: 1,
        }),
        recovery: await wrapWithRecovery(master, new Uint8Array(20).fill(7)),
        proof: next.proof,
      },
    });
    assert(response.e2ee.enabled);
    keys = next;
  });
  await check('Locked: the app asks for the passphrase and sync waits', async () => {
    await writeFile(path.join(syncPath, 'local-locked.txt'), 'Made while locked.');
    await page.getByRole('button', { name: 'My Drive', exact: true }).first().click();
    await unlockHeading().waitFor({ timeout: 60_000 });
    await page.getByText('Locked · unlock to sync').waitFor();
    await sleep(8_000);
    assert(!(await names(cloud.id)).includes('local-locked.txt'), 'Uploaded while locked');
    assert.deepEqual(await localNames(syncPath), [
      'cloud-before.txt',
      'local-before.txt',
      'local-locked.txt',
    ]);
    await screenshot('locked');
  });
  await check('A wrong passphrase is refused', async () => {
    await page.getByLabel('Passphrase', { exact: true }).fill('not the passphrase at all');
    await page.getByRole('button', { name: 'Unlock', exact: true }).click();
    await page.getByText('That passphrase isn’t right').waitFor();
  });
  await check('Unlock with the passphrase', async () => {
    await page.getByLabel('Passphrase', { exact: true }).fill(passphrase);
    await page.getByRole('button', { name: 'Unlock', exact: true }).click();
    await until('unlocked', async () => (await status()).e2ee?.locked === false, 30_000);
    await unlockHeading().waitFor({ state: 'detached' });
  });
  await check('Sync uploads new files encrypted, name and content', async () => {
    await writeFile(path.join(syncPath, 'local-after.txt'), 'Made on this computer after.');
    for (const name of ['local-locked.txt', 'local-after.txt']) {
      const item = await until(name + ' in the cloud', () => itemNamed(cloud.id, name), 60_000);
      assert(isEncryptedName(item.name), name + ' was stored with a plain name');
      assert(item.encrypted, name + ' was stored unencrypted');
    }
    const stored = (await itemNamed(cloud.id, 'local-after.txt'))!;
    assert.equal(await readStored(stored), 'Made on this computer after.');
  });
  await check('Sync downloads a file encrypted on the web, decrypted', async () => {
    await put('Made on the web while encrypted.', 'cloud-after.txt', cloud.id);
    assert.equal(
      await until(
        'cloud-after.txt locally',
        () => readFile(path.join(syncPath, 'cloud-after.txt'), 'utf8'),
        60_000,
      ),
      'Made on the web while encrypted.',
    );
    assert(!(await localNames(syncPath)).some((n) => n.startsWith('h0e1.')));
  });
  await check('A file the web app re-encrypts keeps its local copy', async () => {
    // What the web app's migration does to a file stored before encryption.
    const item = (await itemNamed(cloud.id, 'cloud-before.txt'))!;
    const done = await put(
      'Made on the web before encryption.',
      'cloud-before.txt',
      cloud.id,
      item,
    );
    await raw.request(`/v1/drive/items/${item.id}`, {
      method: 'PATCH',
      body: {
        ...op(),
        baseRevision: done.revision,
        name: await encryptName(keys!, 'cloud-before.txt'),
      },
    });
    await raw.request(`/v1/e2ee/items/${item.id}/purge-plaintext`, { method: 'POST' });
    await sleep(15_000);
    assert.equal(
      await readFile(path.join(syncPath, 'cloud-before.txt'), 'utf8'),
      'Made on the web before encryption.',
    );
    assert(!(await localNames(syncPath)).some((n) => n.startsWith('h0e1.')));
  });
  await check('Backups upload new files encrypted', async () => {
    await writeFile(path.join(backupPath, 'backup-after.txt'), 'Backed up after encryption.');
    await page.evaluate((id) => (window as any).harbor.backupNow({ id }), backup.id);
    const item = await until(
      'backup-after.txt in the cloud',
      () => itemNamed(backup.remoteId, 'backup-after.txt'),
      60_000,
    );
    assert(isEncryptedName(item.name) && item.encrypted, 'Backed up unencrypted');
    assert.equal(await readStored(item), 'Backed up after encryption.');
  });
  await check('Backups saved before encryption are re-encrypted', async () => {
    const item = await until(
      'backup-before.txt re-encrypted',
      async () => {
        const found = await itemNamed(backup.remoteId, 'backup-before.txt');
        return found?.encrypted && isEncryptedName(found.name) ? found : undefined;
      },
      120_000,
    );
    assert.equal(await readStored(item), 'Backed up before encryption.');
    const { items: versions } = await raw.request(`/v1/drive/items/${item.id}/versions`);
    assert(
      versions.every((v: { encrypted?: boolean }) => v.encrypted),
      'A plaintext version was kept',
    );
  });
  await check('The app shows decrypted names and previews', async () => {
    const item = (await itemNamed(cloud.id, 'cloud-after.txt'))!;
    const preview = await page.evaluate(
      (id) => (window as any).harbor.previewText({ driveItemId: id }),
      item.id,
    );
    assert.equal(preview.text, 'Made on the web while encrypted.');
    const listed = await page.evaluate(
      (id) => (window as any).harbor.request({ path: `/v1/drive/folders/${id}/children` }),
      cloud.id,
    );
    assert(listed.items.some((i: DriveItem) => i.name === 'cloud-after.txt'));
    assert(!JSON.stringify(listed).includes('"h0e1.'));
    await screenshot('unlocked');
  });
  await check('The app previews encrypted images and videos', async () => {
    // Shown from the decrypted bytes: the download link is to ciphertext. A synced folder is
    // listed under Synced Folders, so these go in a folder of their own in My Drive.
    const { item: media } = await raw.createFolder(await encryptName(keys!, 'Previews ' + run));
    const photo = await put(
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
        'base64',
      ),
      'photo.png',
      media.id,
    );
    const clip = await put(await readFile('tests/fixtures/preview.webm'), 'clip.webm', media.id);
    await page.getByRole('button', { name: 'My Drive', exact: true }).first().click();
    await page
      .getByText('Previews ' + run, { exact: true })
      .locator('visible=true')
      .first()
      .dblclick();
    const body = page.locator('.file-preview-body');
    await page.getByText('photo.png', { exact: true }).locator('visible=true').first().dblclick();
    const image = body.locator('img');
    await until('the image preview', () =>
      image.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0),
    );
    assert((await image.getAttribute('src'))!.startsWith('blob:'), 'Not shown decrypted');
    await screenshot('image-preview');
    await page.keyboard.press('Escape');
    await page.getByText('clip.webm', { exact: true }).locator('visible=true').first().dblclick();
    await until('the video preview', () =>
      body.locator('video').evaluate((el: HTMLVideoElement) => el.readyState > 0),
    );
    await screenshot('video-preview');
    await page.keyboard.press('Escape');
    // Nothing encrypted may be left behind, or turning encryption off below can't finish.
    for (const item of [photo, clip, media]) {
      const { item: trashed } = await raw.request(`/v1/drive/items/${item.id}`, {
        method: 'DELETE',
        body: { ...op(), baseRevision: item.revision },
      });
      await raw.request(`/v1/drive/items/${item.id}/permanent`, {
        method: 'DELETE',
        body: { ...op(), baseRevision: trashed.revision },
      });
    }
  });
  await check('No sync problems are left', async () => {
    const s = await until(
      'a quiet sync',
      async () => {
        const current = await status();
        await writeFile(path.join(evidence, 'status-quiet.json'), JSON.stringify(current, null, 2));
        // A backup file seen again waits out the quiet hour; that isn't a problem.
        const syncRoot = current.roots.find((r: any) => r.mode === 'sync');
        const waiting = current.jobs.filter((j: any) => j.rootId === syncRoot.id || j.error);
        return !waiting.length && !current.sync.running ? current : undefined;
      },
      60_000,
    );
    assert.deepEqual(s.sync.issues, [], JSON.stringify(s.sync.issues));
  });
  await check('Restarting unlocks with this computer’s saved key', async () => {
    await app.close();
    await launch(profile);
    await until('signed in', async () => (await status()).signedIn, 30_000);
    await until('unlocked', async () => (await status()).e2ee?.locked === false, 30_000);
    await writeFile(path.join(syncPath, 'after-restart.txt'), 'Made after a restart.');
    const item = await until(
      'after-restart.txt in the cloud',
      () => itemNamed(cloud.id, 'after-restart.txt'),
      60_000,
    );
    assert(item.encrypted);
    await screenshot('relaunched');
  });
  await check('Settings shows the encryption details', async () => {
    await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
    const card = page.locator('.panel').filter({ hasText: 'End-to-end encryption' });
    await card.getByText('Unlocked', { exact: true }).waitFor();
    await card.getByText('This computer', { exact: true }).last().waitFor();
    await card.getByRole('button', { name: 'Lock this computer' }).waitFor();
    await card.scrollIntoViewIfNeeded();
    await screenshot('settings');
  });
  await check('Signing out removes this computer’s copy of the key', async () => {
    const before = (await raw.request('/v1/e2ee')).e2ee.devices.length;
    await page.evaluate(() => (window as any).harbor.logout());
    await until(
      'device copy removed',
      async () => (await raw.request('/v1/e2ee')).e2ee.devices.length === before - 1,
    );
  });
  await check('Signing in again asks for the passphrase', async () => {
    await page.getByLabel('Email', { exact: true }).fill('alice@example.test');
    await page.getByLabel('Password', { exact: true }).fill('Development-only-123!');
    await page.getByRole('button', { name: 'Sign in to local development' }).click();
    await until('signed in', async () => (await status()).signedIn, 30_000);
    await unlockHeading().waitFor({ timeout: 30_000 });
    await page.getByLabel('Passphrase', { exact: true }).fill(passphrase);
    await page.getByRole('button', { name: 'Unlock', exact: true }).click();
    await until('unlocked', async () => (await status()).e2ee?.locked === false, 30_000);
  });
  await check('Turning off: the app decrypts its backups', async () => {
    await raw.request('/v1/e2ee/disable', { method: 'POST', body: { proof: keys!.proof } });
    for (const name of ['backup-before.txt', 'backup-after.txt']) {
      const item = await until(
        name + ' decrypted',
        async () => {
          const found = await itemNamed(backup.remoteId, name);
          return found && !found.encrypted && !isEncryptedName(found.name) ? found : undefined;
        },
        180_000,
      );
      const { items: versions } = await raw.request(`/v1/drive/items/${item.id}/versions`);
      assert(
        !versions.some((v: { encrypted?: boolean }) => v.encrypted),
        name + ' kept ciphertext',
      );
    }
    assert.equal(
      await readStored((await itemNamed(backup.remoteId, 'backup-after.txt'))!),
      'Backed up after encryption.',
    );
  });
  await check('Turning off finishes once the web app decrypts the rest', async () => {
    // What the web app does to every other file as encryption is turned off.
    for (const item of await rawItems(cloud.id)) {
      let current = item;
      if (item.encrypted) {
        const plain = new TextEncoder().encode(await readStored(item));
        const { upload } = await raw.createUpload({
          ...op(),
          parentId: cloud.id,
          name: 'ignored',
          sizeBytes: plain.length,
          mimeType: 'application/octet-stream',
          driveItemId: item.id,
          baseRevision: item.revision,
        } as any);
        const { parts } = await raw.parts(upload.id, [1]);
        const response = await fetch(parts[0].uploadUrl, { method: 'PUT', body: plain });
        current = (
          await raw.request(`/v1/uploads/${upload.id}/complete`, {
            method: 'POST',
            body: {
              parts: [{ partNumber: 1, etag: response.headers.get('etag') }],
              contentHash: createHash('sha256').update(plain).digest('hex'),
            },
          })
        ).item;
        await raw.request(`/v1/e2ee/items/${item.id}/purge-encrypted`, { method: 'POST' });
      }
      if (isEncryptedName(item.name))
        await raw.request(`/v1/drive/items/${item.id}`, {
          method: 'PATCH',
          body: { ...op(), baseRevision: current.revision, name: await plainName(item.name) },
        });
    }
    const off = await raw.request('/v1/e2ee/disable/finish', {
      method: 'POST',
      body: { proof: keys!.proof },
    });
    assert.equal(off.e2ee.enabled, false);
    keys = undefined;
  });
  await check('After turning off, new files go up unencrypted', async () => {
    await until('the app to notice', async () => (await status()).e2ee === null, 120_000);
    await writeFile(path.join(syncPath, 'after-off.txt'), 'Made after turning off.');
    const item = await until(
      'after-off.txt in the cloud',
      async () => (await rawItems(cloud.id)).find((i) => i.name === 'after-off.txt'),
      60_000,
    );
    assert(!item.encrypted);
    assert.equal(
      await readFile(path.join(syncPath, 'cloud-after.txt'), 'utf8'),
      'Made on the web while encrypted.',
    );
    assert(!(await localNames(syncPath)).some((n) => n.startsWith('h0e1.')));
  });
} finally {
  await app?.close().catch(() => {});
  await resetEncryption().catch(() => {});
  const failed = results.filter((r) => r.status === 'FAIL').length;
  console.log(`\n${results.length - failed}/${results.length} passed. Evidence: ${evidence}`);
  if (appErrors.length) console.log('App errors:\n' + appErrors.slice(0, 20).join('\n'));
  process.exitCode = failed ? 1 : 0;
}
