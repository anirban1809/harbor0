import { chromium, expect, _electron as electron, type Page } from '@playwright/test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const output = 'test-results/drive-redesign';
await mkdir(output, { recursive: true });
const fixtures = [
  { id: 'projects', name: 'Projects', type: 'FOLDER', sizeBytes: 0, parentId: null },
  { id: 'design', name: 'Design', type: 'FOLDER', sizeBytes: 0, parentId: null },
  {
    id: 'brief',
    name: 'Brand guidelines.pdf',
    type: 'FILE',
    mimeType: 'application/pdf',
    sizeBytes: 2400000,
    parentId: null,
  },
  {
    id: 'readme',
    name: 'README.md',
    type: 'FILE',
    mimeType: 'text/markdown',
    sizeBytes: 17000,
    parentId: null,
  },
  {
    id: 'photo',
    name: 'Weekend in the mountains.jpg',
    type: 'FILE',
    mimeType: 'image/jpeg',
    sizeBytes: 8200000,
    parentId: null,
  },
  { id: 'metadata', name: '.DS_Store', type: 'FILE', sizeBytes: 12, parentId: null },
  { id: 'thumbs', name: 'Thumbs.db', type: 'FILE', sizeBytes: 12, parentId: null },
  { id: 'nested', name: 'Engine notes.md', type: 'FILE', sizeBytes: 1200, parentId: 'projects' },
].map((item, index) => ({
  ...item,
  ownerUserId: 'demo',
  revision: 1,
  updatedAt: new Date(Date.now() - index * 86400000).toISOString(),
  createdAt: '2026-09-20T10:15:00Z',
  favorite: item.id === 'readme',
  currentVersionId: item.type === 'FILE' ? 'version-1' : null,
}));
// This handler is serialized into Electron's main process as well as used by web routes.
function fixtureApi(initial: any[]) {
  let items = structuredClone(initial);
  let appearance: unknown;
  let syncedIds: string[] = [];
  let syncFailure = false;
  let folderSyncState = 'SYNCING';
  const cloudCopies: any[] = [];
  const calls: any[] = [];
  return (raw: string, method = 'GET', body: any = {}): any => {
    calls.push({ raw, method, body });
    const url = new URL(raw, 'http://fixture.test');
    const pathname = url.pathname;
    if (pathname === '/test/calls') return calls;
    if (pathname === '/v1/drive/cloud-copies') return { items: cloudCopies, nextCursor: null };
    if (pathname.endsWith('/copy-to-cloud') && method === 'POST') {
      const source = items.find((item) => item.id === pathname.split('/')[4]);
      const copy = {
        id: `cloud-copy-${cloudCopies.length}`,
        name: `${source.name} (cloud copy${cloudCopies.length ? ` ${cloudCopies.length + 1}` : ''})`,
        rootId: `cloud-copy-root-${cloudCopies.length}`,
        state: 'COMPLETED',
        waiting: false,
        createdAt: new Date().toISOString(),
        mode: body.mode ?? 'SNAPSHOT',
        ...(body.mode === 'SYNC' ? { syncStatus: 'SYNCED' } : {}),
      };
      cloudCopies.push(copy);
      items.push({ ...source, id: copy.rootId, name: copy.name, parentId: null });
      return { copy };
    }
    if (pathname === '/test/sync-state') {
      folderSyncState = body.state;
      return {};
    }
    if (pathname === '/test/sync-folders') {
      syncedIds = body.ids;
      syncFailure = body.fail ?? false;
      return {};
    }
    if (pathname.startsWith('/v1/sync/folders/') && method === 'DELETE') {
      const id = pathname.split('/').at(-1)!;
      syncedIds = syncedIds.filter((value) => value !== id);
      items = items.filter((item) => item.id !== id && item.parentId !== id);
      return { ok: true };
    }
    if (pathname === '/v1/sync/status')
      return {
        items: (url.searchParams.get('ids') ?? '')
          .split(',')
          .filter(
            (id) => syncedIds.includes(id) || (id === 'nested' && syncedIds.includes('projects')),
          )
          .map((itemId) => ({
            itemId,
            state: itemId === 'nested' ? 'SYNCED' : folderSyncState,
            confirmedDevices: itemId === 'nested' ? 2 : 1,
            requiredDevices: 2,
            pendingItems: itemId === 'nested' ? 0 : 1,
            cloudState: itemId === 'nested' ? 'RELEASED' : 'AVAILABLE',
          })),
      };
    if (pathname === '/v1/sync/folders')
      return syncFailure
        ? {
            status: 503,
            error: { code: 'REQUEST_FAILED', message: 'Sync folder lookup unavailable' },
          }
        : {
            items: items
              .filter((item) => syncedIds.includes(item.id))
              .map((item) => ({
                ...item,
                syncDevices: [
                  { id: 'mac', name: 'MacBook Pro' },
                  { id: 'pc', name: 'Office PC' },
                ],
              })),
          };
    if (pathname === '/v1/users/me') {
      if (method === 'PATCH') appearance = body.appearance;
      return {
        user: {
          id: 'demo',
          displayName: 'Anirban Deb Singha',
          username: 'anirban',
          email: 'anirban@example.test',
          appearance,
        },
        storage: { usedBytes: 144800000, reservedBytes: 0, quotaBytes: 100000000000 },
      };
    }
    if (pathname === '/v1/drive/folders' && method === 'POST') {
      const item = {
        ...initial[0],
        id: 'created-folder',
        name: body.name,
        parentId: body.parentId,
      };
      items.push(item);
      return { item };
    }
    if (pathname.includes('/children')) {
      const parent = pathname.split('/')[4];
      const filtered = items.filter(
        (item) => item.parentId === (parent === 'root' ? null : parent),
      );
      return {
        items: url.searchParams.has('cursor') ? filtered.slice(3) : filtered.slice(0, 3),
        nextCursor: !url.searchParams.has('cursor') && filtered.length > 3 ? 'second' : null,
      };
    }
    if (pathname === '/v1/search')
      return {
        items: items.filter((item) =>
          item.name.toLowerCase().includes((url.searchParams.get('q') ?? '').toLowerCase()),
        ),
        nextCursor: null,
      };
    if (pathname.includes('/shares/'))
      return { items: [{ driveItemId: 'brief', revokedAt: null }], nextCursor: null };
    if (pathname.endsWith('/versions'))
      return {
        items: [
          {
            id: 'version-1',
            versionNumber: 1,
            createdAt: '2026-09-20T10:15:00Z',
            sizeBytes: 17000,
          },
        ],
      };
    const item = items.find((item) => item.id === pathname.split('/')[4]);
    if (item) {
      if (pathname.endsWith('/favorite')) item.favorite = method === 'PUT';
      else if (pathname.endsWith('/move')) item.parentId = body.parentId;
      else if (method === 'PATCH') item.name = body.name;
      else if (method === 'DELETE') items = items.filter((entry) => entry.id !== item.id);
      return { item };
    }
    return { items: [], nextCursor: null };
  };
}
async function checkSeparation(page: Page, platform: string) {
  async function mappings(ids: string[], fail = false, refresh = true) {
    await page.evaluate(
      async ({ ids, platform, fail, refresh }) => {
        if (platform === 'desktop')
          await window.harbor.request({
            path: '/test/sync-folders',
            method: 'POST',
            body: { ids, fail },
          });
        else
          await fetch('/api/test/sync-folders', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids, fail }),
          });
        if (refresh) window.dispatchEvent(new Event('focus'));
      },
      { ids, platform, fail, refresh },
    );
  }
  await expect(page.getByRole('tab')).toHaveText(['Cloud', 'Backup', 'Sync']);
  await expect(page.getByRole('heading', { name: 'Cloud files', exact: true })).toBeVisible();
  await mappings([], true);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
  await expect(page.locator('.file-entry-row')).toHaveCount(0);
  await mappings(['projects'], false, false);
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await page.getByRole('tab', { name: 'Sync', exact: true }).click();

  const cloud = page
    .locator('.drive-section')
    .filter({ has: page.getByRole('heading', { name: 'Cloud files', exact: true }) });
  const synced = page
    .locator('.drive-section')
    .filter({ has: page.getByRole('heading', { name: 'Synced folders', exact: true }) });
  await expect(synced.getByRole('button', { name: 'Projects', exact: true })).toBeVisible();
  await expect(cloud.getByRole('button', { name: 'Projects', exact: true })).toHaveCount(0);
  await expect(synced.getByRole('columnheader', { name: 'Sync status' })).toBeVisible();
  await expect(synced.getByRole('columnheader', { name: 'Device', exact: true })).toHaveCount(0);
  await expect(synced.locator('.file-device-column')).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 900 });
  const compactSyncLayout = await synced.locator('.file-entry-row').evaluate((row) => {
    return {
      nameWidth: row.querySelector('td')!.getBoundingClientRect().width,
      pageOverflows: document.documentElement.scrollWidth > innerWidth,
    };
  });
  expect(compactSyncLayout.nameWidth).toBeGreaterThan(200);
  expect(compactSyncLayout.pageOverflows).toBe(false);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(
    page.getByRole('combobox', { name: 'Filter by type' }).locator('option:checked'),
  ).toHaveText('Type: All items');
  await expect(
    page.getByRole('combobox', { name: 'Filter by modified date' }).locator('option:checked'),
  ).toHaveText('Modified: Any time');
  await expect(page.getByRole('button', { name: 'Sort', exact: true })).toContainText(
    'Modified, newest first',
  );
  await expect(synced.locator('td.file-sync-column .drive-sync-status')).toHaveText('Syncing');
  for (const state of ['SYNCED', 'SYNCING']) {
    await page.evaluate(
      async ({ platform, state }) => {
        if (platform === 'desktop')
          await window.harbor.request({
            path: '/test/sync-state',
            method: 'POST',
            body: { state },
          });
        else
          await fetch('/api/test/sync-state', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ state }),
          });
      },
      { platform, state },
    );
    // No reload or focus event: the status poll must notice backend confirmation.
    await expect(synced.locator('.drive-sync-status')).toHaveText(
      state === 'SYNCED' ? 'Synced' : 'Syncing',
      { timeout: 12000 },
    );
  }

  await mappings(['projects'], true);
  await expect(page.getByRole('button', { name: 'Retry sync folder status' })).toBeVisible();
  await expect(synced.getByRole('button', { name: 'Projects', exact: true })).toBeVisible();
  await expect(page.locator('.file-entry-row')).toHaveCount(1);
  await mappings(['projects']);
  await expect(page.getByRole('button', { name: 'Retry sync folder status' })).toHaveCount(0);
  await synced.getByRole('checkbox', { name: 'Select all files on this page' }).check();
  await expect(page.locator('.drive-toolbar')).toContainText('1 selected');
  await page.getByRole('tab', { name: 'Cloud', exact: true }).click();
  await expect(cloud.locator('.file-entry-row')).toHaveCount(4);
  await expect(page.getByRole('button', { name: 'Clear selection' })).toHaveCount(0);
  await cloud.getByRole('checkbox', { name: 'Select all files on this page' }).check();
  await expect(page.locator('.drive-toolbar')).toContainText('4 selected');
  await page.getByRole('button', { name: 'Clear selection' }).click();
  await page.getByRole('combobox', { name: 'Filter by type' }).selectOption('image');
  await expect(cloud.locator('.file-entry-row')).toHaveCount(1);
  await page.getByRole('combobox', { name: 'Filter by type' }).selectOption('all');
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth))
      throw new Error(`${platform} split tables overflow`);
    await page.screenshot({ path: `${output}/${platform}-sections-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('tab', { name: 'Sync', exact: true }).click();
  await synced.getByRole('button', { name: 'Projects', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Engine notes.md', exact: true })).toBeVisible();
  await expect(page.locator('.drive-section')).toHaveCount(0);
  await expect(page.getByRole('columnheader', { name: 'Sync status' })).toBeVisible();
  await expect(page.locator('td.file-sync-column .drive-sync-status')).toHaveText('Synced');
  await expect(page.locator('.drive-sync-status')).toHaveAttribute(
    'title',
    /2 of 2 linked devices confirmed.*Cloud copy removed/,
  );
  await page.screenshot({ path: `${output}/${platform}-file-sync-status.png`, fullPage: true });

  await page
    .getByRole('navigation', { name: 'Drive location' })
    .getByRole(platform === 'web' ? 'link' : 'button', { name: 'My Drive', exact: true })
    .click();
  await expect(synced.getByRole('button', { name: 'Projects', exact: true })).toBeVisible();
  await mappings([]);
  await expect(page.getByRole('heading', { name: 'No synced folders', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Cloud', exact: true }).click();
  await expect(cloud.getByRole('button', { name: 'Projects', exact: true })).toBeVisible();
  console.log(
    `PASS ${platform}: Cloud/Backup/Sync tabs, per-tab selection, filters, folder browsing, stopped mapping, responsive widths`,
  );
}
async function check(page: Page, platform: string) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await expect(page.locator('.drive-collection .file-entry-row')).toHaveCount(5);
  await expect(page.locator('.workspace-overview, .drive-page .storage-overview')).toHaveCount(0);
  await expect(page.locator('.drive-collection th:visible')).toHaveText([
    'Name',
    'Size',
    'Modified',
    'Actions',
  ]);
  await expect(page.getByRole('button', { name: '.DS_Store', exact: true })).toHaveCount(0);
  await expect(page.locator('.drive-storage')).toContainText('144.8 MB of 100.0 GB');
  await page.locator('.topbar').getByRole('button', { name: 'Account menu' }).click();
  await expect(page.getByRole('menu')).toContainText('anirban@example.test');
  await expect(page.getByRole('menuitem', { name: 'Devices', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  for (const width of [1440, 1024, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByRole('columnheader', { name: 'Modified', exact: true })).toBeVisible();
    if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth))
      throw new Error(`${platform} overflows at ${width}`);
    await page.screenshot({ path: `${output}/${platform}-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('button', { name: 'Sort', exact: true }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Show system files' }).click();
  await expect(page.locator('.file-entry-row')).toHaveCount(7);
  await page.getByRole('button', { name: 'Sort', exact: true }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Show system files' }).click();
  await page.getByRole('combobox', { name: 'Filter by type' }).selectOption('image');
  await expect(page.locator('.file-entry-row')).toHaveCount(1);
  await page.getByRole('combobox', { name: 'Filter by type' }).selectOption('all');
  await page.getByRole('checkbox', { name: 'Select Projects', exact: true }).check();
  await page
    .getByRole('checkbox', { name: 'Select Brand guidelines.pdf', exact: true })
    .click({ modifiers: ['Shift'] });
  await expect(page.locator('.drive-toolbar')).toContainText('3 selected');
  await expect(page.getByRole('combobox', { name: 'Filter by type' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Move to trash', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Move 3 items to trash?');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Clear selection', exact: true }).click();
  await page.getByRole('button', { name: 'Actions for Brand guidelines.pdf' }).click();
  await expect(page.getByRole('menuitem')).toHaveText([
    'Open',
    'Download',
    'Send',
    'Rename',
    'Move',
    'Add to favorites',
    'View details',
    'Version history',
    'Move to trash',
  ]);
  await page.getByRole('menuitem', { name: 'View details', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Created');
  await expect(page.getByRole('dialog')).toContainText('Shared access');
  const panel = await page.getByRole('dialog').boundingBox();
  if (!panel || panel.y !== 0 || Math.abs(panel.x + panel.width - 1440) > 1)
    throw new Error('Details panel is not aligned to the right edge');
  await page.screenshot({ path: `${output}/${platform}-details.png` });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Grid view' }).click();
  await expect(page.locator('.file-entry-card')).toHaveCount(5);
  await expect(page.locator('.file-card-details')).toHaveCount(0);
  await page.screenshot({ path: `${output}/${platform}-grid.png` });
  await page.reload();
  await expect(page.locator('.file-entry-card')).toHaveCount(5);
  await page.getByRole('button', { name: 'List view' }).click();
  await page.getByRole('button', { name: 'New folder', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Folder name' })).toBeFocused();
  await page.getByRole('textbox', { name: 'Folder name' }).fill('Launch assets');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Launch assets', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Clear selection' }).click();
  await page.getByRole('button', { name: 'Actions for Launch assets' }).click();
  await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('textbox', { name: 'Name', exact: true })
    .fill('Launch kit');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Launch kit', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await expect(page.locator('.drive-breadcrumbs')).toContainText('Projects');
  await expect(page.locator('.file-entry-row')).toHaveCount(1);
  await page.getByPlaceholder('Search your files').fill('README');
  await expect(page.getByRole('button', { name: 'README.md', exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Search scope' }).selectOption('folder');
  await expect(page.getByRole('heading', { name: 'No matching files' })).toBeVisible();
  await page.getByRole('button', { name: 'Clear search', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Engine notes.md', exact: true })).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Drive location' })
    .getByRole(platform === 'web' ? 'link' : 'button', { name: 'My Drive', exact: true })
    .click();
  await expect(page.locator('.file-entry-row')).toHaveCount(6);
  await page.getByRole('button', { name: 'Design', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'This folder is empty' })).toBeVisible();
  await page.screenshot({ path: `${output}/${platform}-empty.png` });
  await page
    .getByRole('navigation', { name: 'Drive location' })
    .getByRole(platform === 'web' ? 'link' : 'button', { name: 'My Drive', exact: true })
    .click();
  await page.getByRole('button', { name: 'Actions for Launch kit' }).click();
  await page.getByRole('menuitem', { name: 'Move', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Projects', exact: true }).click();
  await page.getByRole('button', { name: 'Move here', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Launch kit', exact: true })).toHaveCount(0);
  await page.getByRole('checkbox', { name: 'Select README.md', exact: true }).check();
  await page.getByRole('checkbox', { name: 'Select Brand guidelines.pdf', exact: true }).check();
  await expect(page.getByRole('button', { name: 'Share', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByRole('textbox', { name: 'To', exact: true }).fill('@test-recipient');
  await page.getByRole('dialog').getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('checkbox', { name: 'Select README.md', exact: true }).check();
  await page.getByRole('button', { name: 'Move to trash', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Move to trash', exact: true })
    .click();
  await expect(page.getByRole('button', { name: 'README.md', exact: true })).toHaveCount(0);
  await page.evaluate(async (platform) => {
    if (platform === 'desktop')
      await window.harbor.request({
        path: '/v1/drive/items/photo',
        method: 'PATCH',
        body: { name: 'Refreshed photo.jpg' },
      });
    else
      await fetch('/api/v1/drive/items/photo', {
        method: 'PATCH',
        body: JSON.stringify({ name: 'Refreshed photo.jpg' }),
        headers: { 'Content-Type': 'application/json' },
      });
    window.dispatchEvent(new Event('focus'));
  }, platform);
  await expect(
    page.getByRole('button', { name: 'Refreshed photo.jpg', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Switch to dark theme' }).click();
  await page.screenshot({ path: `${output}/${platform}-dark.png` });
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(
    `PASS ${platform}: compact list, pagination, system files, account, filters, shift selection, details, persistent grid, inline creation/focus, rename, breadcrumbs, search scope, move, bulk send, trash confirmation, and responsive widths`,
  );
}
async function checkRemoval(page: Page, platform: string) {
  await page.evaluate(async (platform) => {
    if (platform === 'desktop')
      await window.harbor.request({
        path: '/test/sync-folders',
        method: 'POST',
        body: { ids: ['projects'] },
      });
    else
      await fetch('/api/test/sync-folders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: ['projects'] }),
      });
    window.dispatchEvent(new Event('focus'));
  }, platform);
  await page.getByRole('tab', { name: 'Sync', exact: true }).click();
  const synced = page
    .locator('.drive-section')
    .filter({ has: page.getByRole('heading', { name: 'Synced folders', exact: true }) });
  await expect(synced.getByRole('button', { name: 'Projects', exact: true })).toBeVisible();
  await page.getByRole('checkbox', { name: 'Select Projects', exact: true }).check();
  await expect(page.getByRole('button', { name: 'Move to trash', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Move', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Copy to cloud', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Share', exact: true })).toHaveCount(0);
  for (const name of ['Download', 'Send', 'Copy to cloud'])
    await expect(page.getByRole('button', { name, exact: true }).locator('svg')).toBeVisible();
  await page.keyboard.press('Delete');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Clear selection', exact: true }).click();
  await page.getByPlaceholder('Search your files').fill('Projects');
  await expect(page.getByRole('heading', { name: 'Search results', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Actions for Projects', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: 'Remove from sync', exact: true })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Move to trash', exact: true })).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: 'Move', exact: true })).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: 'Copy to cloud', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Clear search', exact: true }).click();
  await expect(synced.getByRole('button', { name: 'Projects', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Actions for Projects', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: 'Move to trash', exact: true })).toHaveCount(0);
  await page.getByRole('menuitem', { name: 'Copy to cloud', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText(
    'Future sync changes will not affect the copy',
  );
  await expect(page.getByRole('radio', { name: /One-time snapshot/ })).toBeChecked();
  await expect(page.getByRole('radio', { name: /Keep synced/ })).not.toBeChecked();
  await page.setViewportSize({ width: 390, height: 900 });
  await page.screenshot({ path: `${output}/${platform}-copy-options-mobile.png` });
  if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth))
    throw new Error('Copy options overflow');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Projects (cloud copy)', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Actions for Projects', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Copy to cloud', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Copy to cloud', exact: true })
    .click();
  const cloud = page
    .locator('.drive-section')
    .filter({ has: page.getByRole('heading', { name: 'Cloud files', exact: true }) });
  await page.getByRole('tab', { name: 'Cloud', exact: true }).click();
  await expect(
    cloud.getByRole('button', { name: 'Projects (cloud copy)', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Actions for Projects (cloud copy)' }).click();
  await expect(page.getByRole('menuitem', { name: 'Move', exact: true })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Copy to cloud', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.getByRole('tab', { name: 'Sync', exact: true }).click();
  await page.getByRole('button', { name: 'Actions for Projects', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Copy to cloud', exact: true }).click();
  await page.getByRole('radio', { name: /Keep synced/ }).check();
  await expect(page.getByRole('radio', { name: /One-time snapshot/ })).not.toBeChecked();
  await page.screenshot({ path: `${output}/${platform}-copy-options.png` });
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Copy to cloud', exact: true })
    .click();
  await expect(page.locator('.drive-feedback')).toHaveCount(0);
  const activity = page.getByRole('button', { name: /^Activity notifications/ });
  await expect(activity).toHaveAccessibleName(/unread/);
  await activity.click();
  const drawer = page.getByRole('dialog', { name: 'Activity', exact: true });
  await expect(
    drawer.getByText('“Projects (cloud copy 2)” is kept synced with your local folder.'),
  ).toBeVisible();
  await expect(drawer.getByText('“Projects (cloud copy)” saved in My Drive.')).toBeVisible();
  await expect(page.locator('.activity-unread')).toHaveCount(0);
  await page.screenshot({ path: `${output}/${platform}-activity.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await drawer.evaluate((el) => el.getBoundingClientRect().right <= innerWidth)).toBe(true);
  await page.screenshot({ path: `${output}/${platform}-activity-mobile.png` });
  await page.keyboard.press('Escape');
  await expect(activity).toBeFocused();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('tab', { name: 'Cloud', exact: true }).click();
  await expect(
    cloud.getByRole('button', { name: 'Projects (cloud copy 2)', exact: true }),
  ).toBeVisible();
  await page.getByRole('tab', { name: 'Sync', exact: true }).click();
  await page.getByRole('button', { name: 'Actions for Projects', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Remove from sync', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('all linked devices');
  await expect(dialog).toContainText('Local folders and files will stay where they are');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(synced.getByRole('button', { name: 'Projects', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Sync', exact: true }).click();
  await page.getByRole('button', { name: 'Actions for Projects', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Remove from sync', exact: true }).click();
  await dialog.getByRole('button', { name: 'Remove from sync', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Projects', exact: true })).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'My Drive', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Projects', exact: true })).toHaveCount(0);
  console.log(
    'PASS ' +
      platform +
      ': Copy to cloud offers snapshot and ongoing sync, copies stay in Cloud files; synced folders cannot be trashed; remove from sync preserves cancellation and stays hidden after refresh',
  );
}
const browser = await chromium.launch();
try {
  if (!process.env.DESKTOP_ONLY) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const api = fixtureApi(fixtures);
    await page.route('**/api/**', (route) => {
      const req = route.request();
      const result = api(
        new URL(req.url()).pathname.replace(/^\/api/, '') + new URL(req.url()).search,
        req.method(),
        req.postData() ? req.postDataJSON() : {},
      );
      return route.fulfill({ status: result.status ?? 200, json: result });
    });
    await page.goto(process.env.DRIVE_CHECK_URL ?? 'http://127.0.0.1:3000/drive');
    await checkSeparation(page, 'web');
    await check(page, 'web');
    await checkRemoval(page, 'web');
    const sends = api('/test/calls').filter(
      (call: any) => call.raw === '/v1/transfers' && call.method === 'POST',
    );
    expect(sends).toHaveLength(1);
    expect(
      sends[0].body.items.map((item: { driveItemId: string }) => item.driveItemId).sort(),
    ).toEqual(['brief', 'readme']);
  }
} finally {
  await browser.close();
}
const profile = await mkdtemp(path.join(os.tmpdir(), 'harbor-drive-check-'));
const app = await electron.launch({
  args: ['apps/desktop', `--user-data-dir=${profile}`],
  env: { ...process.env, HARBOR_DEV_AUTH: 'true', HARBOR_API_URL: 'http://127.0.0.1:8787' },
});
try {
  const first = await app.firstWindow();
  await expect(first.getByRole('heading', { name: 'Sign in to harbor0' })).toBeVisible();
  await app.evaluate(
    ({ ipcMain }, { fixtures, source }) => {
      const api = new Function(`return (${source})`)()(fixtures);
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
      ipcMain.handle('harbor:request', (_event, input) => {
        const result = api(input.path, input.method, input.body);
        return result.error
          ? { ok: false, error: result.error.message }
          : { ok: true, data: result };
      });
      ipcMain.removeHandler('harbor:removeSyncFolder');
      ipcMain.handle('harbor:removeSyncFolder', (_event, input) => ({
        ok: true,
        data: api('/v1/sync/folders/' + input.folderId, 'DELETE'),
      }));
      ipcMain.removeHandler('harbor:upload');
      ipcMain.handle('harbor:upload', (_event, input) => ({ ok: true, data: input }));
      ipcMain.removeHandler('harbor:download');
      ipcMain.handle('harbor:download', () => ({ ok: true, data: {} }));
    },
    { fixtures, source: fixtureApi.toString() },
  );
  const page = await app.firstWindow();
  await page.reload();
  await checkSeparation(page, 'desktop');
  await check(page, 'desktop');
  await checkRemoval(page, 'desktop');
  await page.evaluate(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.id = 'test-drop';
    document.body.append(input);
  });
  await page.locator('#test-drop').setInputFiles(path.resolve('tests/fixtures/preview.webm'));
  const dropped = await page.evaluate(async () => {
    const file = (document.getElementById('test-drop') as HTMLInputElement).files![0];
    return window.harbor.uploadDropped({
      entries: [{ file, folders: ['Clips', '2026'] }],
      parentId: null,
    });
  });
  if (dropped.dropped?.[0]?.path !== path.resolve('tests/fixtures/preview.webm'))
    throw new Error('Native drop did not preserve file path');
  if (dropped.dropped[0].folders.join('/') !== 'Clips/2026')
    throw new Error('Native folder drop did not preserve folder layout');
  console.log('PASS desktop: native dropped files and folders use the existing upload bridge');
} finally {
  await app.close();
  await rm(profile, { recursive: true, force: true });
}
