import { beforeEach, describe, expect, it } from 'vitest';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { deviceProofMessage } from '@harbor/contracts';
import { createApp } from '../src/api';
import { DevelopmentAuth, type Tokens } from '../src/auth';
import { StorageService, userPK } from '../src/domain';
import { MemoryRepository, transact } from '../src/repository';
import { MemoryStorage } from '../src/storage';
import { resetDevices } from '../src/device-reset';
import { Backups } from '../src/backups';

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
    // A signed-out session must sign in again; only a revoked device is refused outright.
    expect((await post('/v1/auth/refresh', { refreshToken: first.refreshToken })).status).toBe(401);
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

  it('lists only connected devices, leaving signed-out ones out', async () => {
    const { app } = createApp(service, new DevelopmentAuth());
    await service.registerDevice('alice', installation, 'dev-alice');
    await service.registerDevice(
      'alice',
      { name: 'Old phone', platform: 'IOS', devicePublicId: 'old-phone' },
      'old-phone-session',
    );
    await service.revokeDevice('alice', 'old-phone-session');
    const response = await app.request('/v1/devices', {
      headers: { Authorization: 'Bearer dev-alice' },
    });
    expect((await response.json()).items.map((d: { name: string }) => d.name)).toEqual(['My Mac']);
    // The record stays, so the old phone's sessions are still refused.
    await expect(service.checkDevice('alice', 'old-phone-session')).rejects.toMatchObject({
      code: 'DEVICE_REVOKED',
    });
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
    await service.registerDevice(
      'alice',
      { ...installation, name: 'Work PC', devicePublicId: 'second' },
      'other',
    );
    await service.setSyncFolders('alice', 'mac', [a.id, b.id]);
    await service.setSyncFolders('alice', 'other', [a.id]);
    const folders = (await service.syncFolders('alice')).items;
    expect(folders.find((item) => item.id === a.id)?.syncDevices).toEqual([
      { id: 'mac', name: 'My Mac' },
      { id: 'other', name: 'Work PC' },
    ]);
    expect(folders.find((item) => item.id === b.id)?.syncDevices).toEqual([
      { id: 'mac', name: 'My Mac' },
    ]);
    expect((await service.syncFolders('bob')).items).toEqual([]);
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

describe('signed device identity', () => {
  const newKey = () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const spki = publicKey.export({ format: 'der', type: 'spki' });
    return { privateKey, spki, fingerprint: createHash('sha256').update(spki).digest('base64url') };
  };
  type Key = ReturnType<typeof newKey>;
  const register = async (
    key: Key,
    session: string,
    devicePublicId = key.fingerprint,
    user = 'alice',
  ) => {
    const { challenge } = await service.deviceChallenge(user, session);
    const message = deviceProofMessage(challenge, user, devicePublicId);
    const proof = {
      publicKey: key.spki.toString('base64url'),
      challenge,
      signature: sign('sha256', Buffer.from(message), key.privateKey).toString('base64url'),
    };
    return service.registerDevice(user, { ...installation, devicePublicId, proof }, session);
  };

  it('pins the first proven key and records its fingerprint across sessions', async () => {
    const key = newKey();
    const { device } = await register(key, 's1');
    expect(device).toMatchObject({
      devicePublicId: key.fingerprint,
      keyFingerprint: key.fingerprint,
    });
    await register(key, 's2');
    // An already-proven session may re-register without a new signature (e.g. a rename).
    await service.registerDevice(
      'alice',
      { ...installation, devicePublicId: key.fingerprint },
      's2',
    );
    const items = (await service.devices('alice')).items;
    expect(items).toHaveLength(1);
    expect(items[0].keyFingerprint).toBe(key.fingerprint);
  });

  it('rejects unsigned or differently keyed claims of a pinned identity', async () => {
    const key = newKey();
    await register(key, 's1');
    await expect(
      service.registerDevice(
        'alice',
        { ...installation, devicePublicId: key.fingerprint },
        'thief',
      ),
    ).rejects.toMatchObject({ code: 'DEVICE_PROOF_REQUIRED' });
    await expect(register(newKey(), 'thief', key.fingerprint)).rejects.toMatchObject({
      code: 'DEVICE_KEY_MISMATCH',
    });
  });

  it('binds an existing unsigned installation ID on its first signed registration', async () => {
    await service.registerDevice('alice', installation, 'old-session');
    const key = newKey();
    const { device } = await register(key, 'old-session', installation.devicePublicId);
    expect(device).toMatchObject({
      devicePublicId: installation.devicePublicId,
      keyFingerprint: key.fingerprint,
    });
    await expect(
      service.registerDevice('alice', installation, 'other-session'),
    ).rejects.toMatchObject({ code: 'DEVICE_PROOF_REQUIRED' });
  });

  it('rejects bad signatures, reused challenges and challenges from another session', async () => {
    const key = newKey();
    const { challenge } = await service.deviceChallenge('alice', 's1');
    const signed = (id: string, by = key) =>
      sign(
        'sha256',
        Buffer.from(deviceProofMessage(challenge, 'alice', id)),
        by.privateKey,
      ).toString('base64url');
    const proof = (signature: string) => ({
      publicKey: key.spki.toString('base64url'),
      challenge,
      signature,
    });
    const attempt = (session: string, signature: string) =>
      service.registerDevice(
        'alice',
        { ...installation, devicePublicId: key.fingerprint, proof: proof(signature) },
        session,
      );
    await expect(attempt('s1', signed('something-else'))).rejects.toMatchObject({
      code: 'DEVICE_PROOF_INVALID',
    });
    await expect(attempt('s1', signed(key.fingerprint, newKey()))).rejects.toMatchObject({
      code: 'DEVICE_PROOF_INVALID',
    });
    await expect(attempt('s2', signed(key.fingerprint))).rejects.toMatchObject({
      code: 'DEVICE_PROOF_INVALID',
    });
    await attempt('s1', signed(key.fingerprint));
    await expect(attempt('s1', signed(key.fingerprint))).rejects.toMatchObject({
      code: 'DEVICE_PROOF_INVALID',
    });
  });

  it('rejects keys that are not P-256', async () => {
    const { publicKey } = generateKeyPairSync('ed25519');
    await expect(
      service.registerDevice(
        'alice',
        {
          ...installation,
          devicePublicId: 'x',
          proof: {
            publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
            challenge: (await service.deviceChallenge('alice', 's1')).challenge,
            signature: 'AA',
          },
        },
        's1',
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('keeps identities separate per account', async () => {
    const key = newKey();
    await register(key, 'a1');
    // The same key in another account is a separate binding, not a shared identity.
    await register(key, 'b1', key.fingerprint, 'bob');
    expect((await service.devices('bob')).items).toHaveLength(1);
    await expect(
      service.registerDevice('bob', { ...installation, devicePublicId: key.fingerprint }, 'b2'),
    ).rejects.toMatchObject({ code: 'DEVICE_PROOF_REQUIRED' });
  });

  it('serves challenges to sessions before they are registered', async () => {
    const auth = new DevelopmentAuth();
    const { app } = createApp(service, auth);
    const { accessToken } = (await auth.login(
      'alice@example.test',
      'Development-only-123!',
    )) as Tokens;
    const headers = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };
    const challenged = await app.request('/v1/auth/session/challenge', { method: 'POST', headers });
    expect(challenged.status).toBe(200);
    const { challenge } = await challenged.json();
    const key = newKey();
    const registered = await app.request('/v1/auth/session', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        ...installation,
        devicePublicId: key.fingerprint,
        proof: {
          publicKey: key.spki.toString('base64url'),
          challenge,
          signature: sign(
            'sha256',
            Buffer.from(deviceProofMessage(challenge, 'alice', key.fingerprint)),
            key.privateKey,
          ).toString('base64url'),
        },
      }),
    });
    expect(registered.status).toBe(200);
    expect((await registered.json()).device.keyFingerprint).toBe(key.fingerprint);
  });
});

describe('resetting devices', () => {
  it('forgets every sign-in so devices register again, keeping backups with their installation', async () => {
    await service.registerDevice('alice', installation, 'mac-1');
    await service.registerDevice('alice', installation, 'mac-2');
    await service.registerDevice('alice', { name: 'Web browser', platform: 'WEB' }, 'web-1');
    const { root } = await service.backupRoot('alice', {
      operationId: crypto.randomUUID(),
      deviceId: 'mac-1',
      name: 'Documents',
    });
    // A backup from before backups recorded their installation.
    await transact(repo, async (tx) => {
      const row = await tx.get<Record<string, unknown>>(userPK('alice'), `BACKUP#${root.id}`);
      const { devicePublicId: _, ...legacy } = row!;
      await tx.put(userPK('alice'), `BACKUP#${root.id}`, legacy);
    });
    expect(await resetDevices(repo, 'alice', false)).toEqual({
      devices: 3,
      pushes: 0,
      backups: 1,
    });
    expect((await service.devices('alice')).items).toHaveLength(2);
    await resetDevices(repo, 'alice', true);
    expect((await service.devices('alice')).items).toHaveLength(0);
    await expect(service.checkDevice('alice', 'mac-2')).rejects.toMatchObject({
      code: 'DEVICE_REVOKED',
    });
    // Signing in again registers the device, and it can still run its backup.
    await service.registerDevice('alice', installation, 'mac-3');
    expect((await service.devices('alice')).items).toHaveLength(1);
    const [listed] = (await service.backups('alice')).items;
    expect(listed).toMatchObject({ devicePublicId: 'mac-install', deviceName: 'My Mac' });
    await expect(
      new Backups(service).start('alice', root.id, 'mac-3', {
        id: crypto.randomUUID(),
        trigger: 'MANUAL',
      }),
    ).resolves.toMatchObject({ run: { state: 'RUNNING' } });
  });

  it('lists a device once however often it signs in, matching sessions by key fingerprint', async () => {
    const pk = userPK('alice');
    for (const [id, publicId] of [
      ['phone-1', 'phone'],
      ['phone-2', null],
      ['phone-3', 'phone'],
    ] as const)
      await transact(repo, async (tx) => {
        await tx.put(pk, `DEVICE#${id}`, {
          id,
          userId: 'alice',
          name: 'Phone',
          platform: 'IOS',
          appVersion: null,
          devicePublicId: publicId,
          keyFingerprint: 'same-key',
          createdAt: '2026-10-01T00:00:00.000Z',
          lastSeenAt: '2026-10-01T00:00:00.000Z',
          revokedAt: null,
        });
      });
    expect((await service.devices('alice')).items).toHaveLength(1);
  });
});

describe('browser device keys', () => {
  it('accepts proofs signed with Web Crypto, which uses raw r‖s signatures', async () => {
    const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, [
      'sign',
      'verify',
    ]);
    const spki = Buffer.from(await crypto.subtle.exportKey('spki', keys.publicKey));
    const fingerprint = createHash('sha256').update(spki).digest('base64url');
    const { challenge } = await service.deviceChallenge('alice', 'web-session');
    const signature = Buffer.from(
      await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        keys.privateKey,
        new TextEncoder().encode(deviceProofMessage(challenge, 'alice', fingerprint)),
      ),
    );
    expect(signature).toHaveLength(64);
    const { device } = await service.registerDevice(
      'alice',
      {
        name: 'Chrome on macOS',
        platform: 'WEB',
        devicePublicId: fingerprint,
        proof: {
          challenge,
          publicKey: spki.toString('base64url'),
          signature: signature.toString('base64url'),
        },
      },
      'web-session',
    );
    expect(device.keyFingerprint).toBe(fingerprint);
  });
});

describe('signing out and revoking a device', () => {
  const setUp = async () => {
    await service.registerDevice('alice', installation, 'mac-1');
    await service.registerDevice(
      'alice',
      { name: 'My Phone', platform: 'IOS', devicePublicId: 'phone' },
      'phone-1',
    );
    const { item } = await service.createFolder('alice', {
      name: 'Notes',
      parentId: null,
      operationId: crypto.randomUUID(),
    });
    await service.setSyncFolders('alice', 'mac-1', [item.id]);
    await service.setSyncFolders('alice', 'phone-1', [item.id]);
    const { root } = await service.backupRoot('alice', {
      operationId: crypto.randomUUID(),
      deviceId: 'mac-1',
      name: 'Documents',
    });
    return { folder: item, root };
  };
  const listed = async () =>
    (await service.devices('alice')).items.map((d) => [d.name, d.status ?? 'ACTIVE']);

  it('signing out pauses a device: it stays listed and resumes at the next sign-in', async () => {
    const { root } = await setUp();
    await service.signOutDevice('alice', 'mac-1');
    expect(await listed()).toContainEqual(['My Mac', 'SIGNED_OUT']);
    await expect(service.checkDevice('alice', 'mac-1')).rejects.toMatchObject({
      code: 'AUTH_INVALID',
    });
    // Still a member of its sync folder, and its backup is untouched.
    const [synced] = (await service.syncFolders('alice')).items;
    expect(synced.syncDevices.map((d) => d.name).sort()).toEqual(['My Mac', 'My Phone']);
    expect((await service.backups('alice')).items[0].state).toBe('ACTIVE');
    await service.registerDevice('alice', installation, 'mac-2');
    expect(await listed()).toContainEqual(['My Mac', 'ACTIVE']);
    await expect(
      new Backups(service).start('alice', root.id, 'mac-2', {
        id: crypto.randomUUID(),
        trigger: 'MANUAL',
      }),
    ).resolves.toMatchObject({ run: { state: 'RUNNING' } });
  });

  it('revoking removes a device, stops its sync and archives its backups', async () => {
    await setUp();
    const { archivedBackups } = await service.revokeDevice('alice', 'mac-1');
    expect(archivedBackups).toBe(1);
    // Only the phone is still connected; the revoked Mac is gone from the list.
    expect((await listed()).filter(([, status]) => status !== 'REVOKED')).toEqual([
      ['My Phone', 'ACTIVE'],
    ]);
    await expect(service.checkDevice('alice', 'mac-1')).rejects.toMatchObject({
      code: 'DEVICE_REVOKED',
    });
    const [synced] = (await service.syncFolders('alice')).items;
    expect(synced.syncDevices.map((d) => d.id)).toEqual(['phone-1']);
    const [backup] = (await service.backups('alice')).items;
    expect(backup.state).toBe('ARCHIVED');
    // Signing in again later registers it as a new connection.
    await service.registerDevice('alice', installation, 'mac-3');
    expect((await service.checkDevice('alice', 'mac-3')).status).toBe('ACTIVE');
  });
});
