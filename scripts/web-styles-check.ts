import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { workspaceRoutes } from '../apps/web/lib/routes';

// Test the actual export (or hosted assets), with isolated API fixtures and no live account.
const root = path.resolve('.cloud/web-export/out');
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url!, 'http://localhost').pathname;
  const pagePath =
    pathname === '/'
      ? '/index.html'
      : path.extname(pathname)
        ? pathname
        : pathname.replace(/\/$/, '') + '.html';
  const file = path.resolve(root, '.' + decodeURIComponent(pagePath));
  if (!file.startsWith(root + path.sep)) {
    response.writeHead(403).end();
    return;
  }
  try {
    const types: Record<string, string> = {
      '.html': 'text/html',
      '.css': 'text/css',
      '.js': 'text/javascript',
      '.woff2': 'font/woff2',
      '.txt': 'text/plain',
    };
    const content = await readFile(file);
    response.writeHead(200, {
      'Content-Type': types[path.extname(file)] ?? 'application/octet-stream',
    });
    response.end(content);
  } catch {
    response.writeHead(404).end();
  }
});
const hostedUrl = process.env.WEB_STYLES_URL;
if (!hostedUrl) await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
const url =
  hostedUrl ?? `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    colorScheme: 'light',
  });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/**', async (route) => {
    if (route.request().url().endsWith('/v1/users/me'))
      return route.fulfill({
        json: {
          user: {
            id: 'style-check',
            displayName: 'UI Preview',
            username: 'preview',
            email: 'preview@example.test',
          },
          storage: { usedBytes: 37000, quotaBytes: 100000000000, reservedBytes: 0 },
        },
      });
    if (route.request().url().endsWith('/drive/items/export-folder'))
      return route.fulfill({
        json: {
          item: { id: 'export-folder', name: 'Export folder', type: 'FOLDER', parentId: null },
        },
      });
    if (!route.request().url().includes('/folders/'))
      return route.fulfill({ json: { items: [], nextCursor: null } });
    return route.fulfill({
      json: {
        items: [
          {
            id: 'sample',
            name: route.request().url().includes('/folders/export-folder/')
              ? 'Folder notes.md'
              : 'Project notes.md',
            type: 'FILE',
            mimeType: 'text/markdown',
            sizeBytes: 37000,
            ownerUserId: 'style-check',
            revision: 1,
            createdAt: '2026-09-25T10:00:00Z',
            updatedAt: '2026-09-26T10:00:00Z',
          },
        ],
        nextCursor: null,
      },
    });
  });
  await page.goto(url);
  await expect(
    page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('link', { name: 'Favorites', exact: true }),
  ).toHaveCount(0);
  expect([403, 404]).toContain((await page.request.get(new URL('/favorites', url).href)).status());
  await expect(page.locator('.file-entry-row')).toHaveCount(1);
  const upload = page.locator('.upload-button');
  await expect(upload).toHaveCSS('display', 'flex');
  await expect(upload).toHaveCSS('border-radius', '8px');
  await expect(upload).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  const tokenColor = (token: string) =>
    page.evaluate((token) => {
      const probe = document.createElement('span');
      probe.style.color = `var(${token})`;
      document.body.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    }, token);
  await expect(upload).toHaveCSS('color', await tokenColor('--primary-foreground'));
  await expect(upload).toHaveCSS('background-color', await tokenColor('--primary'));
  // Assert the current file-manager layout, including the deliberate removal of
  // the dashboard. This check runs before either deployment path uploads assets.
  await expect(page.locator('.workspace-overview')).toHaveCount(0);
  await expect(page.locator('.drive-collection th')).toHaveText([
    'Name',
    'Size',
    'Modified',
    'Actions',
  ]);
  await expect(page.locator('.drive-storage')).toContainText('37.0 KB of 100.0 GB');
  await expect(page.locator('.files-table caption')).toHaveCSS('position', 'absolute');
  await expect(page.locator('.files-table caption')).toHaveCSS('width', '1px');
  // Keep the flat, compact file-browser surface consistent in the published export.
  const table = page.locator('.drive-collection .table');
  const tableScroll = page.getByRole('region', { name: 'Cloud files table', exact: true });
  await expect(table).toBeVisible();
  await expect(table).toHaveCSS('border-collapse', 'collapse');
  await expect(tableScroll).toHaveCSS('overflow-x', 'auto');
  await expect(tableScroll).toHaveCSS('border-top-width', '0px');
  await expect(tableScroll).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(table.locator('th').first()).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(table.locator('th').first()).toHaveCSS('padding', '0px 12px');
  await expect(table.locator('tbody td').first()).toHaveCSS('padding', '8px 12px');
  await expect(table.locator('tbody td').first()).toHaveCSS('border-bottom-width', '1px');
  await expect(table.locator('.file-entry-icon')).toHaveCSS('width', '28px');
  await expect(table.locator('.file-entry-label small')).toHaveCount(0);
  for (const [tab, title] of [
    ['Backup', 'No backup folders'],
    ['Sync', 'No synced folders'],
  ]) {
    await page.getByRole('tab', { name: tab, exact: true }).click();
    await expect(page.locator('.empty-state').getByRole('heading', { name: title })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Filter by type', exact: true })).toBeVisible();
    await expect(page.getByText('Backup files are read-only', { exact: false })).toHaveCount(0);
  }
  await page.getByRole('tab', { name: 'Cloud', exact: true }).click();
  await expect(table).toBeVisible();
  await page.getByRole('button', { name: 'New folder', exact: true }).click();
  const folderName = page.getByRole('textbox', { name: 'Folder name', exact: true });
  await expect(folderName).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(folderName).toHaveCount(0);
  // Dialog primitives still need compiled styles and focus management.
  await page.getByRole('button', { name: 'Actions for Project notes.md', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
  await expect(page.getByRole('dialog').getByLabel('Name', { exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Grid view', exact: true }).click();
  const card = page.locator('.drive-collection .file-entry-card').first();
  await expect(card).toHaveCSS('border-top-width', '1px');
  await expect(card).toHaveCSS('border-radius', '12px');
  await expect(card).toHaveCSS('padding-top', '12px');
  const lightCardColor = await card.evaluate((el) => getComputedStyle(el).backgroundColor);
  await page.getByRole('button', { name: 'List view', exact: true }).click();
  await page.evaluate(() => document.fonts.ready);
  await mkdir('test-results/web-styles', { recursive: true });
  const prefix = hostedUrl ? 'hosted' : 'export';
  await page.screenshot({ path: `test-results/web-styles/${prefix}-light.png`, fullPage: true });
  await page.getByRole('button', { name: 'Switch to dark theme' }).click();
  await expect(page.locator('html')).toHaveClass('dark');
  await page.getByRole('button', { name: 'Grid view', exact: true }).click();
  await expect(card).not.toHaveCSS('background-color', lightCardColor);
  await expect(card).toHaveCSS('background-color', await tokenColor('--card'));
  await page.getByRole('button', { name: 'List view', exact: true }).click();
  await page.waitForTimeout(250);
  await page.screenshot({ path: `test-results/web-styles/${prefix}-dark.png`, fullPage: true });
  for (const width of [1024, 768, 390]) {
    await page.setViewportSize({ width, height: 844 });
    for (let index = 0; index < 4; index++)
      await expect(table.getByRole('columnheader').nth(index)).toBeVisible();
    if (width === 390)
      expect(await tableScroll.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  // Exercise clean URLs against the actual static export, including refreshes.
  for (const [name, route] of Object.entries(workspaceRoutes)) {
    await page.goto(new URL(route, url).href);
    await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  }
  await page.goto(new URL('/drive?folder=export-folder', url).href);
  await expect(page.getByRole('button', { name: 'Folder notes.md', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Folder notes.md', exact: true })).toBeVisible();
  await expect(
    page.locator('.breadcrumbs').getByRole('link', { name: 'Export folder', exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
  console.log(
    `PASS: ${prefix} styles, shared Drive table/grid, inline folder and dialog focus, dark theme, responsive layout and workspace/folder URLs with refresh`,
  );
} finally {
  await browser.close();
  if (server.listening)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
}
