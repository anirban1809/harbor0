import {
  _electron as electron,
  expect,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ApiClient, createTransport } from '@harbor/api-client';

// Production-mode requests are routed to the local development API. The desktop
// credential form, IPC, session renewal and OS encryption are real; no browser is used.
const base = process.env.HARBOR_TEST_API ?? 'http://127.0.0.1:8787';
const run = Date.now().toString();
const dir = await mkdtemp(path.join(os.tmpdir(), 'harbor-auth-ui-'));
const evidence = path.resolve('test-results/desktop-auth-and-ui');
await mkdir(evidence, { recursive: true });
const results: { name: string; status: string; detail?: string }[] = [];
let app!: ElectronApplication;
let page: Page;
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    results.push({ name, status: 'PASS' });
    console.log('PASS ' + name);
  } catch (e) {
    const detail = (e as Error).message;
    results.push({ name, status: 'FAIL', detail });
    console.log('FAIL ' + name + ': ' + detail.slice(0, 350));
    await page
      .screenshot({ path: path.join(evidence, `failure-${results.length}.png`) })
      .catch(() => {});
  }
  await writeFile(path.join(evidence, 'results.json'), JSON.stringify(results, null, 2));
}
async function post(p: string, body: unknown) {
  const response = await fetch(base + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await response.json()) as any;
  assert(response.ok, JSON.stringify(data));
  return data;
}
const email = 'desktopqa' + run + '@example.test';
await post('/v1/auth/signup', {
  email,
  username: 'desktopqa' + run,
  displayName: 'Desktop QA',
  password: 'Development-only-123!',
});
await post('/v1/auth/confirm', { email, code: '123456' });
const session = await post('/v1/auth/login', {
  email,
  password: 'Development-only-123!',
  deviceName: 'Desktop authentication fixture',
  platform: 'MACOS',
});
const api = new ApiClient(createTransport(base, async () => session.accessToken));
try {
  app = await electron.launch({
    args: ['apps/desktop', `--user-data-dir=${dir}/profile`],
    env: {
      ...process.env,
      HARBOR_DEV_AUTH: 'false',
      HARBOR_API_URL: 'https://desktop-api.invalid',
      HARBOR_COGNITO_DOMAIN: '',
      HARBOR_COGNITO_CLIENT_ID: '',
    },
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(8000);
  await expect(page.getByRole('heading', { name: 'Sign in to harbor0' })).toBeVisible();
  await app.evaluate(
    ({ shell }, config) => {
      const g = globalThis as any;
      const original = globalThis.fetch;
      g.__auth = { logins: 0, refreshes: 0, urls: [], mode: 'normal', refreshToken: '' };
      shell.openExternal = async (url) => {
        g.__auth.urls.push(url);
      };
      globalThis.fetch = async (input, init) => {
        const url = String(input);
        if (url.startsWith('https://desktop-api.invalid')) {
          if (url.endsWith('/v1/auth/login')) {
            g.__auth.logins++;
            if (g.__auth.mode === 'offline') throw new TypeError('Could not reach the server.');
            // Leave enough time to verify duplicate-submission protection.
            await new Promise((resolve) => setTimeout(resolve, 250));
            const response = await original(config.base + '/v1/auth/login', init);
            if (!response.ok) return response;
            const tokens = await response.json();
            g.__auth.refreshToken = tokens.refreshToken;
            return Response.json({ ...tokens, expiresIn: 1 });
          }
          if (url.endsWith('/v1/auth/refresh')) g.__auth.refreshes++;
          return original(config.base + url.slice('https://desktop-api.invalid'.length), init);
        }
        return original(input, init);
      };
    },
    { base },
  );
  async function fillCredentials(password = 'Development-only-123!') {
    await page.getByLabel('Email', { exact: true }).fill(email);
    await page.getByLabel('Password', { exact: true }).fill(password);
  }
  await check(
    'Production sign-in offers email and password without browser configuration',
    async () => {
      await expect(page.getByLabel('Email', { exact: true })).toHaveValue('');
      await expect(page.getByLabel('Password', { exact: true })).toHaveAttribute(
        'type',
        'password',
      );
      await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeEnabled();
      assert.equal(await page.getByRole('button', { name: /browser/i }).count(), 0);
      assert.equal((await page.evaluate(() => window.harbor.status())).development, false);
    },
  );
  await check('Rejected passwords show an inline error without saving a session', async () => {
    await fillCredentials('incorrect-password');
    await page.getByLabel('Password', { exact: true }).press('Enter');
    await expect(page.getByRole('alert')).toContainText(
      /password|credentials|invalid|Development-only-123!/i,
    );
    assert.equal((await page.evaluate(() => window.harbor.status())).signedIn, false);
    await assert.rejects(readFile(path.join(dir, 'profile/credentials.bin')), { code: 'ENOENT' });
  });
  await check('Connection errors stay in the app and allow retry', async () => {
    await app.evaluate(() => {
      (globalThis as any).__auth.mode = 'offline';
    });
    await fillCredentials();
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Could not reach the server');
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeEnabled();
    await app.evaluate(() => {
      (globalThis as any).__auth.mode = 'normal';
    });
  });
  await check(
    'Sign-in opens Drive, renews the session and encrypts credentials without opening a browser',
    async () => {
      await fillCredentials();
      const attempts = await app.evaluate(() => (globalThis as any).__auth.logins);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Signing in…' })).toBeDisabled();
      await expect(page.getByRole('heading', { name: 'My Drive', exact: true })).toBeVisible();
      const protocol = await app.evaluate(() => (globalThis as any).__auth);
      assert.equal(protocol.logins, attempts + 1);
      assert(protocol.refreshes >= 1);
      assert.deepEqual(protocol.urls, []);
      const credentialPath = path.join(dir, 'profile/credentials.bin');
      const credential = await readFile(credentialPath);
      assert(!credential.toString().includes(protocol.refreshToken));
      assert(!credential.toString().includes('Development-only-123!'));
      assert.equal((await stat(credentialPath)).mode & 0o777, 0o600);
      const saved = await app.evaluate(
        ({ safeStorage }, bytes) => JSON.parse(safeStorage.decryptString(Buffer.from(bytes))),
        [...credential],
      );
      assert.deepEqual(Object.keys(saved).sort(), ['expiresAt', 'refreshToken']);
      assert(saved.expiresAt > Date.now());
      await page.screenshot({ path: path.join(evidence, 'signed-in.png') });
    },
  );
  if (!process.argv.includes('--auth-only')) {
    await check('Tray Send a file event opens a picker or a send dialog', async () => {
      await app.evaluate(({ BrowserWindow, dialog }) => {
        (globalThis as any).__pickerCalls = 0;
        dialog.showOpenDialog = (async () => {
          (globalThis as any).__pickerCalls++;
          return { canceled: true, filePaths: [] };
        }) as any;
        BrowserWindow.getAllWindows()[0].webContents.send('harbor:send');
      });
      await expect
        .poll(
          async () =>
            (await app.evaluate(() => (globalThis as any).__pickerCalls)) > 0 ||
            (await page.getByRole('dialog').count()) > 0,
          { timeout: 2000 },
        )
        .toBe(true);
    });
    await check('Duplicate folder name reports an actionable error', async () => {
      await api.createFolder('Duplicate');
      await page.getByRole('button', { name: 'New folder', exact: true }).click();
      await page.getByRole('dialog').getByLabel('Name', { exact: true }).fill('Duplicate');
      await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click();
      await expect(page.getByRole('dialog').locator('.error')).toContainText(/name|exists/i);
      await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
    });
    await check('A Drive folder with 101 children exposes every item', async () => {
      const folder = (await api.createFolder('Pagination fixture')).item;
      for (let i = 0; i < 101; i++)
        await api.createFolder('Child ' + String(i).padStart(3, '0'), folder.id);
      const first = await api.list(folder.id);
      assert.equal(first.items.length, 100);
      assert(first.nextCursor);
      assert.equal((await api.list(folder.id, first.nextCursor)).items.length, 1);
      await page.locator('nav').getByRole('button', { name: 'Settings', exact: true }).click();
      await page.locator('nav').getByRole('button', { name: 'My Drive', exact: true }).click();
      await page
        .locator('.file-entry-row')
        .filter({ hasText: 'Pagination fixture' })
        .getByRole('button', { name: 'Pagination fixture', exact: true })
        .click();
      await expect(page.locator('.file-entry-row')).toHaveCount(100, { timeout: 3000 });
      await page.getByRole('button', { name: 'Next page', exact: true }).click();
      await expect(page.locator('.file-entry-row')).toHaveCount(1);
      await expect(page.getByRole('button', { name: 'Child 100', exact: true })).toBeVisible();
    });
  }
  await check(
    'Sign-in refuses to store credentials when the OS keychain is unavailable',
    async () => {
      await page.evaluate(() => window.harbor.logout());
      await page.reload();
      await expect(page.getByRole('heading', { name: 'Sign in to harbor0' })).toBeVisible();
      await app.evaluate(({ safeStorage }) => {
        safeStorage.isEncryptionAvailable = () => false;
      });
      await fillCredentials();
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await expect(page.getByRole('alert')).toContainText('Enable an OS keychain');
      await assert.rejects(readFile(path.join(dir, 'profile/credentials.bin')), { code: 'ENOENT' });
      assert.deepEqual(await app.evaluate(() => (globalThis as any).__auth.urls), []);
      assert.equal((await page.evaluate(() => window.harbor.status())).signedIn, false);
    },
  );
} finally {
  await app?.close().catch(() => {});
  await rm(dir, { recursive: true, force: true });
}
console.log(
  JSON.stringify({
    passed: results.filter((r) => r.status === 'PASS').length,
    failed: results.filter((r) => r.status === 'FAIL').length,
  }),
);
if (results.some((r) => r.status === 'FAIL')) process.exitCode = 1;
