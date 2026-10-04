import { expect, it } from 'vitest';
import { createApp } from '../src/api';
import { DevelopmentAuth } from '../src/auth';
import { StorageService } from '../src/domain';
import { MemoryRepository } from '../src/repository';
import { MemoryStorage } from '../src/storage';

it('reports a reused refresh token as an expired session, not a server error', async () => {
  const auth = new DevelopmentAuth();
  auth.refresh = async () => {
    throw Object.assign(new Error('Refresh token has been revoked'), {
      name: 'RefreshTokenReuseException',
    });
  };
  const { app } = createApp(new StorageService(new MemoryRepository(), new MemoryStorage()), auth);
  const response = await app.request('/v1/auth/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: 'rotated' }),
  });
  expect(response.status).toBe(401);
  expect((await response.json()).error.code).toBe('AUTH_INVALID');
});
