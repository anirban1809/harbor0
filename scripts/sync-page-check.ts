import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const directory = await mkdtemp(path.join(os.tmpdir(), 'harbor-sync-ui-'));
const evidence = path.resolve('test-results/sync-page');
await mkdir(evidence, { recursive: true });
const app = await electron.launch({
  args: ['apps/desktop', `--user-data-dir=${directory}`],
  env: { ...process.env, HARBOR_DEV_AUTH: 'true', HARBOR_API_URL: 'http://127.0.0.1:1' },
});
try {
  const page = await app.firstWindow();
  await expect(page.getByRole('heading', { name: 'Sign in to harbor0' })).toBeVisible();
  const failures: string[] = [];
  page.on('pageerror', (error) => failures.push(error.message));
  await app.evaluate('globalThis.__name = (fn) => fn');
  await app.evaluate(({ ipcMain }) => {
    const g = globalThis as any;
    const root = {
      id: 'editor',
      mode: 'sync',
      remoteId: 'editor-cloud',
      cloudPath: 'My Drive / Projects / editor',
      localPath: '/Users/demo/Documents/Code/editor',
      localPathDisplay: '~/Documents/Code/editor',
      localPathDisplayName: 'editor',
      fileCount: 5,
      folderCount: 0,
      paused: false,
      excluded: [],
      lastSyncedAt: new Date().toISOString(),
    };
    const sync = {
      running: false,
      paused: false,
      online: true,
      message: 'Everything is up to date',
      queued: 0,
      lastSync: new Date().toISOString(),
      active: null,
      issues: [],
      recent: [],
    };
    g.__syncUI = {
      root,
      calls: [],
      items: [
        {
          id: 'notes',
          parentId: 'editor-cloud',
          name: 'Notes.md',
          type: 'FILE',
          mimeType: 'text/markdown',
          sizeBytes: 24,
          updatedAt: '2026-09-27T10:00:00Z',
        },
        { id: 'docs', parentId: 'editor-cloud', name: 'Docs', type: 'FOLDER', sizeBytes: 0 },
        {
          id: 'guide',
          parentId: 'docs',
          name: 'Guide.md',
          type: 'FILE',
          mimeType: 'text/markdown',
          sizeBytes: 12,
        },
      ],
      data: {
        configured: true,
        signedIn: true,
        deviceName: 'MacBook Pro',
        roots: [root],
        jobs: [],
        sync,
      },
    };
    const handler = (name: string, fn: (input: any) => any) => {
      ipcMain.removeHandler('harbor:' + name);
      ipcMain.handle('harbor:' + name, (_event, input) => ({ ok: true, data: fn(input) }));
    };
    handler('status', () => g.__syncUI.data);
    handler('request', (input) =>
      input.path === '/v1/users/me'
        ? {
            user: {
              id: 'sync-ui',
              displayName: 'Sync Tester',
              username: 'sync',
              email: 'sync@example.test',
            },
            storage: {
              usedBytes: 10,
              quotaBytes: 100000000000,
              reservedBytes: 0,
              availableBytes: 99999999990,
            },
          }
        : {
            items: (g.__syncUI.items ?? []).filter(
              (item: any) => input.path === `/v1/drive/folders/${item.parentId ?? 'root'}/children`,
            ),
            nextCursor: null,
          },
    );
    handler('previewText', () => ({ text: '# Sync browser preview', truncated: false }));
    handler('download', (input) => {
      g.__syncUI.calls.push({ action: 'download', ...input });
      return {};
    });
    handler('pause', (input) => {
      g.__syncUI.data.sync.paused = input.paused;
      return input;
    });
    handler('selectSyncLocal', () => ({
      selectionId: 'selection',
      path: '/Users/demo/Documents/New project',
      name: 'New project',
    }));
    handler('syncCloudFolders', (input) => ({
      location:
        input.parentId === 'editor-cloud'
          ? {
              id: 'editor-cloud',
              name: 'editor',
              path: 'My Drive / Projects / editor',
              trail: [
                { id: 'projects', name: 'Projects' },
                { id: 'editor-cloud', name: 'editor' },
              ],
            }
          : input.parentId === 'projects'
            ? {
                id: 'projects',
                name: 'Projects',
                path: 'My Drive / Projects',
                trail: [{ id: 'projects', name: 'Projects' }],
              }
            : { id: null, name: 'My Drive', path: 'My Drive', trail: [] },
      items:
        input.parentId === 'editor-cloud'
          ? []
          : input.parentId === 'projects'
            ? [{ id: 'editor-cloud', name: 'editor', type: 'FOLDER' }]
            : [{ id: 'projects', name: 'Projects', type: 'FOLDER' }],
      nextCursor: null,
    }));
    handler('addSyncRoot', (input) => {
      g.__syncUI.calls.push({ action: 'add', ...input });
      return { id: 'new' };
    });
    handler('rootSettings', (input) => {
      Object.assign(
        g.__syncUI.data.roots.find((root: any) => root.id === input.id),
        input,
      );
      return {};
    });
    handler('stopSyncRoot', (input) => {
      g.__syncUI.calls.push({ action: 'stop', ...input });
      g.__syncUI.data.roots = g.__syncUI.data.roots.filter((root: any) => root.id !== input.id);
      return {};
    });
    handler('changeSyncLocal', (input) => {
      g.__syncUI.calls.push({ action: 'location', ...input });
      return {};
    });
    handler('reveal', (input) => {
      g.__syncUI.calls.push({ action: 'reveal', ...input });
      return {};
    });
    handler('reviewSyncConflict', (input) => {
      g.__syncUI.calls.push({ action: 'review', ...input });
      return {};
    });
    handler('dismissSyncConflict', (input) => {
      g.__syncUI.data.sync.issues = g.__syncUI.data.sync.issues.filter(
        (issue: any) => issue.id !== input.id,
      );
      return {};
    });
  });
  await page.reload();
  async function syncPage() {
    await page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('button', { name: 'My Drive', exact: true })
      .click();
    await page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('button', { name: 'Sync', exact: true })
      .click();
    await expect(page.getByRole('heading', { name: 'Sync on MacBook Pro' })).toBeVisible();
  }
  async function screenshot(name: string) {
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({
      path: path.join(evidence, name + '.png'),
      fullPage: true,
      animations: 'disabled',
    });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  }
  await syncPage();
  const filesTab = page.getByRole('tab', { name: 'Files', exact: true });
  const activityTab = page.getByRole('tab', { name: 'Activity', exact: true });
  await expect(page.getByRole('tab')).toHaveText(['Files', 'Activity']);
  await expect(filesTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel', { name: 'Activity', exact: true })).toBeHidden();
  await filesTab.focus();
  await page.keyboard.press('ArrowRight');
  await expect(activityTab).toBeFocused();
  await expect(activityTab).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Home');
  await expect(filesTab).toBeFocused();
  // Browse synced folders without leaving Sync, retaining the location across tabs.
  await page.getByRole('button', { name: 'editor', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Notes.md', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Notes.md', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('# Sync browser preview');
  await page.getByRole('button', { name: 'Close preview' }).click();
  await page.getByRole('button', { name: 'Download Notes.md', exact: true }).click();
  expect(await app.evaluate(() => (globalThis as any).__syncUI.calls.at(-1))).toMatchObject({
    action: 'download',
    driveItemId: 'notes',
  });
  await page.getByRole('button', { name: 'Docs', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Guide.md', exact: true })).toBeVisible();
  await activityTab.click();
  await expect(page.getByRole('heading', { name: 'Sync activity', exact: true })).toBeVisible();
  await filesTab.click();
  await expect(page.getByRole('button', { name: 'Guide.md', exact: true })).toBeVisible();
  await screenshot('files-browser');
  await page.getByRole('button', { name: 'Synced folders', exact: true }).click();
  await page.getByRole('button', { name: 'Manage editor', exact: true }).click();
  await page.getByRole('menuitem', { name: 'View sync activity', exact: true }).click();
  await expect(activityTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('button', { name: 'Show all folders' })).toBeVisible();
  await page.getByRole('button', { name: 'Show all folders' }).click();
  await filesTab.click();
  await expect(
    page.getByRole('region', { name: 'Synced folders', exact: true }).locator('th'),
  ).toHaveText([
    'Folder',
    'Local location',
    'Contents',
    'Status',
    'Last synced',
    'Changes',
    'Exclusions',
    'Actions',
  ]);
  await expect(page.locator('.sync-folder-row')).toHaveCount(1);
  await expect(page.locator('.sync-folder-row')).toContainText('5 files');
  await expect(page.locator('.sync-folder-row')).toContainText('0 subfolders');
  await expect(page.locator('.sync-folder-state')).toHaveText('Up to date');
  await expect(page.getByText('~/Documents/Code/editor', { exact: true })).toBeVisible();
  await expect(page.locator('.sync-summary')).toHaveCount(0);
  await expect(page.locator('.folder-metrics')).toHaveCount(0);
  await expect(page.getByText('Only the folders listed below', { exact: false })).toBeVisible();
  for (const [width, height] of [
    [1280, 860],
    [840, 620],
    [1440, 900],
  ]) {
    await app.evaluate(
      ({ BrowserWindow }, size) =>
        BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height),
      { width, height },
    );
    await screenshot('idle-' + width);
    await expect(
      page.getByRole('button', { name: 'Add folder to sync', exact: true }),
    ).toBeInViewport();
  }
  await page.getByRole('button', { name: 'Switch to dark theme' }).click();
  await screenshot('idle-dark');
  await page.getByRole('button', { name: 'Switch to light theme' }).click();
  await page.getByRole('button', { name: 'Pause sync', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Resume sync', exact: true })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('Changes are being queued');
  await page.getByRole('button', { name: 'Resume sync', exact: true }).click();
  // A local folder is the only selection needed to start syncing.
  await page.getByRole('button', { name: 'Add folder to sync', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: 'Start syncing' })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Choose local folder' }).click();
  await expect(dialog.getByRole('radio')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: /cloud folder/i })).toHaveCount(0);
  await expect(dialog).toContainText('Cloud copies are temporary');
  await expect(dialog.getByRole('button', { name: 'Start syncing' })).toBeEnabled();
  expect(
    await app.evaluate(
      () => (globalThis as any).__syncUI.calls.filter((call: any) => call.action === 'add').length,
    ),
  ).toBe(0);
  await screenshot('add-folder');
  await dialog.getByRole('button', { name: 'Start syncing' }).click();
  await expect(dialog).toHaveCount(0);
  expect(await app.evaluate(() => (globalThis as any).__syncUI.calls.at(-1))).toEqual({
    action: 'add',
    selectionId: 'selection',
  });
  // Accessible overflow menu, folder pause, and advanced settings.
  await page.getByRole('button', { name: 'Manage editor' }).focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('menuitem', { name: 'Pause folder sync', exact: true }),
  ).toBeVisible();
  await page.getByRole('menuitem', { name: 'Pause folder sync', exact: true }).click();
  await expect(page.locator('.sync-folder-state')).toContainText('Paused');
  await page.getByRole('button', { name: 'Manage editor' }).click();
  await page.getByRole('menuitem', { name: 'Resume folder sync', exact: true }).click();
  await page.getByRole('button', { name: 'Manage editor' }).click();
  await page.getByRole('menuitem', { name: 'Manage exclusions', exact: true }).click();
  await dialog.getByRole('textbox').fill('node_modules\n.git');
  await dialog.getByRole('button', { name: 'Save exclusions' }).click();
  await expect(page.getByText('2 exclusions', { exact: false })).toBeVisible();
  await app.evaluate(() => {
    (globalThis as any).__syncUI.data.sync.active = {
      rootId: 'editor',
      direction: 'download',
      relativePath: 'assets.zip',
      loaded: 1800000000,
      total: 4100000000,
    };
  });
  await syncPage();
  await activityTab.click();
  await expect(
    page.getByRole('region', { name: 'Current sync activity', exact: true }).locator('th'),
  ).toHaveText(['File', 'Folder', 'Operation', 'Progress', 'Status']);
  await expect(
    page.getByRole('progressbar', { name: 'Downloading assets.zip' }).first(),
  ).toHaveAttribute('value', '1800000000');
  await screenshot('downloading');
  for (const width of [840, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.locator('.sync-activity-table th')).toHaveCount(5);
    await screenshot(`activity-${width}`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('button', { name: 'Switch to dark theme' }).click();
  await screenshot('activity-dark');
  await page.getByRole('button', { name: 'Switch to light theme' }).click();
  // Queue changes reach both views through live IPC, without waiting for the poll.
  await app.evaluate(({ BrowserWindow }) => {
    const data = (globalThis as any).__syncUI.data;
    data.sync.active = null;
    data.sync.jobs = [
      {
        id: 'job',
        rootId: 'editor',
        relativePath: 'new/report.txt',
        kind: 'upsert',
        error: null,
        attempts: 0,
      },
      {
        id: 'delete-job',
        rootId: 'editor',
        relativePath: 'obsolete.txt',
        kind: 'delete',
        error: null,
        attempts: 0,
      },
      {
        id: 'retry-job',
        rootId: 'editor',
        relativePath: 'retry.txt',
        kind: 'upsert',
        error: 'Temporary connection error',
        attempts: 1,
      },
    ];
    data.sync.driveItems = [
      {
        id: 'local-sync:editor:new',
        localId: 'local-sync:editor:new',
        name: 'new',
        type: 'FOLDER',
        sizeBytes: 0,
        parentId: 'editor-cloud',
        localOnly: true,
        syncStatus: 'Pending',
      },
      {
        id: 'local-sync:editor:new%2Freport.txt',
        name: 'report.txt',
        type: 'FILE',
        sizeBytes: 1000,
        parentId: 'local-sync:editor:new',
        localOnly: true,
        syncStatus: 'Pending',
      },
    ];
    BrowserWindow.getAllWindows()[0].webContents.send('harbor:status', data.sync);
  });
  await expect(page.locator('.sync-queue')).toContainText('new/report.txt', { timeout: 2000 });
  await expect(page.locator('.sync-queue')).toContainText('Pending');
  await expect(page.getByRole('heading', { name: 'Sync activity', exact: true })).toBeInViewport();
  await expect(page.locator('.sync-activity-table tbody tr')).toHaveCount(3);
  await expect(
    page.locator('.sync-activity-table tr').filter({ hasText: 'obsolete.txt' }),
  ).toContainText('Delete');
  await expect(
    page.locator('.sync-activity-table tr').filter({ hasText: 'retry.txt' }),
  ).toContainText('Retry pending');
  await screenshot('pending-live');
  await filesTab.click();
  await page.getByRole('button', { name: 'editor', exact: true }).click();
  await expect(page.getByRole('button', { name: 'new', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'new', exact: true }).click();
  await expect(page.getByRole('button', { name: 'report.txt', exact: true })).toBeVisible();
  await expect(page.locator('.drive-sync-status')).toContainText('Pending');
  await expect(page.getByRole('button', { name: 'Actions for report.txt' })).toHaveCount(0);
  await screenshot('drive-pending');
  await app.evaluate(({ BrowserWindow }) => {
    const data = (globalThis as any).__syncUI.data;
    data.sync.active = {
      rootId: 'editor',
      relativePath: 'new/report.txt',
      direction: 'upload',
      loaded: 500,
      total: 1000,
    };
    data.sync.driveItems[1].syncStatus = 'Syncing';
    data.sync.driveItems[1].syncProgress = 50;
    BrowserWindow.getAllWindows()[0].webContents.send('harbor:status', data.sync);
  });
  await expect(page.locator('.drive-sync-status')).toContainText('Syncing · 50%', {
    timeout: 2000,
  });
  await screenshot('drive-syncing');
  // Creating the parent in the cloud keeps an already-open local folder browsable.
  await app.evaluate(({ BrowserWindow }) => {
    const data = (globalThis as any).__syncUI.data;
    data.sync.folderIds = { 'local-sync:editor:new': 'new-cloud' };
    data.sync.driveItems[0].id = 'new-cloud';
    data.sync.driveItems[0].localOnly = false;
    data.sync.driveItems[1].parentId = 'new-cloud';
    BrowserWindow.getAllWindows()[0].webContents.send('harbor:status', data.sync);
  });
  await expect(page.getByRole('button', { name: 'report.txt', exact: true })).toBeVisible();
  await app.evaluate(({ BrowserWindow }) => {
    const fixture = (globalThis as any).__syncUI;
    const item = {
      id: 'report-cloud',
      parentId: 'new-cloud',
      name: 'report.txt',
      type: 'FILE',
      sizeBytes: 1000,
      revision: 1,
    };
    fixture.items = [item];
    fixture.data.sync.jobs = [];
    fixture.data.sync.driveItems = [];
    fixture.data.sync.active = null;
    fixture.data.sync.recent = [
      {
        id: 'done',
        rootId: 'editor',
        relativePath: 'new/report.txt',
        direction: 'upload',
        at: new Date().toISOString(),
        item,
      },
    ];
    BrowserWindow.getAllWindows()[0].webContents.send('harbor:status', fixture.data.sync);
  });
  await expect(page.getByRole('button', { name: 'report.txt', exact: true })).toHaveCount(1);
  await expect(page.locator('.drive-sync-status')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Download report.txt' })).toBeVisible();
  await screenshot('drive-completed');
  await syncPage();
  await activityTab.click();
  await expect(page.locator('.sync-recent')).toContainText('new/report.txt');
  await expect(page.locator('.sync-recent')).toHaveAttribute('open', '');
  // Every actionable error has a visible recovery control.
  await app.evaluate(() => {
    const sync = (globalThis as any).__syncUI.data.sync;
    sync.active = null;
    sync.issues = [
      'CONFLICT',
      'FOLDER_MISSING',
      'PERMISSION_DENIED',
      'STORAGE_QUOTA_EXCEEDED',
      'DISK_FULL',
      'AUTH_INVALID',
    ].map((code, index) => ({
      id: String(index),
      rootId: 'editor',
      code,
      relativePath: code === 'CONFLICT' ? 'report.docx' : undefined,
      conflictPath: code === 'CONFLICT' ? 'report (Conflict).docx' : undefined,
      message: 'fixture',
      at: new Date().toISOString(),
    }));
  });
  await syncPage();
  for (const name of [
    'Review conflict',
    'Locate folder',
    'Grant access',
    'Manage storage',
    'Manage synced folders',
    'Sign in',
  ])
    await expect(
      page
        .getByRole('region', { name: 'Needs attention' })
        .getByRole('button', { name, exact: true }),
    ).toBeVisible();
  await screenshot('needs-attention');
  await activityTab.click();
  await page.getByRole('button', { name: 'Manage synced folders', exact: true }).click();
  await expect(filesTab).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: 'Review conflict' }).click();
  await expect(dialog).toContainText('does not delete or overwrite');
  await dialog.getByRole('button', { name: 'Show preserved file' }).click();
  await dialog.getByRole('button', { name: 'Mark reviewed' }).click();
  await expect(page.getByRole('button', { name: 'Review conflict' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Locate folder' }).click();
  await dialog.getByRole('button', { name: 'Choose local folder' }).click();
  await dialog.getByRole('button', { name: 'Use folder and resume' }).click();
  await expect(dialog).toHaveCount(0);
  await app.evaluate(() => {
    const sync = (globalThis as any).__syncUI.data.sync;
    sync.issues = [];
    sync.online = false;
  });
  await syncPage();
  await expect(page.getByRole('status')).toContainText('You’re offline');
  await screenshot('offline');
  await page.getByRole('button', { name: 'Manage editor' }).click();
  await page.getByRole('menuitem', { name: 'Remove from sync', exact: true }).click();
  await expect(dialog).toContainText(
    'Local folders and their contents are preserved on every device',
  );
  await screenshot('stop-confirmation');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(
    await app.evaluate(() =>
      (globalThis as any).__syncUI.calls.some((call: any) => call.action === 'stop'),
    ),
  ).toBe(false);
  await page.getByRole('button', { name: 'Manage editor' }).click();
  await page.getByRole('menuitem', { name: 'Remove from sync', exact: true }).click();
  await dialog.getByRole('button', { name: 'Remove from sync', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Choose what stays synced on this computer' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add your first sync folder' })).toBeVisible();
  await expect(filesTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('heading', { name: 'Sync activity', exact: true })).toBeHidden();
  await activityTab.click();
  await expect(page.getByRole('heading', { name: 'Sync activity', exact: true })).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Current sync activity', exact: true }),
  ).toHaveCount(0);
  await filesTab.click();
  await screenshot('empty');
  expect(failures).toEqual([]);
  console.log(
    'PASS: default Files tab, keyboard tab navigation, nested browsing, previews/downloads, shared activity tables, temporary cloud copy, local-only setup, pause/resume, accessible menus, recovery actions, conflicts, stop confirmation, empty state, live progress, dark mode, and three desktop sizes',
  );
} finally {
  await app.close();
  await rm(directory, { recursive: true, force: true });
}
