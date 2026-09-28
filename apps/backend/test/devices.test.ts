import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/api';
import { DevelopmentAuth } from '../src/auth';
import { StorageService, userPK } from '../src/domain';
import { MemoryRepository, transact } from '../src/repository';
import { MemoryStorage } from '../src/storage';

let repo: MemoryRepository;
let service: StorageService;
const installation = { name: 'My Mac', platform: 'MACOS' as const, devicePublicId: 'mac-install' };
beforeEach(async () => {
  repo = new MemoryRepository();
  service = new StorageService(repo, new MemoryStorage());
  for (const id of ['alice', 'bob'])
    await service.ensureUser({
      id,
      email: `${id}@example.test`,
      emailVerified: true,
      username: id,
      displayName: id,
    });
});

describe('device installations and login sessions', () => {
  it('groups existing duplicates, prefers an active session, and keeps distinct installations/accounts separate', async () => {
    // Existing installations have session rows without a revocation version.
    for (const id of ['legacy-a', 'legacy-b']) {
      await transact(repo, async (tx) => {
        await tx.put(userPK('alice'), `DEVICE#${id}`, {
          ...installation,
          id,
          userId: 'alice',
          appVersion: null,
          createdAt: '2025-01-01T00:00:00.000Z',
          lastSeenAt: '2025-01-01T00:00:00.000Z',
          revokedAt: null,
        });
      });
    }
    await service.registerDevice('alice', installation, 'new-login');
    await service.revokeSession('alice', 'new-login');
    await service.registerDevice(
      'alice',
      { ...installation, devicePublicId: 'other-mac' },
      'other',
    );
    await service.registerDevice('bob', installation, 'bob-session');
    const devices = (await service.devices('alice')).items;
    expect(devices).toHaveLength(2);
    expect(devices.find((d) => d.devicePublicId === installation.devicePublicId)).toMatchObject({
      revokedAt: null,
      createdAt: '2025-01-01T00:00:00.000Z',
    });
    expect((await service.devices('bob')).items).toHaveLength(1);
    await service.revokeDevice('alice', 'legacy-a');
    for (const id of ['legacy-a', 'legacy-b', 'new-login'])
      await expect(service.checkDevice('alice', id)).rejects.toMatchObject({
        code: 'DEVICE_REVOKED',
      });
    await expect(service.checkDevice('alice', 'other')).resolves.toBeDefined();
    await expect(service.checkDevice('bob', 'bob-session')).resolves.toBeDefined();
  });

  it('keeps sessions without an installation ID separate and preserves an assigned identity', async () => {
    await service.registerDevice('alice', { name: 'Browser', platform: 'WEB' }, 'web-a');
    await service.registerDevice('alice', { name: 'Browser', platform: 'WEB' }, 'web-b');
    await service.registerDevice('alice', installation, 'mac');
    const { device } = await service.registerDevice(
      'alice',
      { name: 'Renamed Mac', platform: 'MACOS' },
      'mac',
    );
    expect(device.devicePublicId).toBe(installation.devicePublicId);
    expect((await service.devices('alice')).items).toHaveLength(3);
    await expect(
      service.registerDevice('alice', { ...installation, devicePublicId: 'replacement' }, 'mac'),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('revokes over 100 historical sessions atomically and allows only fresh logins afterward', async () => {
    for (let i = 0; i < 105; i++)
      await service.registerDevice('alice', installation, `session-${i}`);
    expect((await service.devices('alice')).items).toHaveLength(1);
    await service.revokeDevice('alice', 'session-0');
    expect((await service.devices('alice')).items[0].revokedAt).not.toBeNull();
    for (const id of ['session-0', 'session-50', 'session-104']) {
      await expect(service.checkDevice('alice', id)).rejects.toMatchObject({
        code: 'DEVICE_REVOKED',
      });
      await expect(service.registerDevice('alice', installation, id)).rejects.toMatchObject({
        code: 'DEVICE_REVOKED',
      });
    }
    await service.registerDevice('alice', installation, 'fresh-login');
    const { items } = await service.devices('alice');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: 'fresh-login', revokedAt: null });
    expect(items[0]).not.toHaveProperty('revocationVersion');
    await expect(service.checkDevice('alice', 'session-104')).rejects.toMatchObject({
      code: 'DEVICE_REVOKED',
    });
    await service.revokeDevice('alice', 'fresh-login');
    await expect(service.checkDevice('alice', 'fresh-login')).rejects.toMatchObject({
      code: 'DEVICE_REVOKED',
    });
  });

  it('keeps one listed device across login/logout and rejects revoked access, refresh and registration', async () => {
    const { app } = createApp(service, new DevelopmentAuth());
    const post = (url: string, body: unknown, token?: string) =>
      app.request(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      });
    const login = async () => {
      const response = await post('/v1/auth/login', {
        email: 'alice@example.test',
        password: 'Development-only-123!',
      });
      expect(response.status).toBe(200);
      const tokens = await response.json();
      const registered = await post('/v1/auth/session', installation, tokens.accessToken);
      expect(registered.status).toBe(200);
      return { ...tokens, ...(await registered.json()) };
    };
    const first = await login();
    const second = await login();
    const headers = { Authorization: `Bearer ${second.accessToken}` };
    expect((await (await app.request('/v1/devices', { headers })).json()).items).toHaveLength(1);
    expect(
      (await post('/v1/auth/logout', { refreshToken: first.refreshToken }, first.accessToken))
        .status,
    ).toBe(200);
    expect((await app.request('/v1/users/me', { headers })).status).toBe(200);
    expect((await post('/v1/auth/refresh', { refreshToken: first.refreshToken })).status).toBe(403);
    const third = await login();
    const list = await app.request('/v1/devices', { headers });
    const { items } = await list.json();
    expect(items).toHaveLength(1);
    expect(
      (await app.request(`/v1/devices/${items[0].id}`, { method: 'DELETE', headers })).status,
    ).toBe(200);
    for (const session of [first, second, third]) {
      expect(
        (
          await app.request('/v1/users/me', {
            headers: { Authorization: `Bearer ${session.accessToken}` },
          })
        ).status,
      ).toBe(403);
      expect((await post('/v1/auth/refresh', { refreshToken: session.refreshToken })).status).toBe(
        403,
      );
      expect((await post('/v1/auth/session', installation, session.accessToken)).status).toBe(403);
    }
    await login();
    expect((await service.devices('alice')).items).toHaveLength(1);
  });
});

describe('synced folder visibility', () => {
  const folder = async (name: string, userId = 'alice', parentId: string | null = null) =>
    (await service.createFolder(userId, { name, parentId, operationId: crypto.randomUUID() })).item;

  it('serves folder mappings through authenticated API routes and rejects device spoofing', async () => {
    const item = await folder('Design');
    await service.registerDevice('alice', installation, 'dev-alice');
    const { app } = createApp(service, new DevelopmentAuth());
    const headers = { Authorization: 'Bearer dev-alice', 'Content-Type': 'application/json' };
    const updated = await app.request('/v1/sync/folders', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ folderIds: [item.id] }),
    });
    expect(updated.status).toBe(200);
    const result = await app.request('/v1/sync/folders', { headers });
    expect(result.status).toBe(200);
    expect((await result.json()).items.map((entry: { id: string }) => entry.id)).toEqual([item.id]);
    expect((await app.request('/v1/sync/folders')).status).toBe(401);
    expect(
      (
        await app.request('/v1/sync/folders', {
          method: 'PUT',
          headers,
          body: JSON.stringify({ folderIds: [], deviceId: 'someone-else' }),
        })
      ).status,
    ).toBe(400);
  });

  it('combines devices, deduplicates shared roots, and removes only the stopped mapping', async () => {
    const a = await folder('Design');
    const b = await folder('Nested', 'alice', a.id);
    await service.registerDevice('alice', installation, 'mac');
    await service.registerDevice('alice', { ...installation, devicePublicId: 'second' }, 'other');
    await service.setSyncFolders('alice', 'mac', [a.id, b.id]);
    await service.setSyncFolders('alice', 'other', [a.id]);
    expect((await service.syncFolders('alice')).items.map((item) => item.id).sort()).toEqual(
      [a.id, b.id].sort(),
    );
    await service.setSyncFolders('alice', 'mac', []);
    expect((await service.syncFolders('alice')).items.map((item) => item.id)).toEqual([a.id]);
    await service.setSyncFolders('alice', 'other', []);
    expect((await service.syncFolders('alice')).items).toEqual([]);
  });

  it('preserves installation identity across sign-ins and excludes revoked devices', async () => {
    const a = await folder('Design');
    const b = await folder('Projects');
    await service.registerDevice('alice', installation, 'old');
    await service.setSyncFolders('alice', 'old', [a.id]);
    await service.revokeSession('alice', 'old');
    await service.registerDevice('alice', installation, 'new');
    expect((await service.syncFolders('alice')).items.map((item) => item.id)).toEqual([a.id]);
    await service.setSyncFolders('alice', 'new', [b.id]);
    expect((await service.syncFolders('alice')).items.map((item) => item.id)).toEqual([b.id]);
    await service.revokeDevice('alice', 'new');
    expect((await service.syncFolders('alice')).items).toEqual([]);
    await expect(service.setSyncFolders('alice', 'new', [])).rejects.toMatchObject({
      code: 'DEVICE_REVOKED',
    });
  });

  it('does not expose another account or folders under a trashed parent', async () => {
    const parent = await folder('Projects');
    const nested = await folder('Nested', 'alice', parent.id);
    const foreign = await folder('Private', 'bob');
    await service.registerDevice('alice', installation, 'mac');
    await service.setSyncFolders('alice', 'mac', [nested.id, foreign.id, 'missing']);
    expect((await service.syncFolders('alice')).items.map((item) => item.id)).toEqual([nested.id]);
    expect((await service.syncFolders('bob')).items).toEqual([]);
    await service.mutate('alice', parent.id, {
      operationId: crypto.randomUUID(),
      baseRevision: parent.revision,
      action: 'trash',
    });
    expect((await service.syncFolders('alice')).items).toEqual([]);
  });
});
