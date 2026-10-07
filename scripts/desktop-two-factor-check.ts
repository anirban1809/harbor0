import { _electron as electron, expect } from '@playwright/test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Signs in through the real main process, preload and renderer for an account with two-step
// verification, against a fixture server: email code, a wrong code, a new code, then success.
const profile = await mkdtemp(path.join(os.tmpdir(), 'harbor-two-factor-'));
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
  args: [entry, `--user-data-dir=${profile}`],
  env: { ...process.env, HARBOR_DEV_AUTH: 'true', HARBOR_API_URL: 'http://127.0.0.1:8787' },
});
try {
  const page = await desktop.firstWindow();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await expect(page.getByRole('heading', { name: 'Sign in to harbor0' })).toBeVisible();
  await desktop.evaluate(() => {
    const state = globalThis as any;
    state.calls = [];
    let session = 0;
    // Not a named function: tsx would wrap it in a helper that doesn't exist in Electron.
    const [json] = [
      (data: unknown, status = 200) =>
        new Response(JSON.stringify(data), {
          status,
          headers: { 'Content-Type': 'application/json' },
        }),
    ];
    globalThis.fetch = async (input, init) => {
      const p = new URL(String(input)).pathname;
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (p.startsWith('/v1/auth/login')) state.calls.push({ path: p, body });
      if (p === '/v1/auth/login') {
        // Old app builds don't say they can ask for a code.
        if (!body.twoFactor)
          return json({ error: { code: 'TWO_FACTOR_UNSUPPORTED', message: 'Update.' } }, 403);
        return json({
          twoFactor: {
            session: `EMAIL:s${++session}`,
            methods: ['EMAIL'],
            method: 'EMAIL',
            destination: 'b***@e***',
          },
        });
      }
      if (p === '/v1/auth/login/verify') {
        if (body.code !== '123456')
          return json(
            {
              error: {
                code: 'AUTH_INVALID',
                message: 'That code didn’t match. Try again.',
                details: { session: body.session },
              },
            },
            400,
          );
        return json({ accessToken: 'fixture', refreshToken: 'fixture', expiresIn: 3600 });
      }
      if (p === '/v1/users/me')
        return json({
          user: { id: 'bob', displayName: 'Bob', username: 'bob', email: 'bob@example.test' },
          storage: { usedBytes: 0, reservedBytes: 0, quotaBytes: 100000000000 },
          flags: {},
        });
      if (p === '/v1/auth/session')
        return json({ device: { id: 'device', name: 'Test', devicePublicId: 'public' } });
      return json({ items: [], nextCursor: null, changes: [], cursor: '0' });
    };
  });

  await page.getByLabel('Email').fill('bob@example.test');
  await page.getByRole('textbox', { name: 'Password' }).fill('Development-only-123!');
  await page.getByRole('button', { name: /Sign in/ }).click();
  await expect(page.getByRole('heading', { name: 'Two-step verification' })).toBeVisible();
  await expect(page.getByText('b***@e***')).toBeVisible();

  const code = page.getByLabel('Email code');
  await code.fill('000000');
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByText('That code didn’t match. Try again.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Two-step verification' })).toBeVisible();

  await page.getByRole('button', { name: 'Send a new code' }).click();
  await expect(page.getByText('A new code is on its way.')).toBeVisible();
  await mkdir('test-results/desktop-two-factor', { recursive: true });
  await page.screenshot({ path: 'test-results/desktop-two-factor/code-step.png' });

  await code.fill('123456');
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByRole('heading', { name: 'Two-step verification' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Sign in to harbor0' })).toHaveCount(0);

  const calls = await desktop.evaluate(() => (globalThis as any).calls);
  expect(calls.map((c: { path: string }) => c.path)).toEqual([
    '/v1/auth/login',
    '/v1/auth/login/verify',
    '/v1/auth/login',
    '/v1/auth/login/verify',
  ]);
  expect(calls[0].body).toMatchObject({ twoFactor: true, email: 'bob@example.test' });
  // The new code belongs to the fresh sign-in started by "Send a new code".
  expect(calls[3].body).toMatchObject({ session: 'EMAIL:s2', method: 'EMAIL', code: '123456' });
  expect(calls[3].body.platform).toMatch(/MACOS|WINDOWS|LINUX/);
  expect(errors).toEqual([]);
  console.log('PASS: desktop two-step sign-in: code step, wrong code, new code, and sign-in.');
} finally {
  await desktop.close();
  await rm(profile, { recursive: true, force: true });
}
