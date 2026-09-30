import { _electron as electron, expect, type Page } from '@playwright/test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Deterministic, isolated UI fixtures. No real account or local folders are changed.
const profile = await mkdtemp(path.join(os.tmpdir(), 'harbor-layout-'));
const evidence = path.resolve('test-results/desktop-layout');
await mkdir(evidence, { recursive: true });
const app = await electron.launch({
  args: ['apps/desktop', `--user-data-dir=${profile}`],
  env: {
    ...process.env,
    HARBOR_DEV_AUTH: 'false',
    HARBOR_API_URL: 'https://layout.invalid',
    HARBOR_COGNITO_DOMAIN: 'https://auth.invalid',
    HARBOR_COGNITO_CLIENT_ID: 'fixture',
  },
});
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  for (const box of await page.locator('main .panel').all()) {
    expect(await box.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  }
}
async function size(width: number, height: number) {
  await app.evaluate(
    ({ BrowserWindow }, { width, height }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(width, height),
    { width, height },
  );
}
try {
  const page = await app.firstWindow();
  const failures: string[] = [];
  page.on('pageerror', (error) => failures.push(error.message));
  await expect(page.getByRole('heading', { name: 'Sign in to harbor0' })).toBeVisible();
  await page.screenshot({ path: path.join(evidence, 'login.png') });
  await size(840, 620);
  await noOverflow(page);
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeInViewport();
  await page.screenshot({ path: path.join(evidence, 'login-compact.png') });
  await size(1280, 860);
  await app.evaluate(({ ipcMain }) => {
    const roots = [
      {
        id: 'sync',
        mode: 'sync',
        localPath: '/Users/demo/Projects',
        localPathDisplayName: 'Projects',
        fileCount: 1248,
        folderCount: 38,
        paused: false,
        excluded: ['node_modules', '.git'],
        remoteId: null,
      },
      {
        id: 'backup',
        mode: 'backup',
        localPath: '/Users/demo/Documents/Client archive',
        localPathDisplayName: 'Client archive',
        fileCount: 632,
        folderCount: 17,
        paused: false,
        excluded: ['Temporary exports'],
        remoteId: null,
      },
    ];
    const fixture = {
      signedIn: true,
      configured: true,
      accountId: 'demo',
      roots,
      jobs: [
        {
          id: '1',
          rootId: 'sync',
          relativePath: 'Website/Design specifications.pdf',
          kind: 'upsert',
          error: null,
          attempts: 0,
        },
        {
          id: '2',
          rootId: 'backup',
          relativePath: 'September/Client proposal.pdf',
          kind: 'upsert',
          error: 'Could not reach the server. Will retry when connected.',
          attempts: 2,
        },
      ],
      sync: {
        queued: 2,
        paused: false,
        online: true,
        running: false,
        lastSync: new Date().toISOString(),
        message: 'Your folders are connected',
      },
    };
    (globalThis as any).__layoutFixture = fixture;
    ipcMain.removeHandler('harbor:status');
    ipcMain.handle('harbor:status', () => ({ ok: true, data: fixture }));
    ipcMain.removeHandler('harbor:request');
    ipcMain.handle('harbor:request', (_event, input) => {
      if (input.path === '/v1/users/me')
        return {
          ok: true,
          data: {
            user: {
              id: 'demo',
              displayName: 'UI Preview',
              username: 'preview',
              email: 'preview@example.test',
            },
            storage: {
              usedBytes: 24567890123,
              quotaBytes: 100000000000,
              reservedBytes: 125000000,
              availableBytes: 75307109877,
            },
          },
        };
      if (input.path === '/v1/devices')
        return {
          ok: true,
          data: { items: [{ id: 'device', name: 'MacBook Pro', platform: 'MACOS' }] },
        };
      return { ok: true, data: { items: [], nextCursor: null } };
    });
  });
  await page.reload();
  const navigate = (name: string) =>
    page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('button', { name, exact: true })
      .click();
  await navigate('Storage');
  await expect(page.getByText('24.57% used', { exact: true })).toBeVisible();
  await expect(
    page.getByText('24,567,890,123 of 100,000,000,000 bytes', { exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: path.join(evidence, 'home.png') });
  for (const section of ['Shared', 'Trash', 'Backups', 'Devices', 'Sync', 'Storage', 'Settings']) {
    await navigate(section);
    await expect(
      page.getByRole('heading', {
        name: section === 'Sync' ? 'Sync on this computer' : section,
        exact: true,
      }),
    ).toBeVisible();
    await noOverflow(page);
    if (section === 'Backups') {
      await expect(page.getByText('632', { exact: true }).first()).toBeVisible();
      await expect(page.getByText('September/Client proposal.pdf', { exact: true })).toBeVisible();
      await expect(
        page.getByText('Website/Design specifications.pdf', { exact: true }),
      ).toHaveCount(0);
    }
    if (section === 'Sync') {
      await expect(page.getByRole('columnheader', { name: 'Folder size' })).toBeVisible();
      await expect(page.getByText('/Users/demo/Projects', { exact: true })).toBeVisible();
      await expect(page.getByRole('tab', { name: 'Activity', exact: true })).toHaveCount(0);
      await expect(page.locator('.sync-page').getByRole('tablist')).toHaveCount(0);
      await page.getByRole('button', { name: 'Manage Projects', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Folder details', exact: true }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await page.keyboard.press('Escape');
    }
    await page.screenshot({
      path: path.join(evidence, section.toLowerCase().replaceAll(' ', '-') + '.png'),
      fullPage: true,
    });
  }
  await navigate('Sync');
  await page.getByRole('button', { name: 'Switch to dark theme' }).click();
  await expect(page.getByRole('button', { name: 'Open folder', exact: true })).toHaveCSS(
    'color',
    await page
      .getByRole('heading', { name: 'Sync on this computer', exact: true })
      .evaluate((el) => window.getComputedStyle(el).color),
  );
  await page.screenshot({ path: path.join(evidence, 'sync-dark.png'), fullPage: true });
  await page.getByRole('button', { name: 'Switch to light theme' }).click();
  await size(840, 620);
  for (const section of [
    'My Drive',
    'Shared',
    'Trash',
    'Backups',
    'Devices',
    'Sync',
    'Storage',
    'Settings',
  ]) {
    await navigate(section);
    await noOverflow(page);
    await expect(
      page.getByRole('navigation').getByRole('button', { name: 'Settings', exact: true }),
    ).toBeInViewport();
  }
  await navigate('Sync');
  await page.screenshot({ path: path.join(evidence, 'sync-compact.png'), fullPage: true });
  await app.evaluate(() => {
    const fixture = (globalThis as any).__layoutFixture;
    fixture.roots[0].paused = true;
    fixture.sync.online = false;
  });
  await navigate('Devices');
  await navigate('Sync');
  await expect(
    page.getByText('You’re offline. Changes will sync when the connection returns.', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator('.sync-folder-state')).toHaveText('Paused');
  await app.evaluate(() => {
    const fixture = (globalThis as any).__layoutFixture;
    fixture.roots = [];
    fixture.jobs = [];
  });
  await navigate('Backups');
  await expect(page.getByRole('heading', { name: 'No backup folders' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Choose folder' })).toBeVisible();
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('harbor:request');
    ipcMain.handle('harbor:request', (_event, input) =>
      input.path === '/v1/users/me'
        ? { ok: false, error: 'Offline' }
        : { ok: true, data: { items: [] } },
    );
  });
  await page.reload();
  await navigate('Storage');
  await expect(page.getByRole('button', { name: 'Retry storage' })).toBeVisible();
  expect(failures).toEqual([]);
  console.log(
    'PASS: login, all ten desktop pages, exact storage, folder metrics, filtered activity, options, empty/offline/paused states, storage failure, dark mode, and compact layout',
  );
} finally {
  await app.close();
  await rm(profile, { recursive: true, force: true });
}
