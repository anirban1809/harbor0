import { createHash, randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/api';
import { DevelopmentAuth } from '../src/auth';
import { StorageService } from '../src/domain';
import { FLAG_PK, emptyFlag, featureFlagsFor } from '../src/flags';
import { MemoryRepository, transact } from '../src/repository';
import { MemoryStorage } from '../src/storage';

let service: StorageService;
let app: ReturnType<typeof createApp>['app'];

const request = (method: string, path: string, token: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'rclone/v1.75.2',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const session = 'dev-alice';
const flagOn = async (userIds: string[]) => {
  await transact(service.repo, (tx) =>
    tx.put(FLAG_PK, 'rclone', { ...emptyFlag('rclone'), mode: 'TARGETED', userIds }),
  );
  featureFlagsFor(service.repo).invalidate();
};
const createToken = async (body: Record<string, unknown> = { name: 'NAS' }) => {
  const response = await request('POST', '/v1/tokens', session, body);
  expect(response.status).toBe(200);
  return (await response.json()) as { token: string; item: { id: string } };
};
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
/** Uploads `bytes` the way rclone does: reserve, sign parts, PUT them, complete. */
async function upload(
  token: string,
  name: string,
  bytes: Buffer,
  extra: Record<string, unknown> = {},
) {
  const created = await (
    await request('POST', '/v1/uploads', token, {
      operationId: randomUUID(),
      parentId: null,
      name,
      sizeBytes: bytes.length,
      contentHash: sha256(bytes),
      ...extra,
    })
  ).json();
  const signed = await (
    await request('POST', `/v1/uploads/${created.upload.id}/parts`, token, { partNumbers: [1] })
  ).json();
  const [uploadId] = signed.parts[0].uploadUrl.slice('memory://'.length).split('/');
  (service.storage as MemoryStorage).uploads.get(uploadId)!.parts.set(1, bytes);
  const etag = 'part-1';
  const done = await request('POST', `/v1/uploads/${created.upload.id}/complete`, token, {
    parts: [{ partNumber: 1, etag }],
    contentHash: sha256(bytes),
  });
  return done;
}

beforeEach(async () => {
  service = new StorageService(new MemoryRepository(), new MemoryStorage());
  const auth = new DevelopmentAuth();
  app = createApp(service, auth).app;
  const alice = auth.users.get('alice@example.test')!;
  await service.ensureUser(alice);
  await service.registerDevice(alice.id, { name: 'Browser', platform: 'WEB' }, alice.deviceId);
});

describe('personal access tokens', () => {
  it('are created only for accounts with the flag', async () => {
    expect((await request('POST', '/v1/tokens', session, { name: 'NAS' })).status).toBe(403);
    await flagOn(['alice']);
    const { token, item } = await createToken();
    expect(token).toMatch(/^h0_pat_[A-Za-z0-9_-]{43}$/);
    expect(item).toMatchObject({ name: 'NAS', scope: 'FULL', lastUsedAt: null });
  });

  it('stores only a hash of the secret', async () => {
    await flagOn(['alice']);
    const { token } = await createToken();
    const rows = JSON.stringify([
      ...((service.repo as unknown as { rows: Map<string, unknown> }).rows ?? new Map()).values(),
    ]);
    expect(rows).not.toContain(token);
    const index = await service.repo.get({
      pk: `PAT#${createHash('sha256').update(token).digest('hex')}`,
      sk: 'PAT',
    });
    expect(index?.data).toMatchObject({ userId: 'alice', scope: 'FULL' });
  });

  it('use My Drive and show up as a device', async () => {
    await flagOn(['alice']);
    const { token, item } = await createToken();
    const me = await (await request('GET', '/v1/users/me', token)).json();
    expect(me.user.email).toBe('alice@example.test');
    const folder = await request('POST', '/v1/drive/folders', token, {
      operationId: randomUUID(),
      parentId: null,
      name: 'From rclone',
    });
    expect(folder.status).toBe(200);
    const devices = await (await request('GET', '/v1/devices', session)).json();
    const device = devices.items.find((d: { id: string }) => d.id === item.id);
    expect(device).toMatchObject({ platform: 'CLI', name: 'NAS', appVersion: 'rclone/v1.75.2' });
    const listed = await (await request('GET', '/v1/tokens', session)).json();
    expect(listed.items[0].lastUsedAt).toBeTruthy();
  });

  it('cannot reach routes outside My Drive', async () => {
    await flagOn(['alice']);
    const { token } = await createToken();
    for (const [method, path] of [
      ['GET', '/v1/devices'],
      ['GET', '/v1/tokens'],
      ['POST', '/v1/tokens'],
      ['PATCH', '/v1/users/me'],
      ['POST', '/v1/users/me/delete'],
      ['GET', '/v1/transfers/received'],
    ]) {
      const response = await request(method, path, token, method === 'GET' ? undefined : {});
      expect(response.status, `${method} ${path}`).toBe(403);
      expect((await response.json()).error.code).toBe('TOKEN_NOT_ALLOWED');
    }
  });

  it('are read-only when created that way', async () => {
    await flagOn(['alice']);
    const { token } = await createToken({ name: 'Reader', scope: 'READ' });
    expect((await request('GET', '/v1/drive/folders/root/children', token)).status).toBe(200);
    const write = await request('POST', '/v1/drive/folders', token, {
      operationId: randomUUID(),
      parentId: null,
      name: 'Nope',
    });
    expect(write.status).toBe(403);
    expect((await write.json()).error.code).toBe('TOKEN_SCOPE');
  });

  it('stop working at once when revoked or when the device is removed', async () => {
    await flagOn(['alice']);
    const first = await createToken();
    expect((await request('GET', '/v1/users/me', first.token)).status).toBe(200);
    await request('DELETE', `/v1/tokens/${first.item.id}`, session);
    expect((await request('GET', '/v1/users/me', first.token)).status).toBe(401);
    const second = await createToken();
    expect((await request('GET', '/v1/users/me', second.token)).status).toBe(200);
    await request('POST', `/v1/devices/${second.item.id}/sign-out`, session);
    expect((await request('GET', '/v1/users/me', second.token)).status).toBe(401);
    expect((await (await request('GET', '/v1/tokens', session)).json()).items).toEqual([]);
  });

  it('reject unknown and expired tokens', async () => {
    expect((await request('GET', '/v1/users/me', 'h0_pat_nothing')).status).toBe(401);
    await flagOn(['alice']);
    const { token } = await createToken({ name: 'Short', expiresInDays: 30 });
    const key = { pk: `PAT#${createHash('sha256').update(token).digest('hex')}`, sk: 'PAT' };
    await transact(service.repo, async (tx) => {
      const row = await tx.get<Record<string, unknown>>(key.pk, key.sk);
      await tx.put(key.pk, key.sk, { ...row, expiresAt: '2020-01-01T00:00:00.000Z' });
    });
    expect((await request('GET', '/v1/users/me', token)).status).toBe(401);
  });

  it('stop working for suspended accounts', async () => {
    await flagOn(['alice']);
    const { token } = await createToken();
    await transact(service.repo, async (tx) => {
      const profile = await tx.get<Record<string, unknown>>('USER#alice', 'PROFILE');
      await tx.put('USER#alice', 'PROFILE', { ...profile, suspendedAt: new Date().toISOString() });
    });
    expect((await request('GET', '/v1/users/me', token)).status).toBe(403);
  });
});

describe('rclone support in My Drive', () => {
  it('keeps the modification time and hash on uploads and in listings', async () => {
    await flagOn(['alice']);
    const { token } = await createToken();
    const bytes = Buffer.from('hello rclone');
    const done = await upload(token, 'hello.txt', bytes, {
      modifiedAt: '2024-05-06T07:08:09.123Z',
    });
    expect(done.status).toBe(200);
    const { items } = await (await request('GET', '/v1/drive/folders/root/children', token)).json();
    expect(items[0]).toMatchObject({
      name: 'hello.txt',
      contentHash: sha256(bytes),
      modifiedAt: '2024-05-06T07:08:09.123Z',
    });
    const changed = await request('PATCH', `/v1/drive/items/${items[0].id}/modified`, token, {
      baseRevision: items[0].revision,
      modifiedAt: '2025-01-01T00:00:00.000Z',
    });
    expect((await changed.json()).item).toMatchObject({
      modifiedAt: '2025-01-01T00:00:00.000Z',
      revision: items[0].revision,
    });
  });

  it('finds a child by name, ignoring case', async () => {
    await flagOn(['alice']);
    const { token } = await createToken();
    await request('POST', '/v1/drive/folders', token, {
      operationId: randomUUID(),
      parentId: null,
      name: 'Photos',
    });
    const found = await request('GET', '/v1/drive/folders/root/lookup?name=photos', token);
    expect((await found.json()).item.name).toBe('Photos');
    const missing = await request('GET', '/v1/drive/folders/root/lookup?name=none', token);
    expect(missing.status).toBe(404);
  });
});
