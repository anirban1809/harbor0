import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// Requires the local development API. Drives the real desktop app through archiving a
// backup folder and restoring it; only the native folder picker is automated.
const base = process.env.HARBOR_TEST_API ?? 'http://127.0.0.1:8787';
const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'harbor-archive-')));
const evidence = path.resolve('test-results/desktop-archive');
await mkdir(evidence, { recursive: true });
const name = `Archive QA ${Date.now()}`;
const source = path.join(dir, name);
await mkdir(path.join(source, 'sub'), { recursive: true });
await writeFile(path.join(source, 'a.txt'), 'first file');
await writeFile(path.join(source, 'sub', 'b.txt'), 'nested file');
await writeFile(path.join(source, 'sub', '.DS_Store'), 'finder');
const exists = (relative: string) =>
  readFile(path.join(source, relative)).then(
    () => true,
    () => false,
  );
const app = await electron.launch({
  args: ['apps/desktop', `--user-data-dir=${path.join(dir, 'profile')}`],
  env: { ...process.env, HARBOR_DEV_AUTH: 'true', HARBOR_API_URL: base },
});
const page = await app.firstWindow();
page.setDefaultTimeout(15000);
const shot = (file: string) => page.screenshot({ path: path.join(evidence, file) });
const status = async () =>
  (await page.evaluate(() => window.harbor.status())).roots.find((r: any) => r.mode === 'backup');
try {
  await page.getByLabel('Email', { exact: true }).fill('alice@example.test');
  await page.getByLabel('Password', { exact: true }).fill('Development-only-123!');
  await page.getByRole('button', { name: 'Sign in to local development' }).click();
  await page.locator('nav').getByRole('button', { name: 'Backups', exact: true }).click();
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [folder] })) as any;
  }, source);
  await page.getByRole('button', { name: 'Add folder', exact: true }).first().click();
  await expect.poll(async () => (await status())?.localPath).toBe(source);
  // Backups opens on the list of folders; open the new one.
  await page.locator('.backup-folder-row').filter({ hasText: name }).click();
  const summary = page.locator('.backup-summary');
  await expect(summary.getByRole('heading', { name })).toBeVisible();
  await shot('1-before.png');

  await summary.getByRole('button', { name: 'Archive', exact: true }).click();
  await shot('2-confirm.png');
  await page.getByRole('button', { name: 'Archive and remove local copy' }).click();
  await expect.poll(async () => (await status())?.archive, { timeout: 60000 }).toBe('archived');
  assert.equal(await exists('a.txt'), false, 'a.txt should be removed locally');
  assert.equal(await exists('sub/b.txt'), false, 'sub/b.txt should be removed locally');
  console.log('local folder after archive:', await readdir(source).catch(() => 'removed'));
  await expect(summary.locator('.backup-badge')).toHaveText('Archived', { timeout: 30000 });
  await expect(page.getByText('a.txt', { exact: true })).toBeVisible();
  await page.getByText('a.txt', { exact: true }).click();
  await expect(
    page.getByRole('button', { name: /^Download this version of a\.txt/ }),
  ).toBeVisible();
  assert.equal(await page.getByRole('button', { name: 'Restore', exact: true }).count(), 0);
  await shot('3-archived.png');
  await page.getByRole('button', { name: 'Close file details' }).click();

  await summary.getByRole('button', { name: 'Restore folder' }).click();
  await expect.poll(async () => (await status())?.archive ?? null, { timeout: 60000 }).toBe(null);
  assert.equal(await readFile(path.join(source, 'a.txt'), 'utf8'), 'first file');
  assert.equal(await readFile(path.join(source, 'sub', 'b.txt'), 'utf8'), 'nested file');
  await expect(summary.locator('.backup-badge')).not.toHaveText(/Archived|Restoring/, {
    timeout: 30000,
  });
  await expect(summary.getByRole('button', { name: 'Back up now' })).toBeVisible();
  await shot('4-restored.png');

  // New edits are backed up again after the restore.
  await writeFile(path.join(source, 'c.txt'), 'added after restore');
  await summary.getByRole('button', { name: 'Back up now' }).click();
  await expect(page.getByText('c.txt', { exact: true })).toBeVisible({ timeout: 60000 });
  await shot('5-backup-resumed.png');
  console.log('PASS archive and restore');
} catch (error) {
  await shot('failure.png').catch(() => {});
  console.error('FAIL', error);
  process.exitCode = 1;
} finally {
  await app.close();
  await rm(dir, { recursive: true, force: true });
}
