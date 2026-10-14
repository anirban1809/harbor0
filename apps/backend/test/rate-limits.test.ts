import { expect, it } from 'vitest';
import { BULK_RATE_LIMIT, RATE_LIMIT, bulkTransferPath } from '@harbor/contracts';
import { createApp } from '../src/api';
import { DevelopmentAuth } from '../src/auth';
import { StorageService } from '../src/domain';
import { MemoryRepository } from '../src/repository';
import { MemoryStorage } from '../src/storage';

it('counts uploads and backup runs apart from everything else', () => {
  for (const path of [
    '/v1/uploads',
    '/v1/uploads/:id/parts',
    '/v1/uploads/abc/complete',
    '/v1/backups/:id/runs/:runId/uploads/batch',
    '/v1/backups/b1/runs/r1/files',
  ])
    expect(bulkTransferPath(path)).toBe(true);
  for (const path of ['/v1/users/me', '/v1/backups', '/v1/backups/:id/runs', '/v1/uploadsx'])
    expect(bulkTransferPath(path)).toBe(false);
  expect(BULK_RATE_LIMIT).toBeGreaterThan(RATE_LIMIT);
});

it('keeps answering backup uploads after the general allowance is used up', async () => {
  const service = new StorageService(new MemoryRepository(), new MemoryStorage());
  const { app } = createApp(service, new DevelopmentAuth());
  const login = await (
    await app.request('/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'alice@example.test',
        password: 'Development-only-123!',
        deviceName: 'Mac',
        platform: 'MACOS',
      }),
    })
  ).json();
  const headers = { Authorization: `Bearer ${login.accessToken}` };
  // Stay inside one minute's window so the counts can't reset midway.
  const second = Date.now() % 60_000;
  if (second > 50_000) await new Promise((resolve) => setTimeout(resolve, 61_000 - second));
  for (let index = 0; index < RATE_LIMIT; index++)
    expect((await app.request('/v1/users/me', { headers })).status).toBe(200);
  expect((await app.request('/v1/users/me', { headers })).status).toBe(429);
  // A bulk route has its own allowance: refused for the missing upload, not the rate.
  const upload = await app.request('/v1/uploads/missing', { headers });
  expect(upload.status).toBe(404);
}, 90_000);
