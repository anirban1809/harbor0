import { createHash, randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/api';
import { DevelopmentAuth } from '../src/auth';
import { StorageService, userPK, type Account } from '../src/domain';
import { FLAG_PK, emptyFlag, featureFlagsFor } from '../src/flags';
import { MemoryRepository, transact } from '../src/repository';
import { MemoryStorage } from '../src/storage';

let service: StorageService;
let app: ReturnType<typeof createApp>['app'];
let aliceId: string;

const request = (
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = { Authorization: 'Bearer dev-alice' },
) =>
  app.request(path, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
/** A visitor: no session, its own address. */
const visit = (method: string, path: string, body?: unknown, extra: Record<string, string> = {}) =>
  request(method, path, body, { 'CloudFront-Viewer-Address': '203.0.113.9:4431', ...extra });
const flagOn = async () => {
  await transact(service.repo, (tx) =>
    tx.put(FLAG_PK, 'public-links', {
      ...emptyFlag('public-links'),
      mode: 'TARGETED',
      userIds: [aliceId],
    }),
  );
  featureFlagsFor(service.repo).invalidate();
};
/** Makes alice's account `days` old. */
const age = (days: number) =>
  transact(service.repo, async (tx) => {
    const account = (await tx.get<Account>(userPK(aliceId), 'PROFILE'))!;
    await tx.put(userPK(aliceId), 'PROFILE', {
      ...account,
      createdAt: new Date(Date.now() - days * 86400_000).toISOString(),
    });
  });
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
async function upload(name: string, parentId: string | null = null) {
  const bytes = Buffer.from(`contents of ${name}`);
  const created = await (
    await request('POST', '/v1/uploads', {
      operationId: randomUUID(),
      parentId,
      name,
      sizeBytes: bytes.length,
      contentHash: sha256(bytes),
    })
  ).json();
  const signed = await (
    await request('POST', `/v1/uploads/${created.upload.id}/parts`, { partNumbers: [1] })
  ).json();
  const [uploadId] = signed.parts[0].uploadUrl.slice('memory://'.length).split('/');
  (service.storage as MemoryStorage).uploads.get(uploadId)!.parts.set(1, bytes);
  const done = await request('POST', `/v1/uploads/${created.upload.id}/complete`, {
    parts: [{ partNumber: 1, etag: 'part-1' }],
    contentHash: sha256(bytes),
  });
  expect(done.status).toBe(200);
  return (await done.json()).item as { id: string; revision: number };
}
const folder = async (name: string, parentId: string | null = null) =>
  (
    await (
      await request('POST', '/v1/drive/folders', { operationId: randomUUID(), parentId, name })
    ).json()
  ).item as { id: string; revision: number };
const createLink = async (body: Record<string, unknown>) => {
  const response = await request('POST', '/v1/links', body);
  expect(response.status).toBe(200);
  const { link } = await response.json();
  return { link, token: (link.url as string).split('#')[1] };
};

beforeEach(async () => {
  service = new StorageService(new MemoryRepository(), new MemoryStorage());
  const auth = new DevelopmentAuth();
  app = createApp(service, auth).app;
  const alice = auth.users.get('alice@example.test')!;
  aliceId = alice.id;
  await service.ensureUser(alice);
  await service.registerDevice(alice.id, { name: 'Browser', platform: 'WEB' }, alice.deviceId);
});

describe('public links', () => {
  it('need the flag, at any account age', async () => {
    const file = await upload('notes.txt');
    expect((await request('POST', '/v1/links', { driveItemId: file.id })).status).toBe(403);
    await flagOn();
    expect((await (await request('GET', '/v1/links/allowance')).json()).blockedReason).toBeNull();
    expect((await request('POST', '/v1/links', { driveItemId: file.id })).status).toBe(200);
  });

  it('share a file: open, download, list and revoke', async () => {
    await flagOn();
    await age(8);
    const file = await upload('notes.txt');
    const { link, token } = await createLink({ driveItemId: file.id });
    expect(link.url).toMatch(/^http:\/\/127\.0\.0\.1:3400\/s#[A-Za-z0-9_-]{22}$/);
    expect(link.expiresAt).toBeTruthy();
    // Only a hash of the token is the lookup key.
    expect(await service.repo.get({ pk: `PUBLIC_LINK#${token}`, sk: 'LINK' })).toBeUndefined();

    const view = await (await visit('GET', `/v1/public/links/${token}`)).json();
    expect(view.passwordRequired).toBe(false);
    expect(view.sharedBy.displayName).toBeTruthy();
    expect(view.item).toMatchObject({ name: 'notes.txt', type: 'FILE', executable: false });
    expect(JSON.stringify(view)).not.toContain(aliceId);

    const download = await visit('POST', `/v1/public/links/${token}/download`, {});
    expect(download.status).toBe(200);
    expect((await download.json()).downloadUrl).toMatch(/^memory:\/\/objects\//);

    const listed = await (await request('GET', `/v1/links?driveItemId=${file.id}`)).json();
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]).toMatchObject({ itemName: 'notes.txt', url: link.url });

    expect((await request('DELETE', `/v1/links/${link.id}`)).status).toBe(200);
    const after = await visit('GET', `/v1/public/links/${token}`);
    expect(after.status).toBe(404);
    expect((await (await request('GET', '/v1/links')).json()).items).toHaveLength(0);
  });

  it('share a folder and nothing outside it', async () => {
    await flagOn();
    await age(8);
    const shared = await folder('Photos');
    const inner = await folder('2026', shared.id);
    const photo = await upload('beach.jpg', inner.id);
    const outside = await upload('private.txt');
    const { token } = await createLink({ driveItemId: shared.id });

    const top = await (await visit('GET', `/v1/public/links/${token}/items`)).json();
    expect(top.path.map((p: { name: string }) => p.name)).toEqual(['Photos']);
    expect(top.items.map((i: { name: string }) => i.name)).toEqual(['2026']);
    const nested = await (
      await visit('GET', `/v1/public/links/${token}/items?folderId=${inner.id}`)
    ).json();
    expect(nested.path.map((p: { name: string }) => p.name)).toEqual(['Photos', '2026']);
    expect(nested.items[0].name).toBe('beach.jpg');

    const ok = await visit('POST', `/v1/public/links/${token}/download`, { itemId: photo.id });
    expect(ok.status).toBe(200);
    const escape = await visit('POST', `/v1/public/links/${token}/download`, {
      itemId: outside.id,
    });
    expect(escape.status).toBe(404);
    const listOutside = await visit(
      'GET',
      `/v1/public/links/${token}/items?folderId=${outside.id}`,
    );
    expect(listOutside.status).toBe(404);

    // Trashing the linked folder stops the link.
    await request('DELETE', `/v1/drive/items/${shared.id}`, {
      operationId: randomUUID(),
      baseRevision: shared.revision,
    });
    expect((await visit('GET', `/v1/public/links/${token}`)).status).toBe(404);
  });

  it('hide everything behind a password until it is entered', async () => {
    await flagOn();
    await age(8);
    const file = await upload('secret.pdf');
    const { link, token } = await createLink({ driveItemId: file.id, password: 'open sesame' });
    expect(link.hasPassword).toBe(true);
    const locked = await (await visit('GET', `/v1/public/links/${token}`)).json();
    expect(locked).toMatchObject({ passwordRequired: true, item: null });
    expect((await visit('POST', `/v1/public/links/${token}/download`, {})).status).toBe(401);
    const wrong = await visit('POST', `/v1/public/links/${token}/unlock`, { password: 'nope' });
    expect(wrong.status).toBe(403);
    const { pass } = await (
      await visit('POST', `/v1/public/links/${token}/unlock`, { password: 'open sesame' })
    ).json();
    const header = { 'X-Harbor-Link-Pass': pass };
    const open = await (await visit('GET', `/v1/public/links/${token}`, undefined, header)).json();
    expect(open.item.name).toBe('secret.pdf');
    expect((await visit('POST', `/v1/public/links/${token}/download`, {}, header)).status).toBe(
      200,
    );
  });

  it('keep programs off young accounts and never-ending links off free ones', async () => {
    await flagOn();
    await age(8);
    const installer = await upload('setup.exe');
    const refused = await request('POST', '/v1/links', { driveItemId: installer.id });
    expect((await refused.json()).error.code).toBe('PUBLIC_LINK_FILE_TYPE');
    const never = await request('POST', '/v1/links', {
      driveItemId: installer.id,
      expiresInDays: null,
    });
    expect((await never.json()).error.code).toBe('PUBLIC_LINK_EXPIRY');
    // A program inside a linked folder can't be downloaded either.
    const tools = await folder('Tools');
    const inside = await upload('tool.apk', tools.id);
    const { token } = await createLink({ driveItemId: tools.id });
    const download = await visit('POST', `/v1/public/links/${token}/download`, {
      itemId: inside.id,
    });
    expect((await download.json()).error.code).toBe('PUBLIC_LINK_FILE_TYPE');
    await age(31);
    expect((await request('POST', '/v1/links', { driveItemId: installer.id })).status).toBe(200);
  });

  it('change their end and password after they are made', async () => {
    await flagOn();
    await age(8);
    const file = await upload('notes.txt');
    const { link, token } = await createLink({ driveItemId: file.id, expiresInDays: 1 });
    const longer = await request('PATCH', `/v1/links/${link.id}`, { expiresInDays: 30 });
    const changed = (await longer.json()).link;
    expect(Date.parse(changed.expiresAt)).toBeGreaterThan(Date.now() + 29 * 86400_000);
    expect(changed.url).toBe(link.url);
    const never = await request('PATCH', `/v1/links/${link.id}`, { expiresInDays: null });
    expect((await never.json()).error.code).toBe('PUBLIC_LINK_EXPIRY');

    await request('PATCH', `/v1/links/${link.id}`, { password: 'first one' });
    expect((await (await visit('GET', `/v1/public/links/${token}`)).json()).passwordRequired).toBe(
      true,
    );
    const { pass } = await (
      await visit('POST', `/v1/public/links/${token}/unlock`, { password: 'first one' })
    ).json();
    // A new password ends the old pass.
    await request('PATCH', `/v1/links/${link.id}`, { password: 'second one' });
    const old = await visit('GET', `/v1/public/links/${token}`, undefined, {
      'X-Harbor-Link-Pass': pass,
    });
    expect((await old.json()).passwordRequired).toBe(true);
    const removed = await request('PATCH', `/v1/links/${link.id}`, { password: null });
    expect((await removed.json()).link.hasPassword).toBe(false);
    expect((await (await visit('GET', `/v1/public/links/${token}`)).json()).item.name).toBe(
      'notes.txt',
    );
  });

  it('stop working when the owner is suspended', async () => {
    await flagOn();
    await age(8);
    const file = await upload('notes.txt');
    const { token } = await createLink({ driveItemId: file.id });
    await transact(service.repo, async (tx) => {
      const account = (await tx.get<Account>(userPK(aliceId), 'PROFILE'))!;
      await tx.put(userPK(aliceId), 'PROFILE', {
        ...account,
        suspendedAt: new Date().toISOString(),
      });
    });
    expect((await visit('GET', `/v1/public/links/${token}`)).status).toBe(404);
  });

  it('refuse malformed tokens without a lookup', async () => {
    expect((await visit('GET', '/v1/public/links/not-a-token')).status).toBe(404);
  });
});
