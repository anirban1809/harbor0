// Captures the landing page's product screenshots from the desktop app, with mocked data.
// Build the desktop app first: npm run build -w @harbor/desktop
import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
const output = path.resolve('apps/landing/app/shots');
const profile = await mkdtemp(path.join(os.tmpdir(), 'harbor-landing-shots-'));
const app = await electron.launch({
  args: ['apps/desktop', `--user-data-dir=${profile}`],
  env: { ...process.env, HARBOR_DEV_AUTH: 'true', HARBOR_API_URL: 'http://127.0.0.1:1' },
});
try {
  const page = await app.firstWindow();
  await expect(page.getByRole('heading', { name: 'Sign in to harbor0' })).toBeVisible();
  await app.evaluate('globalThis.__name = (fn) => fn');
  await app.evaluate(({ ipcMain }) => {
    const item = (
      id: string,
      name: string,
      type: 'FILE' | 'FOLDER',
      sizeBytes: number,
      day: number,
      extra: object = {},
    ) => ({
      id,
      ownerUserId: 'alex',
      parentId: null,
      type,
      name,
      normalizedName: name.toLowerCase(),
      mimeType: type === 'FOLDER' ? null : 'application/octet-stream',
      sizeBytes,
      currentVersionId: type === 'FOLDER' ? null : 'v-' + id,
      revision: 1,
      favorite: false,
      createdAt: `2026-09-${day}T09:00:00Z`,
      updatedAt: `2026-09-${day}T09:00:00Z`,
      deletedAt: null,
      ...extra,
    });
    const drive = [
      item('creative', 'Creative projects', 'FOLDER', 0, 25),
      item('work', 'Work documents', 'FOLDER', 0, 22),
      item('brand', 'Brand guidelines.pdf', 'FILE', 2.4e6, 24, {
        mimeType: 'application/pdf',
        favorite: true,
      }),
      item('weekend', 'Weekend in the mountains.jpg', 'FILE', 8.2e6, 21, {
        mimeType: 'image/jpeg',
      }),
      item('notes', 'Meeting notes.md', 'FILE', 18400, 19, { mimeType: 'text/markdown' }),
      item('budget', 'Q4 budget.xlsx', 'FILE', 684000, 12),
    ];
    const archive = [
      item('research', 'Research', 'FOLDER', 0, 26, { parentId: 'cloud1' }),
      item('project-notes', 'Project notes.md', 'FILE', 2400, 28, {
        parentId: 'cloud1',
        mimeType: 'text/markdown',
      }),
      item('proposal', 'Proposal.docx', 'FILE', 412000, 27, { parentId: 'cloud1' }),
      item('invoice', 'Invoice template.xlsx', 'FILE', 96000, 23, { parentId: 'cloud1' }),
    ];
    const backup = {
      id: 'backup1',
      state: 'ACTIVE',
      deviceId: 'device1',
      localPathDisplayName: 'Documents',
      remoteRootDriveItemId: 'cloud1',
      createdAt: '2026-09-20T08:00:00Z',
    };
    const entry = (id: string, displayName: string, itemType: string, mimeType: string | null) => ({
      id,
      sourceDriveItemId: id,
      sourceVersionId: null,
      displayName,
      relativePath: displayName,
      parentEntryId: null,
      itemType,
      sizeBytes: 0,
      mimeType,
      contentHash: null,
      storageObjectId: null,
    });
    const transfer = (id: string, sender: object, totalSizeBytes: number, extra: object) => ({
      id,
      senderUserId: id,
      recipientUserId: 'alex',
      recipientEmail: null,
      state: 'PENDING',
      createdAt: '2026-09-27T09:00:00Z',
      acceptedAt: null,
      declinedAt: null,
      cancelledAt: null,
      expiresAt: null,
      totalSizeBytes,
      savedAt: null,
      preparationState: 'READY',
      sender,
      recipient: { displayName: 'Alex Morgan', username: 'alex' },
      ...extra,
    });
    const transfers = [
      transfer('t1', { displayName: 'Bob Carter', username: 'bob' }, 12.4e6, {
        expiresAt: '2026-10-04T09:00:00Z',
        items: [
          entry('e1', 'Contract draft.pdf', 'FILE', 'application/pdf'),
          entry('e2', 'Site photos', 'FOLDER', null),
        ],
      }),
      transfer('t2', { displayName: 'Dana Lee', username: 'dana' }, 840000, {
        state: 'ACCEPTED',
        createdAt: '2026-09-24T09:00:00Z',
        acceptedAt: '2026-09-24T10:00:00Z',
        savedAt: '2026-09-24T10:00:00Z',
        saveState: 'SAVED',
        items: [entry('e3', 'Logo.png', 'FILE', 'image/png')],
      }),
    ];
    const invitations = [
      {
        id: 'share1',
        driveItemId: 'handbook',
        name: 'Team handbook',
        direction: 'RECEIVED',
        ownerUserId: 'bob',
        recipientUserId: 'alex',
        permission: 'EDITOR',
        syncState: 'PENDING',
        createdAt: '2026-09-29T09:00:00Z',
        revokedAt: null,
        owner: { username: 'bob', displayName: 'Bob Carter' },
        recipient: { username: 'alex', displayName: 'Alex Morgan' },
      },
    ];
    const now = new Date().toISOString();
    const root = (id: string, name: string, diskSizeBytes: number, extra: object = {}) => ({
      id,
      mode: 'sync',
      remoteId: id + '-cloud',
      cloudPath: 'My Drive / ' + name,
      localPath: '/Users/alex/' + name,
      localPathDisplay: '~/' + name,
      localPathDisplayName: name,
      diskSizeBytes,
      fileCount: 120,
      folderCount: 8,
      paused: false,
      excluded: [],
      lastSyncedAt: now,
      ...extra,
    });
    const status = {
      configured: true,
      signedIn: true,
      accountId: 'alex',
      deviceName: 'Alex’s MacBook Pro',
      roots: [
        root('projects', 'Projects', 482e6),
        root('photos', 'Photos', 6.3e9),
        root('design', 'Design assets', 1.92e9, { shareId: 'share0' }),
        root('local1', 'Documents', 96e6, {
          mode: 'backup',
          remoteId: 'cloud1',
          backupId: 'backup1',
        }),
      ],
      jobs: [],
      sync: {
        running: false,
        paused: false,
        online: true,
        message: 'Everything is up to date',
        queued: 0,
        lastSync: now,
        active: null,
        issues: [],
        recent: [],
      },
    };
    (globalThis as any).__shots = status;
    const sent = [
      transfer('t3', { displayName: 'Alex Morgan', username: 'alex' }, 3.1e6, {
        recipient: { displayName: 'Priya Shah', username: 'priya' },
        expiresAt: '2026-10-28T09:00:00Z',
        createdAt: '2026-09-28T09:00:00Z',
        items: [entry('e4', 'Brand guidelines.pdf', 'FILE', 'application/pdf')],
      }),
      transfer('t4', { displayName: 'Alex Morgan', username: 'alex' }, 64.5e6, {
        recipient: { displayName: 'Bob Carter', username: 'bob' },
        state: 'ACCEPTED',
        createdAt: '2026-09-22T09:00:00Z',
        acceptedAt: '2026-09-22T12:00:00Z',
        expiresAt: '2026-10-22T09:00:00Z',
        items: [entry('e5', 'Launch video', 'FOLDER', null)],
      }),
      transfer('t5', { displayName: 'Alex Morgan', username: 'alex' }, 684000, {
        recipient: null,
        recipientUserId: null,
        recipientEmail: 'sam@example.test',
        state: 'PENDING_RECIPIENT_SIGNUP',
        createdAt: '2026-09-20T09:00:00Z',
        expiresAt: '2026-10-20T09:00:00Z',
        items: [entry('e6', 'Q4 budget.xlsx', 'FILE', null)],
      }),
    ];
    const api = (raw: string) => {
      const p = new URL(raw, 'http://fixture').pathname;
      if (p === '/v1/users/me')
        return {
          user: { id: 'alex', email: 'alex@example.test', username: 'alex', displayName: 'Alex' },
          storage: {
            quotaBytes: 1e11,
            usedBytes: 24.8e9,
            availableBytes: 75.2e9,
            reservedBytes: 0,
          },
        };
      if (p === '/v1/drive/folders/root/children') return { items: drive, nextCursor: null };
      if (p === '/v1/drive/folders/cloud1/children') return { items: archive, nextCursor: null };
      if (p === '/v1/drive/items/cloud1')
        return { item: item('cloud1', 'Documents', 'FOLDER', 0, 20) };
      if (p === '/v1/backups') return { items: [backup] };
      if (p === '/v1/transfers/received') return { items: transfers, nextCursor: null };
      if (p === '/v1/transfers/sent') return { items: sent, nextCursor: null };
      if (p === '/v1/sync/shares') return { items: invitations };
      if (p.endsWith('/runs'))
        return {
          items: [
            {
              id: 'run1',
              rootId: 'backup1',
              deviceId: 'device1',
              trigger: 'AUTOMATIC',
              state: 'COMPLETED',
              startedAt: now,
              completedAt: now,
              fileCount: 4,
              sizeBytes: 510400,
            },
          ],
          nextCursor: null,
        };
      if (p.endsWith('/files'))
        return {
          items: archive
            .filter((file) => file.type === 'FILE')
            .map((file) => ({
              relativePath: file.name,
              itemId: file.id,
              versionId: 'v3',
              sizeBytes: file.sizeBytes,
              modifiedAt: file.updatedAt,
              savedAt: now,
            })),
          nextCursor: null,
        };
      if (p.endsWith('/versions'))
        return {
          items: [3, 2, 1].map((versionNumber) => ({
            id: 'v' + versionNumber,
            versionNumber,
            sizeBytes: 800 * versionNumber,
            createdAt: `2026-09-${25 + versionNumber}T09:00:00Z`,
          })),
        };
      return { items: [], nextCursor: null };
    };
    const handler = (name: string, fn: (input: any) => any) => {
      ipcMain.removeHandler('harbor:' + name);
      ipcMain.handle('harbor:' + name, (_event, input) => ({ ok: true, data: fn(input) }));
    };
    handler('status', () => status);
    handler('request', (input) => api(input.path));
  });
  await page.reload();
  // Zooming a double-sized window gives a 1280 x 860 layout at twice the pixel density.
  await page.setViewportSize({ width: 2560, height: 1720 });
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(2),
  );
  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  await expect(nav).toBeVisible();
  // The sidebar is cut off, so each screenshot shows only the page itself.
  const sidebar = await page.evaluate(
    () => document.querySelector('.sidebar')!.getBoundingClientRect().right / innerWidth,
  );
  async function capture(name: string) {
    await page.mouse.move(0, 0);
    for (const theme of ['light', 'dark']) {
      await page.evaluate(
        (dark) => document.documentElement.classList.toggle('dark', dark),
        theme === 'dark',
      );
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(400);
      const shot = sharp(await page.screenshot());
      const { width, height } = await shot.metadata();
      const left = Math.ceil(width! * sidebar);
      await shot
        .extract({ left, top: 0, width: width! - left, height: height! })
        .toFile(path.join(output, `${name}-${theme}.png`));
    }
    await page.evaluate(() => document.documentElement.classList.remove('dark'));
  }
  await expect(page.getByText('Brand guidelines.pdf')).toBeVisible();
  await capture('drive');
  await page.getByRole('button', { name: 'Actions for Brand guidelines.pdf', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Version history', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Version 3');
  await capture('drive-versions');
  await page.keyboard.press('Escape');
  await nav.getByRole('button', { name: 'Sync', exact: true }).click();
  await expect(page.getByRole('heading', { name: /^Sync on/ })).toBeVisible();
  await capture('sync');
  await nav.getByRole('button', { name: 'Shared', exact: true }).click();
  await expect(page.getByText('Contract draft.pdf')).toBeVisible();
  await capture('shared');
  await page.getByRole('tab', { name: 'Sent', exact: true }).click();
  await expect(page.getByText('Launch video')).toBeVisible();
  await capture('shared-sent');
  await nav.getByRole('button', { name: 'Backups', exact: true }).click();
  await page.locator('.backup-folder-row').filter({ hasText: 'Documents' }).click();
  await page.getByRole('button', { name: 'Project notes.md' }).click();
  await expect(page.getByText(/^Version 1 ·/)).toBeVisible();
  await capture('backups');
  await page.keyboard.press('Escape');
  await page.getByRole('tab', { name: /^History/ }).click();
  await page.getByRole('button', { name: /Automatic backup/ }).click();
  await expect(page.locator('.backup-run-files')).toContainText('Proposal.docx');
  await capture('backups-history');
  console.log('Saved the landing screenshots to ' + output);
} finally {
  await app.close();
  await rm(profile, { recursive: true, force: true });
}
