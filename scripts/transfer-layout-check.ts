import { chromium, expect, _electron as electron, type Page } from '@playwright/test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const output = 'test-results/transfer-layout';
await mkdir(output, { recursive: true });
// Isolated fixtures exercise both clients without changing a real account.
function fixtureApi() {
  const calls: any[] = [];
  const entry = (
    id: string,
    displayName: string,
    itemType = 'FILE',
    parentEntryId: string | null = null,
  ) => ({
    id,
    displayName,
    relativePath: parentEntryId ? `Project assets/${displayName}` : displayName,
    itemType,
    parentEntryId,
    sizeBytes: 2400000,
    mimeType: 'application/pdf',
  });
  const transfer = (id: string, state: string, items: any[]) => ({
    id,
    state,
    items,
    sender: { displayName: 'Morgan Chen', username: 'morgan' },
    recipient: { displayName: 'Alex Rivera', username: 'alex' },
    recipientEmail: null,
    createdAt: '2026-09-25T10:00:00Z',
    expiresAt: '2026-10-25T10:00:00Z',
    totalSizeBytes: 2400000,
    savedAt: null,
    preparationState: 'READY',
  });
  const received: any[] = [
    transfer('pending', 'PENDING', [entry('brief', 'Brand guidelines.pdf')]),
    {
      ...transfer('accepted', 'ACCEPTED', [
        entry('folder', 'Project assets', 'FOLDER'),
        entry(
          'photo',
          'A very long project proposal and supporting documentation.pdf',
          'FILE',
          'folder',
        ),
      ]),
      nextEntryCursor: 'more',
    },
    {
      ...transfer('preparing', 'PENDING', []),
      preparationState: 'BUILDING',
      displayNames: ['Launch kit.zip'],
    },
    {
      ...transfer('expired', 'EXPIRED', [entry('archive', 'Archive.zip')]),
      expiresAt: '2026-09-20T10:00:00Z',
    },
  ];
  const sent: any[] = [
    {
      ...transfer('sent', 'PENDING_RECIPIENT_SIGNUP', [entry('invite', 'Welcome.pdf')]),
      recipient: null,
      recipientEmail: 'new.recipient.with.a.long.address@example.test',
    },
    {
      ...transfer('failed', 'PENDING', []),
      preparationState: 'FAILED',
      displayNames: ['Unfinished.zip'],
      failure: 'Files could not be prepared. Please try again.',
    },
  ];
  return (raw: string, method = 'GET', body: any = {}): any => {
    calls.push({ raw, method, body });
    const url = new URL(raw, 'http://fixture.test');
    const p = url.pathname;
    if (p === '/test/calls') return calls;
    if (p === '/v1/users/me')
      return {
        user: {
          id: 'demo',
          displayName: 'Anirban',
          username: 'anirban',
          email: 'anirban@example.test',
        },
        storage: {
          usedBytes: 144800000,
          reservedBytes: 0,
          availableBytes: 99855200000,
          quotaBytes: 100000000000,
        },
      };
    if (p === '/v1/transfers/received' || p === '/v1/transfers/sent')
      return url.searchParams.has('cursor')
        ? {
            items: [transfer('last', 'DECLINED', [entry('last-file', 'Older document.pdf')])],
            nextCursor: null,
          }
        : { items: p.endsWith('received') ? received : sent, nextCursor: 'page2' };
    if (p.endsWith('/items'))
      return {
        items: [entry('nested', 'Additional file.pdf', 'FILE', 'folder')],
        nextCursor: null,
      };
    if (method === 'POST' && p.startsWith('/v1/transfers/')) {
      const t = [...received, ...sent].find((t) => t.id === p.split('/')[3]);
      if (p.endsWith('/accept')) t.state = 'ACCEPTED';
      if (p.endsWith('/decline')) t.state = 'DECLINED';
      if (p.endsWith('/cancel')) t.state = 'CANCELLED';
      if (p.endsWith('/save')) t.savedAt = '2026-09-27T10:00:00Z';
      return { transfer: t };
    }
    if (p === '/v1/downloads')
      return { downloadUrl: 'https://download.example.test/file', sizeBytes: 2400000 };
    if (p === '/v1/devices')
      return {
        items: [
          {
            id: 'device',
            name: 'My laptop with a long device name',
            platform: 'MACOS',
            createdAt: '2026-09-20T10:00:00Z',
            revokedAt: null,
          },
        ],
        nextCursor: null,
      };
    return { items: [], nextCursor: null };
  };
}
async function check(page: Page, platform: 'web' | 'desktop') {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  const navigate = (name: string) =>
    (name === 'Notifications'
      ? page.getByRole('link', { name, exact: true })
      : nav.getByRole(platform === 'web' ? 'link' : 'button', { name, exact: true })
    ).click();
  await expect(nav).toBeVisible();
  await expect(nav.getByText(/^Recents?$/)).toHaveCount(0);
  await navigate('Received');
  await expect(page.locator('.transfer-table tbody tr')).toHaveCount(4);
  await expect(page.locator('.transfer-table th')).toHaveText([
    'Files',
    'From',
    'Size',
    'Date sent',
    'Expires',
    'Status',
    'Actions',
  ]);
  await expect(page.locator('.transfer-table')).toContainText('Preparing files');
  await page.getByRole('button', { name: 'Load more files' }).click();
  await expect(page.locator('.transfer-table')).toContainText('Additional file.pdf');
  await expect(page.getByRole('button', { name: 'Load more files' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Accept', exact: true }).click();
  const pending = page
    .locator('.transfer-table tbody tr')
    .filter({ hasText: 'Brand guidelines.pdf' });
  await expect(pending.getByRole('button', { name: 'Save to My Drive' })).toBeVisible();
  await pending.getByRole('button', { name: 'Save to My Drive' }).click();
  await expect(pending.getByRole('button', { name: 'Saved', exact: true })).toBeDisabled();
  await pending.getByRole('button', { name: 'Download Brand guidelines.pdf' }).click();
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(page.locator('.transfer-table')).toContainText('Older document.pdf');
  await page.getByRole('button', { name: 'First page', exact: true }).click();
  await expect(page.locator('.transfer-table tbody tr')).toHaveCount(4);
  await navigate('Sent');
  await expect(page.locator('.transfer-table th').nth(1)).toHaveText('To');
  await expect(page.locator('.transfer-table')).toContainText('Preparation failed');
  const outgoing = page.locator('.transfer-table tbody tr').filter({ hasText: 'Welcome.pdf' });
  await outgoing.getByRole('button', { name: 'Cancel transfer' }).click();
  await expect(outgoing).toContainText('cancelled');
  await expect(outgoing.getByRole('button', { name: 'Cancel transfer' })).toHaveCount(0);
  const pages = [
    'My Drive',
    'Received',
    'Sent',
    'Favorites',
    'Trash',
    'Devices',
    'Storage',
    'Settings',
    ...(platform === 'web' ? ['Shared', 'Notifications'] : ['Backups', 'Sync']),
  ];
  for (const name of pages) {
    await navigate(name);
    await expect(page.locator('main h1')).toHaveText(
      name === 'Sync' ? 'Sync on this computer' : name,
    );
    await expect(page.locator('.content-skeleton-row')).toHaveCount(0);
    for (const width of [1440, 1024, 768, 390]) {
      await page.setViewportSize({ width, height: 900 });
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      );
      if (overflow) throw new Error(`${platform} ${name} overflows at ${width}px`);
      if (width === 1440 || width === 390)
        await page.screenshot({
          path: `${output}/${platform}-${name.toLowerCase().replaceAll(' ', '-')}-${width}.png`,
          fullPage: true,
          animations: 'disabled',
        });
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await navigate('Received');
  await page.getByRole('button', { name: 'Switch to dark theme' }).click();
  await page.screenshot({
    path: `${output}/${platform}-received-dark.png`,
    animations: 'disabled',
  });
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(
    `PASS ${platform}: transfer actions, downloads, manifest and transfer pagination, ${pages.length} pages at four widths, dark theme, no Recents navigation`,
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
  if (!api('/test/calls').some((c: any) => c.raw === '/v1/downloads' && c.body.entryId === 'brief'))
    throw new Error('Web download not requested');
  const response = await page.goto('http://127.0.0.1:3000/recent');
  if (response?.status() !== 404) throw new Error('Removed Recent route should return 404');
} finally {
  await browser.close();
}
const profile = await mkdtemp(path.join(os.tmpdir(), 'harbor-transfer-check-'));
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
  const calls = await page.evaluate(() => window.harbor.request({ path: '/test/calls' }));
  if (!calls.some((c: any) => c.raw === '/test/download' && c.body.entryId === 'brief'))
    throw new Error('Desktop download not requested');
} finally {
  await app.close();
  await rm(profile, { recursive: true, force: true });
}
