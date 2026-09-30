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
      diskSizeBytes: 24 * 1024 * 1024,
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
        accountId: 'sync-ui',
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
  await expect(page.locator('.sync-page').getByRole('tablist')).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Activity', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'editor', exact: true }).click();
  expect(await app.evaluate(() => (globalThis as any).__syncUI.calls.at(-1))).toMatchObject({
    action: 'reveal',
    rootId: 'editor',
  });
  await expect(page.locator('.sync-help')).toHaveCount(0);
  await page.getByRole('button', { name: 'Manage editor', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: 'View sync activity', exact: true })).toHaveCount(
    0,
  );
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(
    page.getByRole('region', { name: 'Synced folders', exact: true }).locator('th'),
  ).toHaveText(['Folder', 'Local location', 'Folder size', 'Status', 'Last synced']);
  await expect(page.locator('.sync-folder-row')).toHaveCount(1);
  await expect(page.locator('.sync-folders-table')).toHaveCSS('min-width', '760px');
  await expect(page.locator('.sync-folder-size')).toContainText('25.17 MB');
  await expect(page.locator('.sync-folder-state')).toHaveClass(/badge/);
  for (const [bytes, label] of [
    [undefined, 'Calculating…'],
    [null, 'Unavailable'],
    [0, '0 B'],
  ] as const) {
    await app.evaluate((_electron, bytes) => {
      (globalThis as any).__syncUI.data.roots[0].diskSizeBytes = bytes;
    }, bytes);
    await syncPage();
    await expect(page.locator('.sync-folder-size')).toHaveText(label);
  }
  await app.evaluate(() => {
    (globalThis as any).__syncUI.data.roots[0].diskSizeBytes = 24 * 1024 * 1024;
  });
  await syncPage();
  await expect(page.locator('.sync-folder-state')).toHaveText('Up to date');
  await expect(page.getByText('~/Documents/Code/editor', { exact: true })).toBeVisible();
  await expect(page.locator('.sync-summary')).toHaveCount(0);
  await expect(page.locator('.folder-metrics')).toHaveCount(0);
  await expect(page.getByText('Only the folders listed below', { exact: false })).toHaveCount(0);
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
  await expect(page.locator('.sync-status')).toContainText('Changes are being queued');
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
  expect(await app.evaluate(() => (globalThis as any).__syncUI.data.roots[0].excluded)).toEqual([
    'node_modules',
    '.git',
  ]);
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
  await expect(page.locator('.sync-folder-state')).toHaveText('Syncing');
  await screenshot('downloading');
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
  await expect(page.locator('.sync-folder-state')).toHaveText('Action required');
  await expect(page.getByRole('region', { name: 'Sync action required' })).toContainText(
    'Temporary connection error',
  );
  await screenshot('pending-live');
  await app.evaluate(({ BrowserWindow }) => {
    const data = (globalThis as any).__syncUI.data;
    data.sync.jobs = [];
    data.sync.active = null;
    data.sync.recent = [
      {
        id: 'done',
        rootId: 'editor',
        relativePath: 'new/report.txt',
        direction: 'upload',
        at: new Date().toISOString(),
      },
    ];
    BrowserWindow.getAllWindows()[0].webContents.send('harbor:status', data.sync);
  });
  await page.getByRole('button', { name: /Activity notifications/ }).click();
  await expect(page.locator('.activity-list')).toContainText('new/report.txt');
  await page.getByRole('button', { name: 'Close activity' }).click();
  // Every actionable error remains available in the global notifications drawer.
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
  await expect(page.locator('.sync-page .sync-problems')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Sync action required' })).toBeVisible();
  await screenshot('action-banner');
  await page.getByRole('button', { name: 'Dismiss sync banner' }).click();
  await expect(page.getByRole('region', { name: 'Sync action required' })).not.toContainText(
    'report.docx',
  );
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'My Drive', exact: true })
    .click();
  await expect(page.getByRole('region', { name: 'Sync action required' })).toHaveCount(0);
  await page.getByRole('button', { name: /Activity notifications/ }).click();
  await expect(page.getByRole('region', { name: 'Needs attention' })).toContainText('report.docx');
  await page.getByRole('button', { name: 'Close activity' }).click();
  await syncPage();
  await page.getByRole('button', { name: 'View all notifications (6)' }).click();
  for (const name of [
    'Review conflict',
    'Locate folder',
    'Grant access',
    'Manage storage',
    'Manage synced folders',
  ])
    await expect(
      page
        .getByRole('region', { name: 'Needs attention' })
        .getByRole('button', { name, exact: true }),
    ).toBeVisible();
  // An ended session returns to the sign-in screen by itself; no button signs the user out.
  await expect(page.getByRole('region', { name: 'Needs attention' })).toContainText(
    'Your session ended',
  );
  await expect(
    page.getByRole('region', { name: 'Needs attention' }).getByRole('button', { name: 'Sign in' }),
  ).toHaveCount(0);
  await screenshot('needs-attention');
  await page.getByRole('button', { name: 'Manage synced folders', exact: true }).click();
  await expect(page.locator('.sync-content')).toBeVisible();
  await page.getByRole('button', { name: /Activity notifications/ }).click();
  await page.getByRole('button', { name: 'Review conflict' }).click();
  await expect(dialog).toContainText('does not delete or overwrite');
  await dialog.getByRole('button', { name: 'Show preserved file' }).click();
  await dialog.getByRole('button', { name: 'Mark reviewed' }).click();
  await page.getByRole('button', { name: /Activity notifications/ }).click();
  await expect(page.getByRole('button', { name: 'Review conflict' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Locate folder' }).click();
  await dialog.getByRole('button', { name: 'Choose local folder' }).click();
  await dialog.getByRole('button', { name: 'Use folder and resume' }).click();
  await expect(dialog).toHaveCount(0);
  // The folder's own status explains itself: one blocked file offers no folder relocation.
  await app.evaluate(() => {
    const sync = (globalThis as any).__syncUI.data.sync;
    sync.issues = [
      {
        id: 'job:locked',
        jobId: 'locked',
        scope: 'item',
        rootId: 'editor',
        code: 'PERMISSION_DENIED',
        relativePath: 'locked.txt',
        message: 'fixture',
        at: new Date().toISOString(),
      },
      {
        id: 'kept',
        rootId: 'editor',
        code: 'FOLDER_RECOVERED',
        relativePath: 'plans',
        conflictPath: 'plans (Recovered by harbor0 2026-09-30 12.00.00)',
        message: 'fixture',
        at: new Date().toISOString(),
      },
    ];
  });
  await syncPage();
  await expect(page.locator('.sync-folder-state')).toHaveText('Action required');
  await page.getByRole('button', { name: /Action required\. Show details for editor/ }).click();
  await expect(dialog).toContainText('Needs attention');
  await expect(dialog).toContainText('locked.txt');
  await expect(dialog).toContainText('retries automatically');
  await expect(dialog.getByRole('button', { name: 'Grant access' })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Open local folder' })).toBeVisible();
  await screenshot('folder-problems');
  await dialog.getByRole('button', { name: 'Review kept folder' }).click();
  await expect(dialog).toContainText('Folder kept on this computer');
  await expect(dialog).toContainText('plans (Recovered by harbor0 2026-09-30 12.00.00)');
  await dialog.getByRole('button', { name: 'Mark reviewed' }).click();
  await expect(dialog).toHaveCount(0);
  await app.evaluate(() => {
    const sync = (globalThis as any).__syncUI.data.sync;
    sync.issues = [];
    sync.waiting = [{ rootId: 'editor', relativePath: 'video.mov' }];
  });
  await syncPage();
  await expect(page.locator('.sync-folder-state')).toHaveText('Waiting for another device');
  await expect(page.locator('.sync-status')).toContainText(
    '1 file is only on another linked device',
  );
  await screenshot('waiting-for-device');
  await app.evaluate(() => {
    const sync = (globalThis as any).__syncUI.data.sync;
    sync.issues = [];
    sync.waiting = [];
    sync.online = false;
  });
  await syncPage();
  await expect(page.locator('.sync-status')).toContainText('You’re offline');
  await screenshot('offline');
  await page.getByRole('button', { name: 'Manage editor' }).click();
  await page.getByRole('menuitem', { name: 'Stop syncing on all devices…', exact: true }).click();
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
  await page.getByRole('menuitem', { name: 'Stop syncing on all devices…', exact: true }).click();
  await dialog.getByRole('button', { name: 'Stop syncing on all devices', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Choose what stays synced on this computer' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add your first sync folder' })).toBeVisible();
  await expect(page.locator('.sync-content')).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Activity', exact: true })).toHaveCount(0);
  await screenshot('empty');
  expect(failures).toEqual([]);
  console.log(
    'PASS: Sync page without tab headers, global notifications, dismissible action banner, local folder opening and disk usage, temporary cloud copy, local-only setup, pause/resume, accessible menus, recovery actions, conflicts, stop confirmation, empty state, live progress, dark mode, and three desktop sizes',
  );
} finally {
  await app.close();
  await rm(directory, { recursive: true, force: true });
}
