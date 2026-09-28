import { chromium, expect, _electron as electron, type Page } from '@playwright/test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const output = 'test-results/trash';
await mkdir(output, { recursive: true });
function fixtureApi() {
  let items = ['first', 'second'].map((id) => ({
    id,
    name: `${id}.txt`,
    type: 'FILE',
    ownerUserId: 'demo',
    parentId: null,
    sizeBytes: 10,
    revision: 2,
    favorite: false,
    currentVersionId: 'version',
    mimeType: 'text/plain',
    createdAt: '2026-09-20T10:00:00Z',
    updatedAt: '2026-09-25T10:00:00Z',
    deletedAt: '2026-09-25T10:00:00Z',
  }));
  const calls: any[] = [];
  return (raw: string, method = 'GET', body: any = {}): any => {
    calls.push({ raw, method, body });
    const url = new URL(raw, 'http://fixture.test');
    if (url.pathname === '/test/calls') return calls;
    if (url.pathname === '/v1/users/me')
      return {
        user: { id: 'demo', displayName: 'Demo', username: 'demo', email: 'demo@example.test' },
        storage: { usedBytes: 20, reservedBytes: 0, quotaBytes: 100000000000 },
      };
    if (url.pathname === '/v1/search') return { items, nextCursor: null };
    if (url.pathname.endsWith('/permanent')) {
      items = items.filter((item) => item.id !== url.pathname.split('/')[4]);
      return { deleted: false, jobId: 'purge' };
    }
    if (url.pathname === '/v1/drive/trash/empty') {
      if (!body.cursor) return { count: 0, nextCursor: 'second-page' };
      items = [];
      return { count: 1, nextCursor: null };
    }
    return { items: [], nextCursor: null };
  };
}
async function check(page: Page, platform: string) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page
    .locator('.sidebar')
    .getByRole(platform === 'web' ? 'link' : 'button', { name: 'Trash', exact: true })
    .click();
  await expect(page.locator('main h1')).toHaveText('Trash');
  const empty = page.getByRole('button', { name: 'Empty Trash', exact: true });
  await expect(empty).toBeEnabled();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth))
      throw new Error(`${platform} trash overflows at ${width}`);
    await page.screenshot({ path: `${output}/${platform}-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await empty.click();
  await expect(page.getByRole('dialog')).toContainText('items on other pages');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Actions for first.txt' }).click();
  await page.getByRole('menuitem', { name: 'Delete permanently', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Delete permanently', exact: true })
    .click();
  await expect(page.getByRole('button', { name: 'Actions for first.txt' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Actions for second.txt' })).toBeVisible();
  await empty.click();
  await page.getByRole('dialog').getByRole('button', { name: 'Empty Trash', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(empty).toBeDisabled();
  const calls = await page.evaluate(
    async (platform) =>
      platform === 'desktop'
        ? window.harbor.request({ path: '/test/calls' })
        : (await fetch('/api/test/calls')).json(),
    platform,
  );
  expect(
    calls.filter((c: any) => c.raw === '/v1/drive/trash/empty').map((c: any) => c.body.cursor),
  ).toEqual([undefined, 'second-page']);
  expect(errors).toEqual([]);
  console.log(
    `PASS ${platform}: cancel, permanent deletion, empty all pages, empty state, responsive trash button`,
  );
}
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const api = fixtureApi();
  await page.route('https://download.example.test/**', (route) =>
    route.fulfill({
      body: 'sample',
      headers: { 'Content-Disposition': 'attachment; filename="sample.pdf"' },
    }),
  );
  await page.route('**/api/**', (route) => {
    const req = route.request();
    const url = new URL(req.url());
    return route.fulfill({
      json: api(
        url.pathname.replace(/^\/api/, '') + url.search,
        req.method(),
        req.postData() ? req.postDataJSON() : {},
      ),
    });
  });
  await page.goto('http://127.0.0.1:3000/drive');
  await check(page, 'web');
} finally {
  await browser.close();
}
const profile = await mkdtemp(path.join(os.tmpdir(), 'harbor-trash-check-'));
const app = await electron.launch({
  args: ['apps/desktop', `--user-data-dir=${profile}`],
  env: { ...process.env, HARBOR_DEV_AUTH: 'true', HARBOR_API_URL: 'http://127.0.0.1:8787' },
});
try {
  const page = await app.firstWindow();
  await expect(page.getByRole('heading', { name: 'Sign in to harbor0' })).toBeVisible();
  await app.evaluate(({ ipcMain }, source) => {
    const api = new Function('__name', `return (${source})`)((fn: unknown) => fn)();
    ipcMain.removeHandler('harbor:status');
    ipcMain.handle('harbor:status', () => ({
      ok: true,
      data: {
        signedIn: true,
        accountId: 'demo',
        roots: [],
        jobs: [],
        sync: { queued: 0, paused: false, recent: [], driveItems: [] },
      },
    }));
    ipcMain.removeHandler('harbor:request');
    ipcMain.handle('harbor:request', (_event, input) => ({
      ok: true,
      data: api(input.path, input.method, input.body),
    }));
    ipcMain.removeHandler('harbor:download');
    ipcMain.handle('harbor:download', (_event, input) => ({
      ok: true,
      data: api('/test/download', 'POST', input),
    }));
  }, fixtureApi.toString());
  await page.reload();
  await check(page, 'desktop');
} finally {
  await app.close();
  await rm(profile, { recursive: true, force: true });
}
