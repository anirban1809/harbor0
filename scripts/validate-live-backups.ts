import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdtemp, rm, utimes } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chromium, expect } from '@playwright/test';
import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { removeFixtureAccount } from './fixture-accounts';
import { ApiClient, createTransport } from '@harbor/api-client';
import { Journal, type Root } from '../apps/desktop/src/journal';
import { SyncEngine } from '../apps/desktop/src/sync';
import { FolderBackups, BACKUP_QUIET_MS } from '../apps/desktop/src/backups';

const output = JSON.parse(await readFile('.cloud/outputs.json', 'utf8')).HarborStorage;
const web = JSON.parse(await readFile('.cloud/web-outputs.json', 'utf8')).HarborWeb;
const cognito = new CognitoIdentityProviderClient({ region: process.env.AWS_REGION });
const username = `qa_backup_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const email = `${username}@example.invalid`;
const password = `Live!${randomBytes(20).toString('hex')}`;
const directory = await mkdtemp(path.join(os.tmpdir(), 'harbor-live-backup-'));
const journal = new Journal(':memory:');
const checks: string[] = [];
let engine: SyncEngine | undefined;
let api: ApiClient | undefined;
let root: Root | undefined;
let userCreated = false;
let passed = false;
const browser = await chromium.launch();
const pass = (message: string) => {
  checks.push(message);
  console.log('PASS:', message);
};
try {
  await cognito.send(
    new AdminCreateUserCommand({
      UserPoolId: output.UserPoolId,
      Username: email,
      MessageAction: 'SUPPRESS',
      UserAttributes: [
        { Name: 'email', Value: email },
        { Name: 'email_verified', Value: 'true' },
        { Name: 'preferred_username', Value: username },
        { Name: 'name', Value: 'Backup deployment validation' },
      ],
    }),
  );
  userCreated = true;
  await cognito.send(
    new AdminSetUserPasswordCommand({
      UserPoolId: output.UserPoolId,
      Username: email,
      Password: password,
      Permanent: true,
    }),
  );
  const session = await new ApiClient(createTransport(output.ApiUrl)).request('/v1/auth/login', {
    method: 'POST',
    body: { email, password, platform: 'MACOS', deviceName: 'Backup validation computer' },
  });
  api = new ApiClient(createTransport(output.ApiUrl, async () => session.accessToken));
  const { root: remote } = await api.request('/v1/backups', {
    method: 'POST',
    body: { operationId: randomUUID(), deviceId: session.device.id, name: username },
  });
  root = {
    id: randomUUID(),
    backupId: remote.id,
    remoteId: remote.remoteRootDriveItemId,
    localPath: directory,
    mode: 'backup',
    paused: false,
    excluded: [],
  };
  journal.root(root);
  const filename = 'Backup verification.txt';
  const target = path.join(directory, filename);
  await writeFile(target, 'First archived version.');
  journal.enqueue(root.id, filename, 'upsert');
  engine = new SyncEngine(api, journal, session.device.id, () => {});
  await engine.tick();
  assert.equal((await api.list(root.remoteId)).items.length, 0);
  pass('Live backup worker defers files changed within the last hour');
  // Reopen the worker with an already-stable file, as after the computer was offline.
  await engine.stop();
  const old = new Date(Date.now() - BACKUP_QUIET_MS - 10000);
  await utimes(target, old, old);
  // Let the synthetic timestamp change settle before a new macOS watcher starts.
  await new Promise((resolve) => setTimeout(resolve, 3000));
  for (const job of journal.jobs()) {
    delete job.payload.observedAt;
    journal.saveJob(job);
  }
  engine = new SyncEngine(api, journal, session.device.id, () => {});
  await engine.tick();
  await expect
    .poll(
      async () => {
        await engine!.tick();
        return (await api!.list(root!.remoteId)).items.some((item) => item.name === filename)
          ? 'uploaded'
          : engine!.state.message;
      },
      { timeout: 60000, intervals: [1000, 2000, 5000] },
    )
    .toBe('uploaded');
  const first = (await api.list(root.remoteId)).items.find((item) => item.name === filename);
  assert.ok(first, 'The automatic backup did not upload the stable file');
  await expect
    .poll(
      async () =>
        (await api!.request(`/v1/backups/${remote.id}/runs`)).items.some(
          (run: { state: string }) => run.state === 'COMPLETED',
        ),
      { timeout: 30000 },
    )
    .toBe(true);
  pass('Automatic folder backup uploads to private R2 and records its completed run');
  await writeFile(target, 'Second archived version with recent edits.');
  await engine.backupNow(root.id);
  await engine.tick();
  await expect
    .poll(async () => (await api!.request(`/v1/drive/items/${first.id}/versions`)).items.length, {
      timeout: 45000,
    })
    .toBe(2);
  await engine.stop();
  pass('On-demand backup includes recent edits and retains both file versions');
  const runs = (await api.request(`/v1/backups/${remote.id}/runs`)).items;
  for (const run of runs) {
    const { items } = await api.request(`/v1/backups/${remote.id}/runs/${run.id}/files`);
    assert.ok(items.some((entry: { itemId: string }) => entry.itemId === first.id));
  }
  pass('Live backup history lists the files and exact versions covered by each run');
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  await page.goto(web.WebUrl + '/backups');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Backups', exact: true })).toBeVisible({
    timeout: 45000,
  });
  await page.getByRole('button', { name: new RegExp(filename) }).click();
  await expect(page.getByText('Version 1', { exact: true })).toBeVisible();
  await expect(page.getByRole('tab')).toHaveText(['Archives', 'Backups', 'Restore/Export']);
  pass('Deployed web app displays the backup folder, three tabs, and saved versions');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).last().click();
  const exported = await download;
  assert.equal(await readFile((await exported.path())!, 'utf8'), 'First archived version.');
  pass('Web export downloads the exact selected historical version');
  await page.getByRole('button', { name: 'Restore', exact: true }).last().click();
  await page.getByRole('button', { name: 'Restore version', exact: true }).click();
  await expect(page.getByText('Waiting for the source computer')).toBeVisible();
  const worker = new FolderBackups(api, journal);
  await worker.process(
    root,
    async () => {
      throw new Error('No upload should be needed for this restore');
    },
    () => false,
  );
  assert.equal(await readFile(target, 'utf8'), 'First archived version.');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.locator('.backup-recovery-row').first()).toContainText('Completed', {
    timeout: 15000,
  });
  assert.equal((await api.request(`/v1/drive/items/${first.id}/versions`)).items.length, 2);
  pass(
    'Web restore request replaces the source file and reports completion without altering cloud history',
  );
  await page.screenshot({ path: '.cloud/live-backups.png', fullPage: true });
  const current = (await api.request(`/v1/drive/items/${first.id}`)).item;
  await assert.rejects(
    api.request(`/v1/drive/items/${first.id}`, {
      method: 'PATCH',
      body: { operationId: randomUUID(), baseRevision: current.revision, name: 'Blocked.txt' },
    }),
    (error: any) => error.code === 'BACKUP_IMMUTABLE',
  );
  await assert.rejects(
    api.request('/v1/drive/folders', {
      method: 'POST',
      body: { operationId: randomUUID(), parentId: root!.remoteId, name: 'Blocked' },
    }),
    (error: any) => error.code === 'BACKUP_IMMUTABLE',
  );
  pass('Live backend rejects edits and new folders inside connected backups');
  await page.goto(web.WebUrl + '/drive');
  await expect(page.getByRole('tab')).toHaveText(['Cloud', 'Backup', 'Sync']);
  await expect(
    page.getByRole('button', { name: new RegExp(`Actions for ${username}`) }),
  ).toHaveCount(0);
  await page.getByRole('tab', { name: 'Backup', exact: true }).click();
  await page.getByRole('button', { name: new RegExp(`Actions for ${username}`) }).click();
  await expect(page.getByRole('menuitem', { name: 'Rename', exact: true })).toHaveCount(0);
  await page.getByRole('menuitem', { name: 'Disconnect backup', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Disconnect backup', exact: true })
    .click();
  await expect(page.getByRole('tab', { name: 'Cloud', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.getByRole('button', { name: new RegExp(`Actions for ${username}`) }).click();
  await expect(page.getByRole('menuitem', { name: 'Rename', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  assert.equal((await api.request(`/v1/drive/items/${first.id}/versions`)).items.length, 2);
  await api.request(`/v1/drive/items/${first.id}`, {
    method: 'PATCH',
    body: {
      operationId: randomUUID(),
      baseRevision: current.revision,
      name: 'Editable cloud notes.txt',
    },
  });
  assert.equal(await readFile(target, 'utf8'), 'First archived version.');
  pass(
    'Live My Drive tabs keep backups read-only; disconnect moves the folder into Cloud, preserves versions and unlocks edits',
  );
  await page.screenshot({ path: '.cloud/live-drive-backups.png', fullPage: true });
  passed = true;
} finally {
  await engine?.stop();
  if (!passed && engine)
    await writeFile(
      '.cloud/live-backups-worker.json',
      JSON.stringify(
        {
          state: engine.state,
          jobs: journal
            .jobs()
            .map((job) => ({ path: job.relativePath, error: job.error, attempts: job.attempts })),
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  await browser.close();
  try {
    if (api && root?.remoteId) {
      const { item } = await api.request(`/v1/drive/items/${root.remoteId}`);
      assert.ok(item.name.startsWith(username), 'Refusing to delete an unrelated file');
      await api.request(`/v1/backups/${root.backupId}`, { method: 'DELETE' });
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
    if (userCreated)
      await removeFixtureAccount(cognito, {
        apiUrl: output.ApiUrl,
        userPoolId: output.UserPoolId,
        email,
        password,
      });
    journal.close();
    await rm(directory, { recursive: true, force: true });
    await writeFile(
      '.cloud/live-backups-validation.json',
      JSON.stringify(
        {
          completedAt: new Date().toISOString(),
          passed,
          webUrl: web.WebUrl,
          apiUrl: output.ApiUrl,
          checks,
          syntheticCognitoUserRemoved: userCreated,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  }
}
console.log('Live backup validation passed; synthetic account and test folder removed.');
