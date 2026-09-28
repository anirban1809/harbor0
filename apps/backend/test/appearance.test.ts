import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/api';
import { DevelopmentAuth } from '../src/auth';
import { StorageService } from '../src/domain';
import { MemoryRepository } from '../src/repository';
import { MemoryStorage } from '../src/storage';

const appearance = {
  preference: 'dark',
  preset: 'ocean',
  palettes: { light: { primary: '#123456' }, dark: { sidebar: '#112233' } },
};
async function setup() {
  const repo = new MemoryRepository();
  const storage = new MemoryStorage();
  const service = new StorageService(repo, storage);
  const { app } = createApp(service, new DevelopmentAuth());
  async function login(email: string) {
    const response = await app.request('/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'Development-only-123!' }),
    });
    expect(response.status).toBe(200);
    return {
      Authorization: `Bearer ${(await response.json()).accessToken}`,
      'Content-Type': 'application/json',
    };
  }
  return { app, repo, storage, login };
}
describe('account appearance', () => {
  it('persists across sessions, preserves profile edits, and isolates accounts', async () => {
    const { app, repo, storage, login } = await setup();
    const headers = await login('alice@example.test');
    const patch = await app.request('/v1/users/me', {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ operationId: randomUUID(), appearance }),
    });
    expect(patch.status).toBe(200);
    expect((await patch.json()).user.appearance).toEqual(appearance);
    const secondSession = await login('alice@example.test');
    expect(
      (await (await app.request('/v1/users/me', { headers: secondSession })).json()).user
        .appearance,
    ).toEqual(appearance);
    const restarted = new StorageService(repo, storage);
    await restarted.updateProfile('alice', { operationId: randomUUID(), displayName: 'New name' });
    expect((await restarted.me('alice')).user.appearance).toEqual(appearance);
    const bob = await login('bob@example.test');
    expect(
      (await (await app.request('/v1/users/me', { headers: bob })).json()).user.appearance,
    ).toBeUndefined();
    expect((await restarted.me('alice')).user.displayName).toBe('New name');
  });
  it('rejects invalid preferences and unauthenticated writes', async () => {
    const { app, login } = await setup();
    const headers = await login('alice@example.test');
    for (const invalid of [
      { ...appearance, preset: 'unknown' },
      { ...appearance, preference: 'unknown' },
      { ...appearance, palettes: { light: { primary: 'url(https://example.test)' }, dark: {} } },
      { ...appearance, palettes: { light: { unsupported: '#ffffff' }, dark: {} } },
    ]) {
      const response = await app.request('/v1/users/me', {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ operationId: randomUUID(), appearance: invalid }),
      });
      expect(response.status).toBe(400);
    }
    const response = await app.request('/v1/users/me', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operationId: randomUUID(), appearance }),
    });
    expect(response.status).toBe(401);
  });
});
