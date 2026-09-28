import { _electron as electron } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const profile = await mkdtemp(path.join(os.tmpdir(), 'harbor-electron-'));
const app = await electron.launch({
  args: ['apps/desktop', `--user-data-dir=${profile}`],
  env: { ...process.env, HARBOR_DEV_AUTH: 'true', HARBOR_API_URL: 'http://127.0.0.1:8787' },
});
try {
  const page = await app.firstWindow();
  await page.getByRole('heading', { name: 'Sign in to harbor0' }).waitFor();
  if ((await page.locator('.error').count()) > 0)
    throw new Error(
      'Desktop startup displayed an error: ' +
        (await page.locator('.error').allTextContents()).join('; '),
    );
  const secure = await app.evaluate(async ({ BrowserWindow }) => {
    const options = (
      BrowserWindow.getAllWindows()[0].webContents as unknown as {
        getLastWebPreferences: () => {
          contextIsolation: boolean;
          nodeIntegration: boolean;
          sandbox: boolean;
        };
      }
    ).getLastWebPreferences();
    return {
      contextIsolation: options.contextIsolation,
      nodeIntegration: options.nodeIntegration,
      sandbox: options.sandbox,
    };
  });
  if (!secure.contextIsolation || secure.nodeIntegration || !secure.sandbox)
    throw new Error('Insecure Electron configuration.');
  const renderer = await page.evaluate(() => ({
    node: typeof (globalThis as any).require,
    bridge: typeof globalThis.window.harbor.request,
  }));
  if (renderer.node !== 'undefined' || renderer.bridge !== 'function')
    throw new Error('Renderer isolation failed.');
  await page.screenshot({ path: 'test-results/desktop-login.png' });
  console.log(
    'Electron launches with an isolated, sandboxed renderer and a working preload bridge.',
  );
} finally {
  await app.close();
  await rm(profile, { recursive: true, force: true });
}
