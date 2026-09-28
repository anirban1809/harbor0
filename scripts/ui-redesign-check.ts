import { chromium, expect, _electron as electron, type Page } from '@playwright/test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

await mkdir('test-results/ui-redesign', { recursive: true });

// Deterministic UI fixtures: no account, cloud files, or credentials are modified.
const items = [
  { id: 'ideas', name: 'Creative projects', type: 'FOLDER', sizeBytes: 0 },
  { id: 'work', name: 'Work documents', type: 'FOLDER', sizeBytes: 0 },
  {
    id: 'brief',
    name: 'Brand guidelines.pdf',
    type: 'FILE',
    mimeType: 'application/pdf',
    sizeBytes: 2400000,
  },
  {
    id: 'photo',
    name: 'Weekend in the mountains.jpg',
    type: 'FILE',
    mimeType: 'image/jpeg',
    sizeBytes: 8200000,
  },
].map((item) => ({
  ...item,
  ownerUserId: 'demo',
  revision: 1,
  updatedAt: '2026-09-25T08:00:00Z',
  createdAt: '2026-09-20T10:15:00Z',
  favorite: false,
}));
async function checkAppearance(page: Page, platform: string) {
  const settings = () =>
    page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole(platform === 'web' ? 'link' : 'button', { name: 'Settings', exact: true })
      .click();
  const token = (name: string) =>
    page.evaluate((name) => document.documentElement.style.getPropertyValue('--' + name), name);
  await settings();
  await expect(page.getByRole('heading', { name: 'Appearance', exact: true })).toBeVisible();
  await page.getByRole('button', { name: /^Ocean / }).click();
  await page.getByRole('button', { name: 'Dark', exact: true }).click();
  await expect.poll(() => token('primary')).toBe('#60a5fa');
  await expect(page.locator('.appearance-settings').getByRole('status')).toHaveText(
    'Saved to your account.',
  );
  await page.getByRole('button', { name: /^Harbor / }).click();
  await page.getByRole('button', { name: 'Light', exact: true }).click();
  await page.getByRole('textbox', { name: 'Accent hex color', exact: true }).fill('#2563eb');
  await expect.poll(() => token('primary')).toBe('#2563eb');
  await page.getByRole('textbox', { name: 'Accent hex color', exact: true }).fill('#nope');
  await page.getByRole('heading', { name: 'Appearance', exact: true }).click();
  await expect(page.locator('.appearance-settings').getByRole('alert')).toContainText(
    'Use a hex color',
  );
  await expect.poll(() => token('primary')).toBe('#2563eb');
  await page.getByRole('textbox', { name: 'Accent hex color', exact: true }).fill('#2563eb');
  await page.getByRole('button', { name: 'Dark', exact: true }).click();
  await expect.poll(() => token('primary')).toBe('');
  await page.getByRole('textbox', { name: 'Accent hex color', exact: true }).fill('#fbbf24');
  await expect.poll(() => token('primary-foreground')).toBe('#000000');
  await expect(page.locator('.appearance-settings').getByRole('status')).toHaveText(
    'Saved to your account.',
  );
  await page.reload();
  await settings();
  await expect(page.getByRole('textbox', { name: 'Accent hex color', exact: true })).toHaveValue(
    '#fbbf24',
  );
  await page.getByRole('button', { name: 'Light', exact: true }).click();
  await expect.poll(() => token('primary')).toBe('#2563eb');
  await page.getByRole('button', { name: 'Reset light colors', exact: true }).click();
  await expect.poll(() => token('primary')).toBe('');
  await page.getByRole('button', { name: 'Dark', exact: true }).click();
  await expect.poll(() => token('primary')).toBe('#fbbf24');
  await page.getByRole('button', { name: 'Reset accent color', exact: true }).click();
  await expect.poll(() => token('primary')).toBe('');
  await expect.poll(() => token('primary-foreground')).toBe('');
  await page.getByRole('button', { name: 'System', exact: true }).click();
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveClass('dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).not.toHaveClass('dark');
  await page.getByRole('button', { name: 'Light', exact: true }).click();
  // Mixed light/dark surfaces must retain readable outline controls.
  await page.getByRole('textbox', { name: 'Background hex color', exact: true }).fill('#000000');
  await page.getByRole('textbox', { name: 'Cards hex color', exact: true }).fill('#ffffff');
  await expect(page.getByRole('button', { name: 'Reset light colors', exact: true })).toHaveCSS(
    'color',
    'rgb(255, 255, 255)',
  );
  for (const [name, color] of [
    ['Accent', '#2563eb'],
    ['Background', '#eff6ff'],
    ['Cards', '#ffffff'],
    ['Sidebar', '#172554'],
    ['Borders', '#bfdbfe'],
  ]) {
    await page.getByRole('textbox', { name: name + ' hex color', exact: true }).fill(color);
  }
  await page.getByRole('heading', { name: 'Appearance', exact: true }).click();
  await expect.poll(() => token('sidebar-foreground')).toBe('#ffffff');
  await page.waitForTimeout(250);
  await page.screenshot({
    path: 'test-results/ui-redesign/' + platform + '-appearance.png',
    fullPage: true,
  });
  if (platform === 'web') {
    await page.setViewportSize({ width: 390, height: 844 });
    if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth))
      throw new Error('Appearance settings overflow on mobile');
    await page.screenshot({
      path: 'test-results/ui-redesign/web-appearance-mobile.png',
      fullPage: true,
    });
  }
  console.log(
    'PASS: ' +
      platform +
      ' custom colors, validation, reload persistence, independent palettes, resets, system appearance',
  );
}

async function checkEmptyViews(page: Page, platform: 'web' | 'desktop') {
  const empty = page.locator('.empty-state');
  const navigate = async (name: string) => {
    await page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole(platform === 'web' ? 'link' : 'button', { name, exact: true })
      .click();
  };
  await expect(
    empty.getByRole('heading', { name: 'This folder is empty', exact: true }),
  ).toBeVisible();
  await page.evaluate(async () => {
    await document.fonts.ready;
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(250);
  await page.screenshot({
    path: `test-results/ui-redesign/${platform}-empty-drive.png`,
    fullPage: true,
  });
  await empty.getByRole('button', { name: 'New folder', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Folder name', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  if (platform === 'web') {
    const upload = page.waitForEvent('filechooser');
    await empty.getByRole('button', { name: 'Upload files', exact: true }).click();
    await upload;
  }
  for (const [section, title] of [
    ['Favorites', 'No favorite files'],
    ['Trash', 'Trash is empty'],
    ['Received', 'No received files'],
    ['Sent', 'No sent files'],
    ...(platform === 'web' ? [['Shared', 'No shared files']] : []),
  ]) {
    await navigate(section);
    await expect(empty.getByRole('heading', { name: title, exact: true })).toBeVisible();
    await empty.getByRole('button', { name: 'Browse My Drive', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'My Drive', exact: true })).toBeVisible();
  }
  await navigate('Devices');
  await expect(
    empty.getByRole('heading', { name: 'No connected devices', exact: true }),
  ).toBeVisible();
  await empty.getByRole('button', { name: 'Refresh devices' }).click();
  await expect(
    empty.getByRole('heading', { name: 'No connected devices', exact: true }),
  ).toBeVisible();
  await navigate('My Drive');
  await page.getByRole('button', { name: 'Switch to dark theme' }).click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(250);
  await page.screenshot({
    path: `test-results/ui-redesign/${platform}-empty-dark.png`,
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Switch to light theme' }).click();
  console.log(
    `PASS: ${platform} empty views, navigation, create folder and device refresh actions`,
  );
}

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1440, height: 1000 },
  colorScheme: 'light',
});
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(e.message));
let authenticated = false;
let accountAppearance: unknown;
let releaseFirstFiles!: () => void;
const firstFiles = new Promise<void>((resolve) => {
  releaseFirstFiles = resolve;
});
let emptyFiles = false;
let failShared = false;
await page.route('**/api/**', async (route) => {
  const url = route.request().url();
  if (url.endsWith('/v1/users/me')) {
    if (route.request().method() === 'PATCH')
      accountAppearance = route.request().postDataJSON().appearance;
    return route.fulfill({
      status: authenticated ? 200 : 401,
      json: authenticated
        ? {
            user: {
              id: 'demo',
              appearance: accountAppearance,
              displayName: 'Alex Morgan',
              username: 'alex',
              email: 'alex@example.test',
            },
            storage: { usedBytes: 24800000000, quotaBytes: 100000000000, reservedBytes: 0 },
          }
        : { error: { code: 'UNAUTHORIZED', message: 'Sign in' } },
    });
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
  if (failShared && url.includes('/v1/shares'))
    return route.fulfill({
      status: 503,
      json: { error: { code: 'UNAVAILABLE', message: 'Temporarily unavailable' } },
    });
  if (url.includes('/drive/folders/root/children')) await firstFiles;
  const empty = emptyFiles || url.includes('/ideas/') || url.includes('/versions');
  const item = items.find((item) => url.endsWith(`/v1/drive/items/${item.id}`));
  if (item) return route.fulfill({ json: { item: { ...item, parentId: null } } });
  return route.fulfill({ json: { items: empty ? [] : items, nextCursor: null } });
});
try {
  await page.goto('http://127.0.0.1:3000');
  await expect(page.getByLabel('Email', { exact: true })).toBeVisible();
  await page.waitForTimeout(250);
  await page.screenshot({ path: 'test-results/ui-redesign/web-login.png' });
  authenticated = true;
  await page.reload();
  await expect(page.getByRole('heading', { name: 'My Drive', exact: true })).toBeVisible();
  await expect(page.getByRole('status', { name: 'Loading files', exact: true })).toBeVisible();
  await expect(page.locator('.empty-state')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/ui-redesign/web-files-loading.png' });
  releaseFirstFiles();
  await expect(page.locator('.file-entry-row')).toHaveCount(4);
  await expect(page.getByRole('columnheader', { name: 'Created', exact: true })).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Brand guidelines.pdf', exact: true }),
  ).not.toContainText('PDF document');
  await page.getByRole('checkbox', { name: 'Select all files on this page' }).check();
  await expect(page.getByText('4 selected', { exact: true })).toBeVisible();
  await page.getByRole('checkbox', { name: 'Select Creative projects', exact: true }).uncheck();
  await expect
    .poll(() =>
      page
        .getByRole('checkbox', { name: 'Select all files on this page' })
        .evaluate((el) => (el as HTMLInputElement).indeterminate),
    )
    .toBe(true);
  await page.getByRole('button', { name: 'Clear selection', exact: true }).click();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
  await page.screenshot({ path: 'test-results/ui-redesign/web-light.png', fullPage: true });
  await page.getByRole('button', { name: 'New folder', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Folder name', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.getByRole('button', { name: 'Switch to dark theme' }).click();
  await expect(page.locator('html')).toHaveClass('dark');
  await expect.poll(() => (accountAppearance as { preference?: string })?.preference).toBe('dark');
  await page.reload();
  await expect(page.locator('html')).toHaveClass('dark');
  await expect(page.locator('.file-entry-row')).toHaveCount(4);
  await page.waitForTimeout(250);
  await page.screenshot({ path: 'test-results/ui-redesign/web-dark.png', fullPage: true });
  await page.getByRole('button', { name: 'Grid view' }).click();
  await expect(page.locator('.file-grid')).toBeVisible();
  await page.getByRole('button', { name: 'List view' }).click();
  await page.getByRole('button', { name: 'Actions for Brand guidelines.pdf' }).click();
  await expect(page.getByRole('menuitem', { name: 'Rename', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Switch to light theme' }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('link', { name: 'Favorites', exact: true })).toBeVisible();
  if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth))
    throw new Error('Mobile horizontal overflow');
  await page.waitForTimeout(250);
  await page.screenshot({ path: 'test-results/ui-redesign/web-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: 'Creative projects', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'This folder is empty', exact: true }),
  ).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Drive location' })
    .getByRole('link', { name: 'My Drive', exact: true })
    .click();
  await expect(page.locator('.file-entry-row')).toHaveCount(4);
  await page.getByRole('button', { name: 'Actions for Brand guidelines.pdf', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Version history', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'No versions to show', exact: true }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await checkAppearance(page, 'web');
  await page.getByRole('button', { name: 'Reset light colors', exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  emptyFiles = true;
  await page.reload();
  await page.locator('.sidebar').getByRole('link', { name: 'My Drive', exact: true }).click();
  await checkEmptyViews(page, 'web');
  await page.getByPlaceholder('Search your files').fill('missing-file');
  await expect(page.getByRole('heading', { name: 'No matching files', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Clear search', exact: true }).click();
  await expect(page.getByPlaceholder('Search your files')).toHaveValue('');
  await page.getByRole('link', { name: 'Notifications', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'No notifications', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Back to My Drive', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole('heading', { name: 'This folder is empty', exact: true }),
  ).toBeVisible();
  if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth))
    throw new Error('Mobile empty state horizontal overflow');
  await page.screenshot({ path: 'test-results/ui-redesign/web-empty-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  failShared = true;
  await page.reload();
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('link', { name: 'Shared', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'This view couldn’t be loaded.', exact: true }),
  ).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole('heading', { name: 'No shared files', exact: true })).toHaveCount(
    0,
  );
  failShared = false;
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'No shared files', exact: true }),
  ).toBeVisible();
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(
    'PASS: web login, file list/grid, dialog focus and Escape, menu, persisted theme, mobile overflow',
  );
} finally {
  await browser.close();
}

const profile = await mkdtemp(path.join(os.tmpdir(), 'harbor-ui-'));
const app = await electron.launch({
  args: ['apps/desktop', `--user-data-dir=${profile}`],
  env: { ...process.env, HARBOR_DEV_AUTH: 'true', HARBOR_API_URL: 'http://127.0.0.1:8787' },
});
try {
  const desktop = await app.firstWindow();
  await expect(desktop.getByRole('heading', { name: 'Sign in to harbor0' })).toBeVisible();
  await desktop.waitForTimeout(250);
  await desktop.screenshot({ path: 'test-results/ui-redesign/desktop-login.png' });
  await app.evaluate(({ ipcMain }, fixtures) => {
    ipcMain.removeHandler('harbor:status');
    ipcMain.handle('harbor:status', () => ({
      ok: true,
      data: {
        signedIn: true,
        accountId: 'demo',
        roots: [{ id: 'one', mode: 'sync', localPathDisplayName: 'Projects', excluded: [] }],
        jobs: [],
        sync: { queued: 2, paused: false, message: 'Your folders are connected' },
      },
    }));
    let appearance: unknown;
    ipcMain.removeHandler('harbor:request');
    ipcMain.handle('harbor:request', async (_event, input) => {
      await new Promise((resolve) =>
        setTimeout(resolve, input.path.includes('/ideas/') ? 1200 : 500),
      );
      if (input.path === '/v1/users/me') {
        if (input.method === 'PATCH') appearance = input.body.appearance;
        return {
          ok: true,
          data: {
            user: { id: 'demo', appearance },
            storage: { usedBytes: 0, reservedBytes: 0, quotaBytes: 100000000000 },
          },
        };
      }
      if (input.path.includes('/work/')) return { ok: false, error: 'Could not reach the server.' };
      if (input.path.includes('/ideas/'))
        return {
          ok: true,
          data: { items: [{ ...fixtures[0], id: 'old', name: 'Old folder response' }] },
        };
      const last = input.path.includes('cursor=second');
      return {
        ok: true,
        data: { items: last ? [fixtures[2]] : fixtures, nextCursor: last ? null : 'second' },
      };
    });
  }, items);
  await desktop.reload();
  await expect(desktop.getByRole('heading', { name: 'My Drive', exact: true })).toBeVisible();
  await expect(desktop.getByRole('status', { name: 'Loading files', exact: true })).toBeVisible();
  await expect(desktop.locator('.empty-state')).toHaveCount(0);
  await desktop.screenshot({ path: 'test-results/ui-redesign/desktop-files-loading.png' });
  await expect(desktop.locator('.file-entry-row')).toHaveCount(4);
  await desktop.waitForTimeout(250);
  await desktop.screenshot({ path: 'test-results/ui-redesign/desktop-light.png' });
  await desktop.getByRole('button', { name: 'New folder', exact: true }).click();
  await expect(desktop.getByRole('textbox', { name: 'Folder name', exact: true })).toBeFocused();
  await desktop.keyboard.press('Escape');
  await desktop.getByRole('button', { name: 'Switch to dark theme' }).click();
  await expect(desktop.locator('html')).toHaveClass('dark');
  await desktop.waitForTimeout(250);
  await desktop.screenshot({ path: 'test-results/ui-redesign/desktop-dark.png' });
  // Drive loads all result pages before applying folder-wide sorting.
  await expect(desktop.locator('.file-entry-row')).toHaveCount(4);
  await desktop
    .getByRole('button', { name: 'Actions for Brand guidelines.pdf', exact: true })
    .click();
  await desktop.getByRole('menuitem', { name: 'Rename', exact: true }).click();
  await expect(desktop.getByRole('dialog')).toBeVisible();
  await desktop.keyboard.press('Escape');
  await desktop.getByRole('button', { name: 'Work documents', exact: true }).click();
  await expect(
    desktop.getByRole('heading', { name: 'We couldn’t load these files.' }),
  ).toBeVisible();
  await expect(desktop.locator('.file-entry-row')).toHaveCount(0);
  await desktop.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(desktop.getByRole('status', { name: 'Loading files', exact: true })).toBeVisible();
  await expect(
    desktop.getByRole('heading', { name: 'We couldn’t load these files.' }),
  ).toBeVisible();
  await desktop
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'My Drive', exact: true })
    .click();
  await expect(desktop.locator('.file-entry-row')).toHaveCount(4);
  await desktop.getByRole('button', { name: 'Creative projects', exact: true }).click();
  await expect(desktop.getByRole('status', { name: 'Loading files', exact: true })).toBeVisible();
  await desktop
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Favorites', exact: true })
    .click();
  await expect(desktop.locator('.file-entry-row')).toHaveCount(4);
  await desktop.waitForTimeout(1300);
  await expect(
    desktop.getByRole('button', { name: 'Old folder response', exact: true }),
  ).toHaveCount(0);
  console.log(
    'PASS: file skeletons, table metadata, selection, desktop pagination, retry, stale response protection',
  );
  await desktop.getByRole('button', { name: 'Sync', exact: true }).click();
  await expect(
    desktop.getByRole('heading', { name: 'Folders synced on this computer' }),
  ).toBeVisible();
  await checkAppearance(desktop, 'desktop');
  await desktop.getByRole('button', { name: 'Reset light colors', exact: true }).click();
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('harbor:status');
    ipcMain.handle('harbor:status', () => ({
      ok: true,
      data: {
        signedIn: true,
        accountId: 'demo',
        roots: [],
        jobs: [],
        sync: { queued: 0, paused: false, message: 'Ready to connect a folder' },
      },
    }));
    ipcMain.removeHandler('harbor:request');
    let appearance: unknown;
    ipcMain.handle('harbor:request', async (_event, input) => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      if (input.path === '/v1/users/me') {
        if (input.method === 'PATCH') appearance = input.body.appearance;
        return {
          ok: true,
          data: {
            user: { id: 'demo', appearance },
            storage: { usedBytes: 0, reservedBytes: 0, quotaBytes: 100000000000 },
          },
        };
      }
      return { ok: true, data: { items: [], nextCursor: null } };
    });
  });
  await desktop.reload();
  await checkEmptyViews(desktop, 'desktop');
  await desktop
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Backups', exact: true })
    .click();
  await expect(
    desktop.getByRole('heading', { name: 'No backup folders', exact: true }),
  ).toBeVisible();
  await expect(desktop.getByRole('button', { name: 'Choose folder', exact: true })).toBeVisible();
  await desktop.screenshot({
    path: 'test-results/ui-redesign/desktop-empty-backups.png',
    fullPage: true,
  });
  await desktop
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Sync', exact: true })
    .click();
  await expect(
    desktop.getByRole('heading', {
      name: 'Choose what stays synced on this computer',
      exact: true,
    }),
  ).toBeVisible();
  console.log('PASS: native Electron login, file list, dialog focus, theme, sync navigation');
} finally {
  await app.close();
  await rm(profile, { recursive: true, force: true });
}
