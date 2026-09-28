import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import {
  ZipWriter,
  Uint8ArrayWriter,
  TextReader,
  ZipReader,
  Uint8ArrayReader,
  TextWriter,
} from '@zip.js/zip.js';
const folder = {
  id: 'folder',
  name: 'Project 🌍',
  type: 'FOLDER',
  ownerUserId: 'demo',
  revision: 1,
  updatedAt: '2026-09-26T00:00:00Z',
  createdAt: '2026-09-26T00:00:00Z',
  sizeBytes: 5,
};
async function fixtures(page: Page) {
  const state = {
    ready: false,
    failed: false,
    deletes: 0,
    creates: 0,
    downloads: 0,
    forbidden: [] as string[],
  };
  const zip = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false, level: 0 });
  await zip.add('Project 🌍/Empty/', undefined, { directory: true });
  await zip.add('Project 🌍/Nested/notes.txt', new TextReader('Hello'));
  const bytes = await zip.close();
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/users/me'))
      return route.fulfill({
        json: {
          user: {
            id: 'demo',
            displayName: 'ZIP test',
            username: 'ziptest',
            email: 'zip@example.test',
          },
          storage: { usedBytes: 5, quotaBytes: 100000000000, reservedBytes: 0 },
        },
      });
    if (path.includes('/folder-downloads')) {
      if (route.request().method() === 'DELETE') {
        state.deletes++;
        return route.fulfill({ json: { cancelled: true } });
      }
      if (route.request().method() === 'POST') {
        state.creates++;
        expect(route.request().postDataJSON()).toMatchObject({
          driveItemId: 'folder',
          operationId: expect.any(String),
        });
      }
      return route.fulfill({
        json: {
          id: 'job',
          name: folder.name + '.zip',
          state: state.failed ? 'FAILED' : state.ready ? 'READY' : 'BUILDING',
          files: 0,
          bytes: 2,
          totalFiles: 1,
          totalBytes: 5,
          currentFile: 'Project 🌍/Nested/notes.txt',
          error: state.failed ? 'ZIP preparation failed. Please try again.' : null,
          ...(state.ready
            ? { downloadUrl: 'http://127.0.0.1:9100/archive.zip', sizeBytes: bytes.length }
            : {}),
        },
      });
    }
    if (path.endsWith('/downloads') || /folders\/folder\/children/.test(path))
      state.forbidden.push(path);
    return route.fulfill({
      json: { items: path.includes('/folders/root/children') ? [folder] : [], nextCursor: null },
    });
  });
  await page.route('http://127.0.0.1:9100/archive.zip', async (route) => {
    state.downloads++;
    await route.fulfill({
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': "attachment; filename*=UTF-8''Project%20%F0%9F%8C%8D.zip",
      },
      body: Buffer.from(bytes),
    });
  });
  await page.addInitScript(() => {
    (window as any).showSaveFilePicker = () => {
      throw new Error('ZIPs must not be assembled in the browser');
    };
    URL.createObjectURL = () => {
      throw new Error('ZIPs must not use a browser Blob');
    };
  });
  await page.goto('/drive');
  await expect(
    page.getByRole('button', { name: `Actions for ${folder.name}`, exact: true }),
  ).toBeVisible();
  return state;
}
async function start(page: Page) {
  await page.getByRole('button', { name: `Actions for ${folder.name}`, exact: true }).click();
  await page.getByRole('menuitem', { name: 'Download as ZIP', exact: true }).click();
}
test('shows overall preparation then downloads exactly one server-built ZIP', async ({
  page,
}, testInfo) => {
  const state = await fixtures(page);
  await start(page);
  await expect(page.getByRole('status', { name: 'ZIP download status' })).toContainText(
    'Preparing ZIP · 40%',
  );
  await expect(page.getByRole('progressbar', { name: 'ZIP progress' })).toHaveAttribute(
    'aria-valuenow',
    '40',
  );
  await page.screenshot({ path: testInfo.outputPath('zip-preparation.png') });
  const pending = page.waitForEvent('download');
  state.ready = true;
  const download = await pending;
  expect(download.suggestedFilename()).toBe('Project 🌍.zip');
  await download.saveAs(testInfo.outputPath('Project.zip'));
  const reader = new ZipReader(
    new Uint8ArrayReader(await readFile(testInfo.outputPath('Project.zip'))),
    { useWebWorkers: false },
  );
  const entries = await reader.getEntries();
  const notes = entries.find((e) => e.filename.endsWith('notes.txt'))!;
  expect(!notes.directory && (await notes.getData(new TextWriter()))).toBe('Hello');
  expect(entries.some((e) => e.directory && e.filename.endsWith('Empty/'))).toBe(true);
  await reader.close();
  expect(state.downloads).toBe(1);
  expect(state.forbidden).toEqual([]);
  await expect(page.getByRole('status').filter({ hasText: 'download started' })).toBeVisible();
});
test('cancels server preparation and allows another download', async ({ page }) => {
  const state = await fixtures(page);
  await start(page);
  await page
    .getByRole('status', { name: 'ZIP download status' })
    .getByRole('button', { name: 'Cancel' })
    .click();
  await expect.poll(() => state.deletes).toBe(1);
  await expect(page.getByRole('status', { name: 'ZIP download status' })).toBeHidden();
  expect(state.downloads).toBe(0);
  await start(page);
  await expect.poll(() => state.creates).toBe(2);
  const download = page.waitForEvent('download');
  state.ready = true;
  await download;
  expect(state.downloads).toBe(1);
});
test('shows a preparation error and restores the folder action', async ({ page }) => {
  const state = await fixtures(page);
  state.failed = true;
  await start(page);
  await expect(page.getByRole('alert').filter({ hasText: 'ZIP preparation failed' })).toBeVisible();
  expect(state.downloads).toBe(0);
  await expect(page.getByRole('status', { name: 'ZIP download status' })).toBeHidden();
});
test('keeps ZIP preparation visible across workspace navigation', async ({ page }) => {
  const state = await fixtures(page);
  await start(page);
  await expect(page.getByRole('status', { name: 'ZIP download status' })).toBeVisible();
  await page.getByRole('link', { name: 'Storage', exact: true }).click();
  await expect(page).toHaveURL(/\/storage/);
  await expect(page.getByRole('status', { name: 'ZIP download status' })).toContainText('40%');
  const download = page.waitForEvent('download');
  state.ready = true;
  await download;
  expect(state.downloads).toBe(1);
});
