import { randomUUID, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { removeFixtureAccount } from './fixture-accounts';
import { ApiClient, ApiError, createTransport } from '@harbor/api-client';
import { SyncEngine } from '../apps/desktop/src/sync';
import { Journal, type Root } from '../apps/desktop/src/journal';
import { StorageService } from '../apps/backend/src/domain';
import { DynamoRepository } from '../apps/backend/src/repository';
import { R2Storage } from '../apps/backend/src/storage';
import { DeletionWorkflows } from '../apps/backend/src/deletion';
import { readOutputs } from '../infra/environment';

const output = await readOutputs('storage');
const cognito = new CognitoIdentityProviderClient({ region: process.env.AWS_REGION });
const publicApi = new ApiClient(createTransport(output.ApiUrl));
const directory = await mkdtemp(path.join(os.tmpdir(), 'harbor-live-shared-'));
const run = randomUUID().replaceAll('-', '').slice(0, 12);
const created: { email: string; password: string }[] = [];
const clients: {
  api: ApiClient;
  userId: string;
  deviceId: string;
  username: string;
  journal: Journal;
  engine: SyncEngine;
  root: Root;
}[] = [];
const checks: string[] = [];
let folderId: string | undefined;
let shareId: string | undefined;
let passed = false;
let failure: string | undefined;
async function waitFor(test: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 90000;
  do {
    if (await test()) {
      checks.push(label);
      console.log('PASS:', label);
      return;
    }
    await delay(1000);
  } while (Date.now() < deadline);
  throw new Error('Timed out: ' + label);
}
const content = async (file: string) => readFile(file, 'utf8').catch(() => '');
try {
  if ((await publicApi.request('/health')).status !== 'ok')
    throw new Error('Backend is not healthy.');
  for (const label of ['owner', 'recipient']) {
    const username = `sync_${run}_${label}`;
    const email = username + '@example.invalid';
    const password = 'Sync!' + randomBytes(20).toString('hex');
    await cognito.send(
      new AdminCreateUserCommand({
        UserPoolId: output.UserPoolId,
        Username: email,
        MessageAction: 'SUPPRESS',
        UserAttributes: [
          { Name: 'email', Value: email },
          { Name: 'email_verified', Value: 'true' },
          { Name: 'preferred_username', Value: username },
          { Name: 'name', Value: 'Shared sync validation' },
        ],
      }),
    );
    created.push({ email, password });
    await cognito.send(
      new AdminSetUserPasswordCommand({
        UserPoolId: output.UserPoolId,
        Username: email,
        Password: password,
        Permanent: true,
      }),
    );
    const session = await publicApi.request('/v1/auth/login', {
      method: 'POST',
      body: {
        email,
        password,
        deviceName: `Shared sync QA ${run}`,
        platform: 'MACOS',
      },
    });
    const api = new ApiClient(createTransport(output.ApiUrl, async () => session.accessToken));
    await api.request('/v1/auth/session', {
      method: 'POST',
      body: { name: `Shared sync QA ${run}`, platform: 'MACOS', devicePublicId: randomUUID() },
    });
    const user = (await api.me()).user;
    const localPath = path.join(directory, label);
    await mkdir(localPath);
    const journal = new Journal(path.join(directory, label + '.sqlite'));
    const engine = new SyncEngine(api, journal, session.device.id, () => {});
    clients.push({
      api,
      userId: user.id,
      deviceId: session.device.id,
      username,
      journal,
      engine,
      root: {
        id: label,
        localPath,
        remoteId: null,
        mode: 'sync',
        paused: false,
        excluded: [],
        needsReconcile: true,
      },
    });
  }
  const [owner, recipient] = clients;
  const folder = (await owner.api.createFolder('Shared sync validation ' + run)).item;
  folderId = folder.id;
  owner.root.remoteId = folder.id;
  owner.journal.root(owner.root);
  await owner.api.request('/v1/sync/folders', { method: 'PUT', body: { folderIds: [folder.id] } });
  const { share } = await owner.api.request('/v1/sync/shares', {
    method: 'POST',
    body: {
      operationId: randomUUID(),
      driveItemId: folder.id,
      recipient: { type: 'USERNAME', value: recipient.username },
    },
  });
  shareId = share.id;
  const invitation = (await recipient.api.request('/v1/sync/shares')).items.find(
    (item: { id: string }) => item.id === share.id,
  );
  if (invitation?.syncState !== 'PENDING') throw new Error('Invitation not visible to recipient.');
  checks.push('Live invitation delivered to the correct account');
  console.log('PASS:', checks.at(-1));
  try {
    await recipient.api.list(folder.id);
    throw new Error('Pending invitation unexpectedly granted access.');
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 403) throw error;
  }
  checks.push('Pending invitation cannot read folder contents');
  console.log('PASS:', checks.at(-1));
  await recipient.api.request(`/v1/sync/shares/${share.id}/respond`, {
    method: 'POST',
    body: { action: 'ACCEPTED' },
  });
  recipient.root.remoteId = folder.id;
  recipient.root.shareId = share.id;
  recipient.journal.root(recipient.root);
  await recipient.api.request('/v1/sync/folders', {
    method: 'PUT',
    body: { folderIds: [folder.id] },
  });
  await owner.engine.start();
  await recipient.engine.start();
  await waitFor(
    async () => !!owner.engine.state.lastSync && !!recipient.engine.state.lastSync,
    'Both desktop sync engines connected with separate Cognito accounts',
  );
  await writeFile(path.join(owner.root.localPath, 'notes.txt'), 'Owner live version');
  await waitFor(
    async () =>
      (await content(path.join(recipient.root.localPath, 'notes.txt'))) === 'Owner live version',
    'Owner filesystem change reached the recipient through live R2',
  );
  await writeFile(path.join(recipient.root.localPath, 'notes.txt'), 'Recipient live edit');
  await waitFor(
    async () =>
      (await content(path.join(owner.root.localPath, 'notes.txt'))) === 'Recipient live edit',
    'Recipient filesystem edit reached the owner',
  );
  await mkdir(path.join(recipient.root.localPath, 'Nested'));
  await writeFile(
    path.join(recipient.root.localPath, 'Nested/new.txt'),
    'Recipient nested creation',
  );
  await waitFor(
    async () =>
      (await content(path.join(owner.root.localPath, 'Nested/new.txt'))) ===
      'Recipient nested creation',
    'Recipient-created nested folders and files synced back',
  );
  const file = (await owner.api.list(folder.id)).items.find((item) => item.name === 'notes.txt')!;
  await owner.api.request(`/v1/drive/items/${file.id}`, {
    method: 'PATCH',
    body: { operationId: randomUUID(), baseRevision: file.revision, name: 'renamed.txt' },
  });
  await waitFor(
    async () =>
      (await content(path.join(recipient.root.localPath, 'renamed.txt'))) === 'Recipient live edit',
    'Owner rename reached the recipient',
  );
  await waitFor(async () => {
    const status = (await recipient.api.request(`/v1/sync/status?recursive=false&ids=${file.id}`))
      .items[0];
    return status?.requiredDevices === 2 && status?.confirmedDevices === 2;
  }, 'Live delivery receipts require and confirm both accounts');
  if ((await recipient.api.me()).storage.usedBytes !== 0)
    throw new Error('Shared uploads incorrectly charged the recipient.');
  checks.push('Recipient uploads use the owner’s storage quota');
  console.log('PASS:', checks.at(-1));
  await rm(path.join(recipient.root.localPath, 'Nested/new.txt'));
  await waitFor(
    async () => (await content(path.join(owner.root.localPath, 'Nested/new.txt'))) === '',
    'Recipient deletion reached the owner',
  );
  recipient.engine.pause(true);
  await writeFile(
    path.join(recipient.root.localPath, 'keep-local.txt'),
    'Preserved after access removal',
  );
  await owner.api.request(`/v1/shares/${share.id}`, {
    method: 'DELETE',
    body: { operationId: randomUUID() },
  });
  recipient.engine.pause(false);
  await waitFor(
    async () => recipient.journal.roots().length === 0,
    'Revocation detached the recipient’s shared sync folder',
  );
  if (
    (await content(path.join(recipient.root.localPath, 'keep-local.txt'))) !==
    'Preserved after access removal'
  )
    throw new Error('Local content was lost after revocation.');
  if ((await owner.api.list(folder.id)).items.some((item) => item.name === 'keep-local.txt'))
    throw new Error('A revoked recipient published queued changes.');
  checks.push('Revocation preserved local edits and blocked further publishing');
  console.log('PASS:', checks.at(-1));
  passed = true;
} catch (error) {
  failure = (error as Error).message;
  console.error('Shared sync validation failed:', failure);
} finally {
  for (const client of clients) {
    await client.engine.stop();
    while (client.engine.state.running) await delay(100);
    client.journal.close();
  }
  const cleanupErrors: string[] = [];
  try {
    const [owner, recipient] = clients;
    for (const client of clients)
      await client.api.request('/v1/sync/folders', { method: 'PUT', body: { folderIds: [] } });
    if (owner && shareId)
      await owner.api.request(`/v1/shares/${shareId}`, {
        method: 'DELETE',
        body: { operationId: randomUUID() },
      });
    if (owner && folderId) {
      const { item } = await owner.api.request(`/v1/drive/items/${folderId}`);
      const { item: trashed } = await owner.api.request(`/v1/drive/items/${folderId}`, {
        method: 'DELETE',
        body: { operationId: randomUUID(), baseRevision: item.revision },
      });
      await owner.api.request(`/v1/drive/items/${folderId}/permanent`, {
        method: 'DELETE',
        body: { operationId: randomUUID(), baseRevision: trashed.revision },
      });
      // Advance only this run's cleanup job, never unrelated user jobs.
      const service = new StorageService(
        new DynamoRepository(output.TableName),
        new R2Storage(
          process.env.R2_BUCKET!,
          process.env.R2_ENDPOINT!,
          process.env.R2_ACCESS_KEY_ID!,
          process.env.R2_SECRET_ACCESS_KEY!,
        ),
      );
      for (let i = 0; i < 20; i++)
        if (await new DeletionWorkflows(service).step(owner.userId, folderId)) break;
      if (
        (await owner.api.me()).storage.usedBytes !== 0 ||
        (recipient && (await recipient.api.me()).storage.usedBytes !== 0)
      )
        cleanupErrors.push('Fixture storage cleanup incomplete.');
    }
  } catch (error) {
    cleanupErrors.push((error as Error).message);
  }
  for (const { email, password } of created) {
    try {
      await removeFixtureAccount(cognito, {
        apiUrl: output.ApiUrl,
        userPoolId: output.UserPoolId,
        email,
        password,
      });
    } catch (error) {
      cleanupErrors.push((error as Error).name);
    }
  }
  await rm(directory, { recursive: true, force: true });
  await writeFile(
    '.cloud/shared-sync-validation.json',
    JSON.stringify(
      {
        completedAt: new Date().toISOString(),
        passed: passed && !cleanupErrors.length,
        failure,
        checks,
        cleanupErrors,
        fixtureUsersRemoved: cleanupErrors.length === 0,
        apiUrl: output.ApiUrl,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  if (!passed || cleanupErrors.length) process.exitCode = 1;
  else console.log('Live shared sync passed; fixture identities and files cleaned up.');
}
