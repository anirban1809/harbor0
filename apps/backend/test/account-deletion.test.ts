import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/api';
import { DevelopmentAuth } from '../src/auth';
import { ACCOUNT_PURGE_DELAY_MS, StorageService, userPK, type Job } from '../src/domain';
import { MemoryRepository, transact } from '../src/repository';
import { MemoryStorage } from '../src/storage';

const op = () => randomUUID();
async function setup() {
  const repo = new MemoryRepository();
  const service = new StorageService(repo, new MemoryStorage());
  const { app } = createApp(service, new DevelopmentAuth());
  async function login(email: string) {
    const response = await app.request('/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'Development-only-123!' }),
    });
    return {
      status: response.status,
      headers: {
        Authorization: `Bearer ${(await response.json()).accessToken}`,
        'Content-Type': 'application/json',
      },
    };
  }
  const remove = (headers: Record<string, string>, email: string) =>
    app.request('/v1/users/me/delete', {
      method: 'POST',
      headers,
      body: JSON.stringify({ operationId: op(), email }),
    });
  return { app, repo, service, login, remove };
}
describe('account deletion', () => {
  it('requires the account email as confirmation', async () => {
    const { app, login, remove } = await setup();
    const { headers } = await login('alice@example.test');
    const response = await remove(headers, 'bob@example.test');
    expect(response.status).toBe(400);
    expect((await app.request('/v1/users/me', { headers })).status).toBe(200);
  });

  it('signs the account out, keeps its data for 30 days, and frees the email and username', async () => {
    const { app, repo, service, login, remove } = await setup();
    const { headers } = await login('alice@example.test');
    const { item } = await service.createFolder('alice', {
      operationId: op(),
      parentId: null,
      name: 'Photos',
    });
    const response = await remove(headers, 'Alice@example.test');
    expect(response.status).toBe(200);
    const { deletedAt, purgeAt } = await response.json();
    expect(Date.parse(purgeAt) - Date.parse(deletedAt)).toBe(ACCOUNT_PURGE_DELAY_MS);

    expect((await app.request('/v1/users/me', { headers })).status).toBe(401);
    expect((await login('alice@example.test')).status).toBe(401);
    await expect(
      service.ensureUser({
        id: 'alice',
        email: 'alice@example.test',
        emailVerified: true,
        username: 'alice',
        displayName: 'Alice',
      }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_DELETED' });
    expect((await service.lookup('alice')).users).toEqual([]);
    expect(await repo.get({ pk: 'EMAIL', sk: 'alice@example.test' })).toBeUndefined();

    // Nothing is purged during the grace period.
    await service.runJobs();
    expect(await repo.get({ pk: userPK('alice'), sk: `ITEM#${item.id}` })).toBeDefined();
    const job = (await repo.get({ pk: 'JOB', sk: 'account-alice' }))!.data as Job;
    expect(job.dueAt).toBe(purgeAt);

    // Unfinished jobs are rescheduled into the future, so pull each one forward again.
    const due = (id: string) =>
      transact(repo, async (tx) => {
        const current = await tx.get<Job>('JOB', id);
        if (current) await service.job(tx, { ...current, dueAt: new Date().toISOString() });
      });
    for (let n = 0; n < 5; n++) {
      await due('account-alice');
      await due(`purge-${item.id}`);
      await service.runJobs();
    }
    expect(await repo.get({ pk: userPK('alice'), sk: `ITEM#${item.id}` })).toBeUndefined();
    expect(await repo.get({ pk: 'JOB', sk: 'account-alice' })).toBeUndefined();
  });

  it('cuts off shared access to a deleted account', async () => {
    const { service, login, remove } = await setup();
    const { headers } = await login('alice@example.test');
    await login('bob@example.test');
    const { item } = await service.createFolder('alice', {
      operationId: op(),
      parentId: null,
      name: 'Shared',
    });
    await service.createShare('alice', {
      operationId: op(),
      driveItemId: item.id,
      recipient: { type: 'USERNAME', value: 'bob' },
      permission: 'VIEWER',
    });
    await expect(service.sharedList('bob', item.id, 10)).resolves.toBeDefined();
    expect((await remove(headers, 'alice@example.test')).status).toBe(200);
    await expect(service.sharedList('bob', item.id, 10)).rejects.toMatchObject({
      code: 'ITEM_NOT_FOUND',
    });
  });
});
