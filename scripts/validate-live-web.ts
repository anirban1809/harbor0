import { randomUUID, randomBytes, createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { readFile, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { removeFixtureAccount } from './fixture-accounts';
import { ApiClient, createTransport } from '@harbor/api-client';
import { readOutputs } from '../infra/environment';

const output = await readOutputs('storage');
const cognito = new CognitoIdentityProviderClient({ region: process.env.AWS_REGION });
const username = 'qa_web_' + randomUUID().replaceAll('-', '').slice(0, 14);
const email = username + '@example.invalid';
const password = 'Live!' + randomBytes(20).toString('hex');
const name = `${username}.txt`;
const folderName = `${username}-sync`;
const data = Buffer.from('Browser to Lambda to private R2: live validation.');
const checks: string[] = [];
let passed = false;
await cognito.send(
  new AdminCreateUserCommand({
    UserPoolId: output.UserPoolId,
    Username: email,
    MessageAction: 'SUPPRESS',
    UserAttributes: [
      { Name: 'email', Value: email },
      { Name: 'email_verified', Value: 'true' },
      { Name: 'preferred_username', Value: username },
      { Name: 'name', Value: 'Live browser validation' },
    ],
  }),
);
const browser = await chromium.launch({ headless: true });
try {
  await cognito.send(
    new AdminSetUserPasswordCommand({
      UserPoolId: output.UserPoolId,
      Username: email,
      Password: password,
      Permanent: true,
    }),
  );
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  await page.goto(process.env.WEB_ORIGIN!);
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  const loginResponse = page.waitForResponse(
    (r) => r.url().endsWith('/api/v1/auth/login') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'My Drive', exact: true })).toBeVisible({
    timeout: 45000,
  });
  checks.push('Web session gateway authenticates against live Cognito');
  const loginBody = await (await loginResponse).json();
  assert.ok(!loginBody.accessToken && !loginBody.refreshToken && !loginBody.idToken);
  checks.push('Login JSON does not expose credentials');
  const cookies = await context.cookies();
  if (
    !['harbor_access', 'harbor_refresh'].every((name) =>
      cookies.some((c) => c.name === name && c.httpOnly && c.sameSite === 'Strict'),
    )
  )
    throw new Error('Missing protected auth cookies.');
  checks.push('Access and refresh cookies are HTTP-only and SameSite Strict');
  if (process.env.WEB_ORIGIN!.startsWith('https://')) {
    assert.ok(cookies.filter((c) => c.name.startsWith('harbor_')).every((c) => c.secure));
    checks.push('HTTPS sessions use Secure cookies');
  }
  const me = await context.request.get(process.env.WEB_ORIGIN! + '/api/v1/users/me');
  assert.equal(me.status(), 200);
  assert.ok(me.headers()['cache-control'].includes('no-store'));
  assert.ok(!me.headers()['x-cache']?.includes('Hit'));
  const anonymous = await browser.newContext();
  const denied = await anonymous.request.get(process.env.WEB_ORIGIN! + '/api/v1/users/me');
  assert.equal(denied.status(), 401);
  await anonymous.close();
  checks.push('Authenticated responses are not cached or shared with anonymous visitors');
  const csrf = await context.request.post(process.env.WEB_ORIGIN! + '/api/v1/drive/folders', {
    headers: { Origin: 'https://untrusted.example' },
    data: { operationId: randomUUID(), name: 'Blocked cross-origin folder' },
  });
  assert.equal(csrf.status(), 403);
  checks.push('Cross-origin authenticated writes are blocked');
  const oldRefresh = cookies.find((c) => c.name === 'harbor_refresh')!.value;
  await context.clearCookies({ name: 'harbor_access' });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'My Drive', exact: true })).toBeVisible({
    timeout: 45000,
  });
  assert.notEqual(
    (await context.cookies()).find((c) => c.name === 'harbor_refresh')!.value,
    oldRefresh,
  );
  checks.push('Expired access cookies renew through rotating Cognito refresh credentials');
  await page
    .locator('input[type=file]')
    .first()
    .setInputFiles({ name, mimeType: 'text/plain', buffer: data });
  await expect(page.getByRole('button', { name, exact: true })).toBeVisible({ timeout: 45000 });
  checks.push('Browser hash worker and direct R2 upload succeed');
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: `Actions for ${name}`, exact: true }).click();
  await page.getByRole('menuitem', { name: 'Download', exact: true }).click();
  const downloaded = await pending;
  const bytes = await readFile((await downloaded.path())!);
  if (
    createHash('sha256').update(bytes).digest('hex') !==
    createHash('sha256').update(data).digest('hex')
  )
    throw new Error('Browser download differs from uploaded content.');
  checks.push('Browser download matches original SHA-256');
  // Use two independent synthetic desktop sessions; no existing account data is touched.
  const devices: ApiClient[] = [];
  for (const deviceName of ['Relay source', 'Relay receiver']) {
    const tokens = await new ApiClient(createTransport(output.ApiUrl)).request('/v1/auth/login', {
      method: 'POST',
      body: { email, password, platform: 'MACOS', deviceName },
    });
    devices.push(new ApiClient(createTransport(output.ApiUrl, async () => tokens.accessToken)));
  }
  const source = devices[0];
  const original = (await source.list()).items.find((item) => item.name === name)!;
  const folder = (await source.createFolder(folderName)).item;
  const moved = (
    await source.request(`/v1/drive/items/${original.id}/move`, {
      method: 'POST',
      body: { operationId: randomUUID(), baseRevision: original.revision, parentId: folder.id },
    })
  ).item;
  for (const device of devices)
    await device.request('/v1/sync/folders', { method: 'PUT', body: { folderIds: [folder.id] } });
  const status = async () => (await source.request('/v1/sync/status?ids=' + moved.id)).items[0];
  assert.equal((await status()).state, 'PENDING');
  const contentHash = createHash('sha256').update(data).digest('hex');
  let cloudCopyUrl = '';
  for (const [index, device] of devices.entries()) {
    const download = await device.request('/v1/downloads', {
      method: 'POST',
      body: { driveItemId: moved.id, versionId: moved.currentVersionId },
    });
    cloudCopyUrl = download.downloadUrl;
    const response = await fetch(download.downloadUrl);
    assert.equal(response.status, 200);
    assert.equal(
      createHash('sha256')
        .update(Buffer.from(await response.arrayBuffer()))
        .digest('hex'),
      contentHash,
    );
    await device.request(`/v1/sync/items/${moved.id}/acknowledge`, {
      method: 'POST',
      body: { versionId: moved.currentVersionId, revision: moved.revision, contentHash },
    });
    const current = await status();
    assert.equal(current.confirmedDevices, index + 1);
    assert.equal(current.state, index === 0 ? 'SYNCING' : 'SYNCED');
    if (index === 0) assert.equal(current.cloudState, 'AVAILABLE');
  }
  checks.push(
    'Live sync API retains the cloud copy until both verified device confirmations arrive',
  );
  console.log('PASS: Both device confirmations verified; waiting for scheduled cloud cleanup.');
  const cleanupDeadline = Date.now() + 210000;
  while ((await status()).cloudState !== 'RELEASED') {
    if (Date.now() > cleanupDeadline)
      throw new Error('Scheduled sync cleanup did not complete in time.');
    await delay(5000);
  }
  while (true) {
    const response = await fetch(cloudCopyUrl);
    await response.arrayBuffer();
    if (response.status === 404) break;
    assert.equal(
      response.status,
      200,
      'Unexpected storage response while checking relay deletion.',
    );
    if (Date.now() > cleanupDeadline)
      throw new Error('The released cloud object was not physically removed in time.');
    await delay(5000);
  }
  checks.push('The temporary cloud object is physically deleted from R2');
  assert.equal((await source.me()).storage.usedBytes, 0);
  assert.ok((await source.list(folder.id)).items.some((item) => item.id === moved.id));
  checks.push('Scheduled cleanup removes cloud storage usage and preserves the listed file');
  await page.goto(process.env.WEB_ORIGIN! + '/drive?folder=' + folder.id);
  await expect(page.getByRole('columnheader', { name: 'Sync status', exact: true })).toBeVisible();
  await expect(page.locator('td.file-sync-column .drive-sync-status')).toHaveText('Synced');
  await expect(page.locator('.drive-sync-status')).toHaveText('Synced');
  await expect(page.locator('.drive-sync-status')).toHaveAttribute(
    'title',
    /2 of 2 linked devices confirmed.*Cloud copy removed/,
  );
  checks.push('Live My Drive shows Synced with both device confirmations and cloud-copy removal');
  await page.screenshot({ path: '.cloud/live-web.png', fullPage: true });
  await page.goto(process.env.WEB_ORIGIN! + '/drive');
  await page.getByRole('button', { name: `Actions for ${folderName}`, exact: true }).click();
  await page.getByRole('menuitem', { name: 'Remove from sync', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Remove from sync', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: `Actions for ${folderName}`, exact: true }),
  ).toHaveCount(0);
  for (const device of devices) {
    const response = await device.request('/v1/sync/folders', {
      method: 'PUT',
      body: { folderIds: [folder.id] },
    });
    assert.deepEqual(response.removedFolderIds, [folder.id]);
  }
  assert.ok(!(await source.list()).items.some((entry) => entry.id === folder.id));
  await page.reload();
  await expect(page.getByRole('heading', { name: 'My Drive', exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: `Actions for ${folderName}`, exact: true }),
  ).toHaveCount(0);
  checks.push(
    'Live removal hides the folder and prevents both reconnecting devices from restoring it',
  );
  await page.locator('.topbar').getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible({
    timeout: 15000,
  });
  checks.push('Browser logout clears the authenticated session');
  passed = true;
} finally {
  await browser.close();
  try {
    const auth = new ApiClient(createTransport(output.ApiUrl));
    const login = await auth.request('/v1/auth/login', {
      method: 'POST',
      body: { email, password, platform: 'WEB', deviceName: 'Fixture cleanup' },
    });
    const api = new ApiClient(createTransport(output.ApiUrl, async () => login.accessToken));
    for (const item of (await api.list()).items) {
      assert.ok([name, folderName].includes(item.name), 'Refusing to delete an unrelated fixture.');
      const { item: trashed } = await api.request(`/v1/drive/items/${item.id}`, {
        method: 'DELETE',
        body: { operationId: randomUUID(), baseRevision: item.revision },
      });
      await api.request(`/v1/drive/items/${item.id}/permanent`, {
        method: 'DELETE',
        body: { operationId: randomUUID(), baseRevision: trashed.revision },
      });
    }
  } finally {
    await removeFixtureAccount(cognito, {
      apiUrl: output.ApiUrl,
      userPoolId: output.UserPoolId,
      email,
      password,
    });
    await writeFile(
      '.cloud/live-web-validation.json',
      JSON.stringify(
        {
          completedAt: new Date().toISOString(),
          webOrigin: process.env.WEB_ORIGIN,
          passed,
          checks,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  }
}
for (const check of checks) console.log('PASS:', check);
