import { createHash, randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/api';
import { DevelopmentAuth } from '../src/auth';
import { StorageService, userPK } from '../src/domain';
import { FLAG_PK, emptyFlag } from '../src/flags';
import { MemoryRepository, Transaction, transact } from '../src/repository';
import { MemoryStorage } from '../src/storage';

const PASSWORD = 'Development-only-123!';
let service: StorageService;
let storage: MemoryStorage;
let app: ReturnType<typeof createApp>['app'];

const call = (method: string, path: string, token: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const signIn = async (email = 'alice@example.test', platform = 'WEB') =>
  (
    await (
      await app.request('/v1/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: PASSWORD, platform, deviceName: platform }),
      })
    ).json()
  ).accessToken as string;
const flagOn = () =>
  transact(service.repo, (tx) =>
    tx.put(FLAG_PK, 'e2ee', { ...emptyFlag('e2ee'), mode: 'TARGETED', userIds: ['alice'] }),
  );
// Shapes only: the server never opens these.
const b = (n: number, fill = 7) => Buffer.alloc(n, fill).toString('base64url');
const SECRET = b(32, 9);
const enrollBody = (proof = 'proof-value-1234') => ({
  passphrase: {
    v: 1,
    kdf: 'argon2id',
    salt: b(16),
    memoryKiB: 65536,
    iterations: 3,
    parallelism: 1,
    iv: b(12),
    ciphertext: b(48),
  },
  recovery: { v: 1, kdf: 'hkdf', salt: b(16), iv: b(12), ciphertext: b(48) },
  proof,
});
const token = (seed: string) =>
  'h0e1.' + createHash('sha256').update(seed).digest().toString('base64url') + 'AAAAAAAAAAAA';
async function upload(t: string, name: string, data: string, extra: object = {}) {
  const r = await call('POST', '/v1/uploads', t, {
    operationId: randomUUID(),
    parentId: null,
    name,
    sizeBytes: data.length,
    ...extra,
  });
  if (r.status !== 200) return r;
  const { upload: u } = await r.json();
  const stored = (await new Transaction(service.repo).get<{ providerUploadId: string }>(
    userPK('alice'),
    `UPLOAD#${u.id}`,
  ))!;
  storage.uploads.get(stored.providerUploadId)!.parts.set(1, Buffer.from(data));
  return call('POST', `/v1/uploads/${u.id}/complete`, t, {
    parts: [{ partNumber: 1, etag: 'e' }],
    contentHash: createHash('sha256').update(data).digest('hex'),
  });
}

beforeEach(() => {
  storage = new MemoryStorage();
  service = new StorageService(new MemoryRepository(), storage);
  app = createApp(service, new DevelopmentAuth()).app;
});

describe('end-to-end encryption', () => {
  it('turns on only with the flag, and only once', async () => {
    // Flag rules are cached for a while, so it is set before the first request.
    await flagOn();
    const bob = await signIn('bob@example.test');
    expect((await call('POST', '/v1/e2ee/enroll', bob, enrollBody())).status).toBe(403);
    const web = await signIn();
    const on = await call('POST', '/v1/e2ee/enroll', web, enrollBody());
    expect(on.status).toBe(200);
    expect((await on.json()).e2ee).toMatchObject({ enabled: true, devices: [] });
    expect(
      (await (await call('GET', '/v1/users/me', web)).json()).user.e2ee.enabledAt,
    ).toBeTruthy();
    expect((await call('POST', '/v1/e2ee/enroll', web, enrollBody())).status).toBe(409);
  });

  it('refuses plaintext names and uploads once on, and old apps altogether', async () => {
    await flagOn();
    const web = await signIn();
    const plain = await upload(web, 'before.txt', 'secret');
    expect(plain.status).toBe(200);
    await call('POST', '/v1/e2ee/enroll', web, enrollBody());

    const folder = (name: string) =>
      call('POST', '/v1/drive/folders', web, { operationId: randomUUID(), parentId: null, name });
    expect((await (await folder('Taxes')).json()).error.code).toBe('E2EE_REQUIRED');
    expect((await folder(token('Taxes'))).status).toBe(200);
    expect(
      (await (await upload(web, token('a'), 'x', { encrypted: true })).json()).item.encrypted,
    ).toBe(true);
    expect((await (await upload(web, token('b'), 'x')).json()).error.code).toBe('E2EE_REQUIRED');
    expect(
      (await (await upload(web, 'plain.txt', 'x', { encrypted: true })).json()).error.code,
    ).toBe('E2EE_REQUIRED');

    const mac = await signIn('alice@example.test', 'MACOS');
    const listed = await call('GET', '/v1/drive/folders/root/children', mac);
    expect(listed.status).toBe(426);
    expect((await listed.json()).error.code).toBe('E2EE_UPDATE_REQUIRED');
    expect((await call('GET', '/v1/users/me', mac)).status).toBe(200);
  });

  it('pauses sharing and server-side ZIPs', async () => {
    await flagOn();
    const web = await signIn();
    await call('POST', '/v1/e2ee/enroll', web, enrollBody());
    const transfer = await call('POST', '/v1/transfers', web, {
      operationId: randomUUID(),
      recipient: { type: 'USERNAME', value: 'bob' },
      items: [{ driveItemId: 'x' }],
    });
    expect((await transfer.json()).error.code).toBe('E2EE_UNSUPPORTED');
    const zip = await call('POST', '/v1/folder-downloads', web, {
      operationId: randomUUID(),
      driveItemId: 'x',
    });
    expect((await zip.json()).error.code).toBe('E2EE_UNSUPPORTED');
  });

  it('changes keys and adds devices only with the key proof', async () => {
    await flagOn();
    const web = await signIn();
    await call('POST', '/v1/e2ee/enroll', web, enrollBody('the-right-proof'));
    const { passphrase, recovery } = enrollBody();
    expect(
      (await call('PUT', '/v1/e2ee/passphrase', web, { passphrase, proof: 'wrong' })).status,
    ).toBe(403);
    const changed = await call('PUT', '/v1/e2ee/passphrase', web, {
      passphrase,
      proof: 'the-right-proof',
    });
    expect((await changed.json()).e2ee.passphraseChangedAt).toBeTruthy();
    expect(
      (await call('PUT', '/v1/e2ee/recovery', web, { recovery, proof: 'the-right-proof' })).status,
    ).toBe(200);

    const added = await call('POST', '/v1/e2ee/devices', web, {
      proof: 'the-right-proof',
      serverSecret: SECRET,
      remember: true,
    });
    const { id } = await added.json();
    const secret = await call('POST', `/v1/e2ee/devices/${id}/secret`, web);
    expect((await secret.json()).serverSecret).toBe(SECRET);
    const state = await (await call('GET', '/v1/e2ee', web)).json();
    expect(state.e2ee.devices).toMatchObject([{ id, remember: true, platform: 'WEB' }]);
    expect(JSON.stringify(state)).not.toContain(SECRET);
    await call('DELETE', `/v1/e2ee/devices/${id}`, web);
    expect((await call('POST', `/v1/e2ee/devices/${id}/secret`, web)).status).toBe(404);
  });

  it('deletes a re-encrypted file’s unencrypted versions', async () => {
    await flagOn();
    const web = await signIn();
    const first = (await (await upload(web, 'notes.txt', 'plain text')).json()).item;
    await call('POST', '/v1/e2ee/enroll', web, enrollBody());
    const early = await call('POST', `/v1/e2ee/items/${first.id}/purge-plaintext`, web);
    expect((await early.json()).error.code).toBe('E2EE_NOT_ENCRYPTED');

    const r = await call('POST', '/v1/uploads', web, {
      operationId: randomUUID(),
      parentId: null,
      name: 'ignored',
      sizeBytes: 9,
      driveItemId: first.id,
      baseRevision: first.revision,
      encrypted: true,
    });
    const { upload: u } = await r.json();
    const stored = (await new Transaction(service.repo).get<{ providerUploadId: string }>(
      userPK('alice'),
      `UPLOAD#${u.id}`,
    ))!;
    storage.uploads.get(stored.providerUploadId)!.parts.set(1, Buffer.from('encrypted'));
    await call('POST', `/v1/uploads/${u.id}/complete`, web, {
      parts: [{ partNumber: 1, etag: 'e' }],
      contentHash: createHash('sha256').update('encrypted').digest('hex'),
    });
    // Download links say the stored bytes are encrypted, so apps decrypt after checking them.
    const link = await (await call('POST', '/v1/downloads', web, { driveItemId: first.id })).json();
    expect(link).toMatchObject({ encrypted: true, sizeBytes: 9 });
    // An interrupted runner finds the file again from any browser.
    expect((await (await call('GET', '/v1/e2ee/leftovers', web)).json()).plaintextVersions).toEqual(
      [first.id],
    );
    const before = (await (await call('GET', '/v1/users/me', web)).json()).storage.usedBytes;
    const purged = await call('POST', `/v1/e2ee/items/${first.id}/purge-plaintext`, web);
    expect(await purged.json()).toEqual({ removed: 1, retained: 0 });
    expect((await (await call('GET', '/v1/e2ee/leftovers', web)).json()).plaintextVersions).toEqual(
      [],
    );
    const versions = (await (await call('GET', `/v1/drive/items/${first.id}/versions`, web)).json())
      .items;
    expect(versions).toMatchObject([{ encrypted: true }]);
    const after = (await (await call('GET', '/v1/users/me', web)).json()).storage.usedBytes;
    expect(before - after).toBe('plain text'.length);
  });
  it('refuses encrypted uploads to an account that is not encrypted', async () => {
    await flagOn();
    const web = await signIn();
    const r = await upload(web, 'x.txt', 'x', { encrypted: true });
    expect((await r.json()).error.code).toBe('E2EE_OFF');
  });
  it('lets a full account re-encrypt a file, but not grow', async () => {
    await flagOn();
    const web = await signIn();
    const first = (await (await upload(web, 'notes.txt', 'plain text')).json()).item;
    await transact(service.repo, async (tx) => {
      const account = (await tx.get<{ storageQuotaBytes: number }>(userPK('alice'), 'PROFILE'))!;
      await tx.put(userPK('alice'), 'PROFILE', {
        ...account,
        storageQuotaBytes: 'plain text'.length,
      });
    });
    await call('POST', '/v1/e2ee/enroll', web, enrollBody());
    const replace = (sizeBytes: number) =>
      call('POST', '/v1/uploads', web, {
        operationId: randomUUID(),
        parentId: null,
        name: 'ignored',
        sizeBytes,
        driveItemId: first.id,
        baseRevision: first.revision,
        encrypted: true,
      });
    const overhead = 80 + 16;
    const bigger = await replace(10 + overhead + 1);
    expect((await bigger.json()).error.code).toBe('STORAGE_QUOTA_EXCEEDED');
    expect((await replace(10 + overhead)).status).toBe(200);
    const fresh = await call('POST', '/v1/uploads', web, {
      operationId: randomUUID(),
      parentId: null,
      name: token('new.txt'),
      sizeBytes: 1,
      encrypted: true,
    });
    expect((await fresh.json()).error.code).toBe('STORAGE_QUOTA_EXCEEDED');
  });
  it('turns off only once everything is decrypted, then removes the keys', async () => {
    await flagOn();
    const web = await signIn();
    await call('POST', '/v1/e2ee/enroll', web, enrollBody('the-right-proof'));
    const folder = (
      await (
        await call('POST', '/v1/drive/folders', web, {
          operationId: randomUUID(),
          parentId: null,
          name: token('Taxes'),
        })
      ).json()
    ).item;
    const file = (await (await upload(web, token('a.txt'), 'sealed', { encrypted: true })).json())
      .item;
    expect((await call('POST', '/v1/e2ee/disable', web, { proof: 'wrong' })).status).toBe(403);
    const started = await call('POST', '/v1/e2ee/disable', web, { proof: 'the-right-proof' });
    expect((await started.json()).e2ee.decryptingSince).toBeTruthy();
    expect(
      (await (await call('GET', '/v1/users/me', web)).json()).user.e2ee.decryptingSince,
    ).toBeTruthy();

    // While decrypting, plaintext is allowed again.
    const r = await call('POST', '/v1/uploads', web, {
      operationId: randomUUID(),
      parentId: null,
      name: 'ignored',
      sizeBytes: 5,
      driveItemId: file.id,
      baseRevision: file.revision,
    });
    const { upload: u } = await r.json();
    const stored = (await new Transaction(service.repo).get<{ providerUploadId: string }>(
      userPK('alice'),
      `UPLOAD#${u.id}`,
    ))!;
    storage.uploads.get(stored.providerUploadId)!.parts.set(1, Buffer.from('plain'));
    const done = await (
      await call('POST', `/v1/uploads/${u.id}/complete`, web, {
        parts: [{ partNumber: 1, etag: 'e' }],
        contentHash: createHash('sha256').update('plain').digest('hex'),
      })
    ).json();
    expect(done.item.encrypted).toBeUndefined();
    expect(
      await (await call('POST', `/v1/e2ee/items/${file.id}/purge-encrypted`, web)).json(),
    ).toEqual({ removed: 1, retained: 0 });
    const rename = (id: string, revision: number, name: string) =>
      call('PATCH', `/v1/drive/items/${id}`, web, {
        operationId: randomUUID(),
        baseRevision: revision,
        name,
      });
    expect((await rename(file.id, done.item.revision, 'a.txt')).status).toBe(200);

    const early = await call('POST', '/v1/e2ee/disable/finish', web, { proof: 'the-right-proof' });
    expect((await early.json()).error).toMatchObject({
      code: 'E2EE_STILL_ENCRYPTED',
      details: { left: 1 },
    });
    expect((await rename(folder.id, folder.revision, 'Taxes')).status).toBe(200);
    const off = await call('POST', '/v1/e2ee/disable/finish', web, { proof: 'the-right-proof' });
    expect((await off.json()).e2ee).toMatchObject({ enabled: false, devices: [] });
    expect((await (await call('GET', '/v1/users/me', web)).json()).user.e2ee).toBeUndefined();
    const plain = await call('POST', '/v1/drive/folders', web, {
      operationId: randomUUID(),
      parentId: null,
      name: 'Plain again',
    });
    expect(plain.status).toBe(200);
    expect((await call('POST', '/v1/e2ee/enroll', web, enrollBody())).status).toBe(200);
  });
});
