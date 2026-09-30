import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { developmentExecutable } from '../apps/desktop/dev-runtime';

// Exercise the real main-process monitor, notification click, preload and renderer.
// Server and credentials are fixtures in a disposable profile. --native uses real
// OS notification delivery; the default simulates the OS for unattended checks.
const profile = await mkdtemp(path.join(os.tmpdir(), 'harbor-incoming-'));
const native = process.argv.includes('--native');
const entry = path.join(profile, 'entry.cjs');
await writeFile(
  entry,
  `
  const { safeStorage } = require('electron');
  safeStorage.isEncryptionAvailable = () => true;
  safeStorage.encryptString = (value) => Buffer.from(value);
  require(${JSON.stringify(path.resolve('apps/desktop/dist/main.cjs'))});
`,
);
const desktop = await electron.launch({
  ...(native ? { executablePath: await developmentExecutable() } : {}),
  args: [entry, `--user-data-dir=${profile}`],
  env: { ...process.env, HARBOR_DEV_AUTH: 'true', HARBOR_API_URL: 'http://127.0.0.1:8787' },
});
try {
  const page = await desktop.firstWindow();
  await expect(page.getByRole('heading', { name: 'Sign in to harbor0' })).toBeVisible();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await desktop.evaluate(({ Notification }, native) => {
    const state = globalThis as any;
    state.testNotifications = [];
    state.testResponses = [];
    state.testShown = 0;
    const originalShow = Notification.prototype.show;
    if (!native) Notification.isSupported = () => true;
    Notification.prototype.show = function () {
      state.testNotifications.push(this);
      this.once('show', () => state.testShown++);
      if (native) originalShow.call(this);
      else this.emit('show');
    };
    if (!native)
      Notification.prototype.close = function () {
        this.emit('close');
      };
    const transfer = {
      id: 'transfer',
      state: 'PENDING',
      displayNames: ['Project files'],
      items: [],
      sender: { displayName: 'Alice', username: 'alice' },
      recipient: { displayName: 'Bob', username: 'bob' },
      createdAt: new Date().toISOString(),
      expiresAt: null,
      totalSizeBytes: 1024,
    };
    const share = {
      id: 'share',
      driveItemId: 'folder',
      name: 'Shared team folder',
      direction: 'RECEIVED',
      syncState: 'PENDING',
      owner: { displayName: 'Alice', username: 'alice' },
    };
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      const p = url.pathname;
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      let data: any = { items: [], nextCursor: null, changes: [], cursor: '0' };
      if (p === '/v1/auth/login')
        data = { accessToken: 'fixture', refreshToken: 'fixture', expiresIn: 3600 };
      if (p === '/v1/users/me')
        data = {
          user: { id: 'bob', displayName: 'Bob', username: 'bob', email: 'bob@example.test' },
          storage: { usedBytes: 0, reservedBytes: 0, quotaBytes: 100000000000 },
        };
      if (p === '/v1/auth/session')
        data = { device: { id: 'device', name: 'Test', devicePublicId: 'public' } };
      if (p === '/v1/transfers/received') data = { items: [transfer], nextCursor: null };
      if (p === '/v1/sync/shares') data = { items: share.syncState === 'PENDING' ? [share] : [] };
      if (p === '/v1/transfers/transfer/accept') {
        transfer.state = 'ACCEPTED';
        state.testResponses.push('accept');
      }
      if (p === '/v1/sync/shares/share/respond') {
        share.syncState = body.action;
        state.testResponses.push(body.action);
      }
      return new Response(JSON.stringify(data), {
        headers: { 'Content-Type': 'application/json' },
      });
    };
  }, native);
  await page.evaluate(() =>
    window.harbor.login({ email: 'bob@example.test', password: 'Development-only-123!' }),
  );
  await expect
    .poll(() => desktop.evaluate(() => (globalThis as any).testNotifications.length))
    .toBe(2);
  await expect.poll(() => desktop.evaluate(() => (globalThis as any).testShown)).toBe(2);
  await desktop.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].hide();
    (globalThis as any).testNotifications
      .find((n: any) => n.title === 'Content received')
      .emit('click');
  });
  await expect(page.getByRole('dialog')).toContainText('Project files');
  await page.getByRole('dialog').getByRole('button', { name: 'Accept', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Shared', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Received', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await desktop.evaluate(() =>
    (globalThis as any).testNotifications
      .find((n: any) => n.title === 'Sync folder received')
      .emit('click'),
  );
  await expect(page.getByRole('dialog')).toContainText('Shared team folder');
  await expect(page.getByRole('button', { name: 'Accept and start syncing' })).toBeDisabled();
  await mkdir('test-results/desktop-incoming', { recursive: true });
  await page.screenshot({ path: 'test-results/desktop-incoming/sync-invitation.png' });
  await page.getByRole('dialog').getByRole('button', { name: 'Reject', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await desktop.evaluate(() => (globalThis as any).testResponses)).toEqual([
    'accept',
    'DECLINED',
  ]);
  await desktop.evaluate(({ powerMonitor }) => powerMonitor.emit('resume'));
  expect(await desktop.evaluate(() => (globalThis as any).testNotifications.length)).toBe(2);
  await page.evaluate(() => window.harbor.logout());
  await desktop.evaluate(() => (globalThis as any).testNotifications[0].emit('click'));
  await expect(page.getByRole('heading', { name: 'Sign in to harbor0' })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(errors).toEqual([]);
  console.log(
    'PASS: main-process alerts, hidden-window click, accept/reject, sync folder selection, duplicate suppression, and signed-out click guard.',
  );
} finally {
  await desktop.close();
  await rm(profile, { recursive: true, force: true });
}
