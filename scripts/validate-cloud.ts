import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  AdminUpdateUserAttributesCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { removeFixtureAccount } from './fixture-accounts';
import { ApiClient, ApiError, createTransport } from '@harbor/api-client';
import type { Transfer } from '@harbor/contracts';
import { DynamoRepository, transact } from '../apps/backend/src/repository';
import { StorageService } from '../apps/backend/src/domain';
import { R2Storage } from '../apps/backend/src/storage';
import { TransferWorkflows } from '../apps/backend/src/workflows';
import { readOutputs } from '../infra/environment';

// A connection timeout occurs before any request reaches the service. Retry only
// this transport failure; API errors and ambiguous response timeouts still fail.
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (...args: Parameters<typeof fetch>) => {
  for (let attempt = 0; ; attempt++) {
    try {
      return await nativeFetch(...args);
    } catch (error) {
      if (
        attempt >= 2 ||
        (error as { cause?: { code?: string } }).cause?.code !== 'UND_ERR_CONNECT_TIMEOUT'
      )
        throw error;
      console.log('Retrying a connection that timed out before sending the request.');
    }
  }
};

const output = await readOutputs('storage');
const { ApiUrl, UserPoolId, ClientId, TableName, MaintenanceFunctionName } = output;
if (!ApiUrl.startsWith('https://') || !UserPoolId || !ClientId)
  throw new Error('Deploy the live stack first.');
const run = randomUUID().replaceAll('-', '').slice(0, 14);
const cognito = new CognitoIdentityProviderClient({ region: process.env.AWS_REGION });
const publicApi = new ApiClient(createTransport(ApiUrl));
const repo = new DynamoRepository(TableName);
const storage = new R2Storage(
  process.env.R2_BUCKET!,
  process.env.R2_ENDPOINT!,
  process.env.R2_ACCESS_KEY_ID!,
  process.env.R2_SECRET_ACCESS_KEY!,
);
const service = new StorageService(repo, storage);
const checks: string[] = [];
const created: { email: string; password: string }[] = [];
let passed = false;
function check(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
  checks.push(message);
  console.log('PASS:', message);
}
async function rejected(fn: () => Promise<unknown>, status: number, message: string) {
  try {
    await fn();
  } catch (e) {
    if (e instanceof ApiError) {
      check(e.status === status, `${message} (HTTP ${e.status}, expected ${status})`);
      return;
    }
    throw e;
  }
  throw new Error(message + ': request unexpectedly succeeded');
}
async function identity(label: string, verified: boolean) {
  const username = `qa_${run}_${label}`;
  const email = username + '@example.invalid';
  const password = 'Live!' + randomBytes(20).toString('hex');
  await cognito.send(
    new AdminCreateUserCommand({
      UserPoolId,
      Username: email,
      MessageAction: 'SUPPRESS',
      UserAttributes: [
        { Name: 'email', Value: email },
        { Name: 'email_verified', Value: String(verified) },
        { Name: 'preferred_username', Value: username },
        { Name: 'name', Value: 'Live validation' },
      ],
    }),
  );
  created.push({ email, password });
  await cognito.send(
    new AdminSetUserPasswordCommand({
      UserPoolId,
      Username: email,
      Password: password,
      Permanent: true,
    }),
  );
  return { username, email, password };
}
async function login(person: { email: string; password: string }) {
  return publicApi.request('/v1/auth/login', {
    method: 'POST',
    body: {
      email: person.email,
      password: person.password,
      deviceName: 'Live validation',
      platform: 'WEB',
    },
  });
}
try {
  check(
    (await publicApi.request('/health')).status === 'ok',
    'Deployed API Gateway and Lambda health',
  );
  await rejected(() => publicApi.me(), 401, 'Unauthenticated API access denied');
  const a = await identity('a', false);
  await rejected(() => login(a), 403, 'Unverified email cannot initialize a drive');
  await cognito.send(
    new AdminUpdateUserAttributesCommand({
      UserPoolId,
      Username: a.email,
      UserAttributes: [{ Name: 'email_verified', Value: 'true' }],
    }),
  );
  const b = await identity('b', true);
  let sessionA = await login(a);
  const sessionB = await login(b);
  const alice = new ApiClient(createTransport(ApiUrl, async () => sessionA.accessToken));
  const bob = new ApiClient(createTransport(ApiUrl, async () => sessionB.accessToken));
  const accountA = await alice.me();
  check(
    accountA.user.emailVerified && accountA.storage.quotaBytes === 100_000_000_000,
    'Cognito authentication creates DynamoDB account and quota',
  );
  const oldRefresh = sessionA.refreshToken;
  sessionA = {
    ...sessionA,
    ...(await publicApi.request('/v1/auth/refresh', {
      method: 'POST',
      body: { refreshToken: oldRefresh },
    })),
  };
  check(
    sessionA.refreshToken !== oldRefresh && (await alice.me()).user.id === accountA.user.id,
    'Live Cognito refresh rotation preserves the device session',
  );
  const operationId = randomUUID();
  const [first, replay] = await Promise.all([
    alice.createFolder('Live validation ' + run, null, operationId),
    alice.createFolder('Live validation ' + run, null, operationId),
  ]);
  check(first.item.id === replay.item.id, 'DynamoDB concurrent idempotency');
  await alice.request('/v1/sync/folders', {
    method: 'PUT',
    body: { folderIds: [first.item.id] },
  });
  const syncedFolders = await alice.request('/v1/sync/folders');
  check(
    syncedFolders.items.length === 1 && syncedFolders.items[0].id === first.item.id,
    'Live synced-folder registration and listing',
  );
  check(
    (await bob.request('/v1/sync/folders')).items.length === 0,
    'Synced folders remain private to their account',
  );
  await alice.request('/v1/sync/folders', { method: 'PUT', body: { folderIds: [] } });
  check(
    (await alice.request('/v1/sync/folders')).items.length === 0,
    'Stopped sync mappings are removed from the live listing',
  );

  const data = Buffer.alloc(1024 * 1024 + 257, 72);
  const hash = createHash('sha256').update(data).digest('hex');
  const { upload } = await alice.createUpload({
    operationId: randomUUID(),
    parentId: first.item.id,
    name: 'live-check.bin',
    sizeBytes: data.length,
    mimeType: 'application/octet-stream',
    contentHash: hash,
  });
  const { parts: urls } = await alice.parts(upload.id, [1]);
  const preflight = await fetch(urls[0].uploadUrl, {
    method: 'OPTIONS',
    headers: {
      Origin: process.env.WEB_ORIGIN!,
      'Access-Control-Request-Method': 'PUT',
      'Access-Control-Request-Headers': 'content-type',
    },
  });
  check(
    preflight.ok && preflight.headers.get('access-control-allow-origin') === process.env.WEB_ORIGIN,
    'Live bucket browser CORS',
  );
  const put = await fetch(urls[0].uploadUrl, { method: 'PUT', body: data });
  check(put.ok && put.headers.has('etag'), 'Lambda-signed upload reaches private R2');
  const parts = [{ partNumber: 1, etag: put.headers.get('etag')! }];
  const receipt = await alice.request(`/v1/uploads/${upload.id}`);
  check(receipt.parts.length === 1, 'Lambda reads live R2 upload receipts');
  const { item } = await alice.complete(upload.id, parts, hash);
  check(
    (await alice.complete(upload.id, parts, hash)).item.id === item.id,
    'Live upload completion is idempotent',
  );
  const download = await alice.download({ driveItemId: item.id });
  const downloaded = Buffer.from(await (await fetch(download.downloadUrl)).arrayBuffer());
  check(
    createHash('sha256').update(downloaded).digest('hex') === hash,
    'End-to-end download SHA-256 matches',
  );
  await rejected(
    () => bob.download({ driveItemId: item.id }),
    403,
    'Other accounts cannot download private files',
  );
  const { transfer } = await alice.request('/v1/transfers', {
    method: 'POST',
    body: {
      operationId: randomUUID(),
      recipient: { type: 'USERNAME', value: b.username },
      items: [{ driveItemId: item.id }],
    },
  });
  await bob.request(`/v1/transfers/${transfer.id}/accept`, {
    method: 'POST',
    body: { operationId: randomUUID() },
  });
  check(
    (await bob.me()).storage.usedBytes === 0,
    'Accepting a transfer consumes no recipient quota',
  );
  const saved = await bob.request(`/v1/transfers/${transfer.id}/save`, {
    method: 'POST',
    body: { operationId: randomUUID(), targetParentId: null },
  });
  check(
    saved.items.length === 1 && (await bob.me()).storage.usedBytes === data.length,
    'Saving a transfer charges recipient quota exactly once',
  );
  const copied = await bob.download({ driveItemId: saved.items[0].id });
  check(
    createHash('sha256')
      .update(Buffer.from(await (await fetch(copied.downloadUrl)).arrayBuffer()))
      .digest('hex') === hash,
    'Saved transfer downloads from live R2',
  );
  const changes = await alice.changes(0);
  check(
    changes.changes.length > 0 &&
      changes.changes.every((c, i, all) => i === 0 || c.sequence > all[i - 1].sequence),
    'Live ordered DynamoDB sync feed',
  );
  const cancelled = await alice.createUpload({
    operationId: randomUUID(),
    parentId: first.item.id,
    name: 'cancel.bin',
    sizeBytes: 1024,
    mimeType: 'application/octet-stream',
  });
  await alice.request(`/v1/uploads/${cancelled.upload.id}`, { method: 'DELETE' });
  check((await alice.me()).storage.reservedBytes === 0, 'Abort releases live quota reservation');

  // Expire only this run's synthetic transfer, to test expiry and remove its storage pins.
  await transact(repo, async (tx) => {
    const t = await tx.get<Transfer>('TRANSFER', transfer.id);
    if (!t || t.senderUserId !== accountA.user.id || t.recipientUserId !== (await bob.me()).user.id)
      throw new Error('Refusing to alter an unrelated transfer.');
    await tx.put('TRANSFER', transfer.id, {
      ...t,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
  });
  const workflow = new TransferWorkflows(service);
  check(await workflow.expire(transfer.id), 'Live transfer expiry');
  await workflow.release(transfer.id);
  for (const [api, root] of [
    [bob, saved.items[0]],
    [alice, first.item],
  ] as const) {
    const { item: trashed } = await api.request(`/v1/drive/items/${root.id}`, {
      method: 'DELETE',
      body: { operationId: randomUUID(), baseRevision: root.revision },
    });
    await api.request(`/v1/drive/items/${root.id}/permanent`, {
      method: 'DELETE',
      body: { operationId: randomUUID(), baseRevision: trashed.revision },
    });
  }
  // Recursive deletion advances across durable batches and GSI visibility is
  // eventually consistent. Wait for completion instead of assuming one invocation.
  for (let attempt = 0; attempt < 8; attempt++) {
    execFileSync(
      'aws',
      [
        'lambda',
        'invoke',
        '--function-name',
        MaintenanceFunctionName,
        '--region',
        process.env.AWS_REGION!,
        '.cloud/maintenance-validation.json',
      ],
      { stdio: 'pipe' },
    );
    if ((await alice.me()).storage.usedBytes === 0 && (await bob.me()).storage.usedBytes === 0)
      break;
    await delay(2000);
  }
  check(
    (await alice.me()).storage.usedBytes === 0 && (await bob.me()).storage.usedBytes === 0,
    'Synthetic files deleted and quota returned to zero',
  );
  const maintenance = JSON.parse(await readFile('.cloud/maintenance-validation.json', 'utf8'));
  check(
    typeof maintenance.processed === 'number',
    'Deployed maintenance Lambda executes successfully',
  );
  await alice.request('/v1/auth/logout', {
    method: 'POST',
    body: { refreshToken: sessionA.refreshToken },
  });
  await rejected(() => alice.me(), 401, 'Logout revokes live Cognito access');
  await rejected(
    () =>
      publicApi.request('/v1/auth/refresh', {
        method: 'POST',
        body: { refreshToken: sessionA.refreshToken },
      }),
    401,
    'Revoked refresh token rejected',
  );
  await bob.request(`/v1/devices/${sessionB.device.id}`, { method: 'DELETE' });
  await rejected(() => bob.me(), 403, 'Device revocation blocks API access');
  await rejected(
    () =>
      publicApi.request('/v1/auth/refresh', {
        method: 'POST',
        body: { refreshToken: sessionB.refreshToken },
      }),
    403,
    'Device revocation blocks refreshed sessions',
  );
  passed = true;
} finally {
  for (const { email, password } of created)
    await removeFixtureAccount(cognito, {
      apiUrl: ApiUrl,
      userPoolId: UserPoolId,
      email,
      password,
    });
  await writeFile(
    '.cloud/live-validation.json',
    JSON.stringify(
      {
        completedAt: new Date().toISOString(),
        passed,
        apiUrl: ApiUrl,
        userPoolId: UserPoolId,
        tableName: TableName,
        checks,
        syntheticCognitoUsersRemoved: true,
        emailDelivery: 'Requires inbox confirmation; admin fixtures suppress messages.',
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.log('Synthetic Cognito identities removed.');
}
