import { beforeEach, expect, it } from 'vitest';
import { ApiClient, ApiError } from '@harbor/api-client';
import type { ActivityEvent } from '@harbor/contracts';
import { Journal } from '../src/journal';
import { ActivityReporter, SYNC_IDLE_MS, type ActivitySubject } from '../src/activity';

let journal: Journal, sent: ActivityEvent[][], now: number, reply: () => unknown;
const reporter = () =>
  new ActivityReporter(
    new ApiClient(async (url, init) => {
      expect(url).toBe('/v1/activity');
      const result = reply();
      if (result instanceof Error) throw result;
      sent.push((init?.body as { events: ActivityEvent[] }).events);
      return { accepted: 1, changed: 1 };
    }),
    journal,
    () => now,
  );
const engine = (status: ActivitySubject['status'], reason?: ActivitySubject['reason']) =>
  ({ scope: 'ENGINE', status, ...(reason ? { reason } : {}) }) as ActivitySubject;
const sync = (status: ActivitySubject['status'], extra: Partial<ActivitySubject> = {}) =>
  ({ scope: 'SYNC', folderId: 'folder-1', status, ...extra }) as ActivitySubject;
const actions = () => sent.flat().map((e) => `${e.scope}:${e.action}`);

beforeEach(() => {
  journal = new Journal(':memory:');
  sent = [];
  now = Date.UTC(2026, 9, 18, 12);
  reply = () => ({});
});

it('reports each change of status once, as pause, resume, start and finish', async () => {
  const r = reporter();
  r.observe([engine('ACTIVE'), sync('IDLE')]);
  r.observe([engine('ACTIVE'), sync('IDLE')]); // nothing new
  r.observe([engine('PAUSED', 'USER'), sync('PAUSED', { reason: 'ALL' })]);
  r.observe([engine('ACTIVE'), sync('ACTIVE', { files: 3 })]);
  r.fileMoved('folder-1');
  r.fileMoved('folder-1');
  now += SYNC_IDLE_MS + 1;
  r.observe([engine('ACTIVE'), sync('IDLE', { failed: 1 })]);
  await r.flush();
  expect(actions()).toEqual([
    'ENGINE:STARTED',
    'SYNC:IDLE',
    'ENGINE:PAUSED',
    'SYNC:PAUSED',
    'ENGINE:RESUMED',
    'SYNC:RESUMED',
    'SYNC:FINISHED',
  ]);
  const events = sent.flat();
  expect(events[3]).toMatchObject({ status: 'PAUSED', reason: 'ALL', folderId: 'folder-1' });
  // Finished with what it moved since it started, and the problems left.
  expect(events[6]).toMatchObject({ status: 'IDLE', files: 2, failed: 1 });
});

it('counts a sync folder idle only after a quiet spell, so a burst of edits is one start', async () => {
  const r = reporter();
  r.observe([sync('ACTIVE', { files: 1 })]);
  now += 1_000;
  r.observe([sync('IDLE')]);
  now += 1_000;
  r.observe([sync('ACTIVE', { files: 2 })]);
  now += SYNC_IDLE_MS + 1;
  r.observe([sync('IDLE')]);
  await r.flush();
  expect(actions()).toEqual(['SYNC:STARTED', 'SYNC:FINISHED']);
});

it('keeps unsent events across restarts and sends them once the server answers', async () => {
  reply = () => new TypeError('offline');
  const r = reporter();
  r.observe([engine('BLOCKED', 'STORAGE_FULL')]);
  await r.flush();
  expect(sent).toEqual([]);
  reply = () => ({});
  // A restart neither loses the event nor reports the same status again.
  const again = reporter();
  again.observe([engine('BLOCKED', 'STORAGE_FULL')]);
  await again.flush();
  expect(actions()).toEqual(['ENGINE:BLOCKED']);
  expect(sent.flat()[0]!.at).toBe(new Date(now).toISOString());
});

it('forgets a folder that is gone, and stops for a server without the route', async () => {
  const r = reporter();
  r.observe([sync('IDLE')]);
  r.observe([]);
  r.observe([sync('IDLE')]);
  reply = () => new ApiError('NOT_FOUND', 'Not found', 404);
  await r.flush();
  expect(sent).toEqual([]);
  reply = () => ({});
  r.observe([sync('ACTIVE')]);
  await r.flush();
  expect(sent).toEqual([]);
});
