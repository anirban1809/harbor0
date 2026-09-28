import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, rm, mkdir, writeFile, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const profile = await mkdtemp(path.join(os.tmpdir(), 'harbor-packaged-check-'));
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  ),
);
for (const key of [
  'HARBOR_API_URL',
  'HARBOR_COGNITO_DOMAIN',
  'HARBOR_COGNITO_CLIENT_ID',
  'HARBOR_DEV_AUTH',
])
  delete env[key];
const app = await electron.launch({
  executablePath: path.resolve('apps/desktop/release/mac-arm64/harbor0.app/Contents/MacOS/harbor0'),
  args: [`--user-data-dir=${profile}`],
  env,
});
try {
  const page = await app.firstWindow();
  const status = await page.evaluate(() => window.harbor.status());
  expect(status.configured).toBe(true);
  expect(status.development).toBe(false);
  expect(status.signedIn).toBe(false);
  const runtime = await app.evaluate(({ app, BrowserWindow }) => ({
    packaged: app.isPackaged,
    profile: app.getPath('userData'),
    version: app.getVersion(),
    isolated: (
      BrowserWindow.getAllWindows()[0].webContents as unknown as {
        getLastWebPreferences: () => { contextIsolation: boolean };
      }
    ).getLastWebPreferences().contextIsolation,
  }));
  expect(runtime.packaged).toBe(true);
  expect(await realpath(runtime.profile)).toBe(await realpath(profile));
  expect(runtime.version).toBe('0.1.1');
  expect(runtime.isolated).toBe(true);
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeEnabled();
  await mkdir('test-results/shared-sync', { recursive: true });
  await page.screenshot({ path: 'test-results/shared-sync/packaged-login.png' });
  await writeFile(
    '.cloud/desktop-release-validation.json',
    JSON.stringify(
      {
        completedAt: new Date().toISOString(),
        passed: true,
        version: runtime.version,
        architecture: process.arch,
        configured: status.configured,
        productionAuthentication: !status.development,
        isolated: runtime.isolated,
        signing: 'unsigned; no Developer ID certificate available',
      },
      null,
      2,
    ),
  );
  console.log(
    'Packaged macOS app starts with bundled live settings, production login and an isolated renderer.',
  );
} finally {
  await app.close();
  await rm(profile, { recursive: true, force: true });
}
