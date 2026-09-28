import { chromium, _electron as electron, expect, type Page } from '@playwright/test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const output = path.resolve('test-results/backups');
await mkdir(output, { recursive: true });
function fixture() {
  const calls: any[] = [];
  const root = {
    id: 'backup1',
    deviceId: 'device1',
    localPathDisplayName: 'Documents',
    remoteRootDriveItemId: 'cloud1',
    createdAt: '2026-09-28T08:00:00Z',
  };
  const file = {
    id: 'file1',
    name: 'Project notes.md',
    parentId: 'cloud1',
    type: 'FILE',
    sizeBytes: 2400,
  };
  const restores: any[] = [];
  return (raw: string, method = 'GET', body: any = {}) => {
    calls.push({ raw, method, body });
    const p = new URL(raw, 'http://fixture').pathname;
    if (p === '/test/calls') return calls;
    if (p === '/v1/users/me')
      return {
        user: { id: 'demo', email: 'demo@example.test', username: 'demo', displayName: 'Demo' },
        storage: {
          quotaBytes: 1e11,
          usedBytes: 2400,
          availableBytes: 1e11 - 2400,
          reservedBytes: 0,
        },
      };
    if (p === '/v1/backups') return { items: [root] };
    if (p === '/v1/drive/folders/cloud1/children')
      return {
        items: [file, { id: 'nested', name: 'Research', type: 'FOLDER', parentId: 'cloud1' }],
        nextCursor: null,
      };
    if (p === '/v1/drive/folders/nested/children')
      return {
        items: [{ ...file, id: 'nested-file', name: 'Research draft.txt' }],
        nextCursor: null,
      };
    if (p.endsWith('/versions'))
      return {
        items: [
          { id: 'v2', versionNumber: 2, sizeBytes: 2400, createdAt: '2026-09-28T09:00:00Z' },
          { id: 'v1', versionNumber: 1, sizeBytes: 1200, createdAt: '2026-09-27T09:00:00Z' },
        ],
      };
    if (p.endsWith('/runs'))
      return {
        items: [
          {
            id: 'run1',
            rootId: root.id,
            deviceId: root.deviceId,
            trigger: 'AUTOMATIC',
            state: 'COMPLETED',
            startedAt: '2026-09-28T09:00:00Z',
            completedAt: '2026-09-28T09:00:30Z',
            fileCount: 1,
            sizeBytes: 2400,
          },
        ],
        nextCursor: null,
      };
    if (p.endsWith('/files'))
      return {
        items: [
          {
            relativePath: file.name,
            itemId: file.id,
            versionId: 'v2',
            sizeBytes: 2400,
            modifiedAt: '2026-09-28T08:00:00Z',
            savedAt: '2026-09-28T09:00:00Z',
          },
        ],
        nextCursor: null,
      };
    if (p.endsWith('/restores')) {
      if (method === 'POST') {
        const restore = {
          ...body,
          rootId: root.id,
          relativePath: file.name,
          state: 'PENDING',
          requestedAt: '2026-09-28T10:00:00Z',
        };
        restores.push(restore);
        return { restore };
      }
      return { items: restores, nextCursor: null };
    }
    if (p === '/v1/downloads')
      return { downloadUrl: 'https://download.example.test/notes', sizeBytes: 1200 };
    return { items: [], nextCursor: null };
  };
}
async function check(page: Page, desktop: boolean) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  if (desktop)
    await page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('button', { name: 'Backups', exact: true })
      .click();
  await expect(page.getByRole('tab')).toHaveText(['Archives', 'Backups', 'Restore/Export']);
  await page.getByRole('button', { name: 'Project notes.md' }).click();
  await expect(page.getByText('Version 1', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Export', exact: true })).toHaveCount(
    desktop ? 0 : 2,
  );
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 950 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
    ).toBe(false);
    await page.screenshot({
      path: `${output}/${desktop ? 'desktop' : 'web'}-archives-${width}.png`,
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1440, height: 950 });
  await page.getByRole('button', { name: 'Restore', exact: true }).last().click();
  await expect(page.getByRole('dialog')).toContainText('Any current local edits will be replaced.');
  await page.getByRole('button', { name: 'Restore version', exact: true }).click();
  await expect(page.getByText('Waiting for the source computer')).toBeVisible();
  await page.getByRole('tab', { name: 'Backups', exact: true }).click();
  await page.getByRole('button', { name: /Automatic backup/ }).click();
  await expect(page.locator('.backup-run-files')).toContainText('Project notes.md');
  if (desktop) {
    await page.getByRole('button', { name: 'Back up now', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Backup queued');
  }
  await page.screenshot({
    path: `${output}/${desktop ? 'desktop' : 'web'}-runs.png`,
    fullPage: true,
  });
  await page.getByRole('tab', { name: 'Archives', exact: true }).click();
  await page.getByRole('button', { name: 'Research', exact: true }).click();
  await expect(page.getByRole('button', { name: /Research draft.txt/ })).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Archive folders' })
    .getByRole('button', { name: 'Documents' })
    .click();
  await page.getByRole('button', { name: 'Project notes.md' }).click();
  if (!desktop) {
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export', exact: true }).last().click();
    expect((await download).suggestedFilename()).toBe('notes.md');
  }
  expect(errors).toEqual([]);
}
const browser = await chromium.launch();
try {
  const api = fixture();
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  await page.route('**/api/**', (route) => {
    const request = route.request(),
      url = new URL(request.url());
    return route.fulfill({
      json: api(
        url.pathname.replace(/^\/api/, '') + url.search,
        request.method(),
        request.postData() ? request.postDataJSON() : {},
      ),
    });
  });
  await page.route('https://download.example.test/**', (route) =>
    route.fulfill({
      body: 'old version',
      headers: { 'Content-Disposition': 'attachment; filename="notes.md"' },
    }),
  );
  await page.goto('http://127.0.0.1:3000/backups');
  await check(page, false);
  expect(api('/test/calls')).toContainEqual(
    expect.objectContaining({
      raw: '/v1/downloads',
      body: { driveItemId: 'file1', versionId: 'v1' },
    }),
  );
} finally {
  await browser.close();
}
const profile = await mkdtemp(path.join(os.tmpdir(), 'harbor-backups-ui-'));
const app = await electron.launch({
  args: ['apps/desktop', `--user-data-dir=${profile}`],
  env: { ...process.env, HARBOR_DEV_AUTH: 'true', HARBOR_API_URL: 'http://127.0.0.1:1' },
});
try {
  const page = await app.firstWindow();
  await expect(page.getByRole('heading', { name: 'Sign in to harbor0' })).toBeVisible();
  await app.evaluate('globalThis.__name = (fn) => fn');
  await app.evaluate(({ ipcMain }, source) => {
    const api = new Function('__name', `return (${source})`)((fn: unknown) => fn)();
    const handler = (name: string, fn: (input: any) => any) => {
      ipcMain.removeHandler('harbor:' + name);
      ipcMain.handle('harbor:' + name, (_event, input) => ({ ok: true, data: fn(input) }));
    };
    handler('status', () => ({
      configured: true,
      signedIn: true,
      accountId: 'demo',
      deviceName: 'MacBook Pro',
      roots: [
        {
          id: 'local1',
          mode: 'backup',
          remoteId: 'cloud1',
          backupId: 'backup1',
          localPathDisplay: '~/Documents',
          localPathDisplayName: 'Documents',
          paused: false,
          excluded: [],
        },
      ],
      jobs: [],
      sync: { online: true, queued: 0, paused: false, issues: [], recent: [], driveItems: [] },
    }));
    handler('request', (input) => api(input.path, input.method, input.body));
    handler('backupNow', (input) => api('/test/backupNow', 'POST', input));
    handler('chooseRoot', () => null);
  }, fixture.toString());
  await page.reload();
  await check(page, true);
  const calls = await page.evaluate(() => window.harbor.request({ path: '/test/calls' }));
  expect(calls).toContainEqual({ raw: '/test/backupNow', method: 'POST', body: { id: 'local1' } });
} finally {
  await app.close();
  await rm(profile, { recursive: true, force: true });
}
console.log(
  'PASS: web and desktop archives, folders, versions, run details, restore requests, on-demand backup, web export, responsive layouts',
);
