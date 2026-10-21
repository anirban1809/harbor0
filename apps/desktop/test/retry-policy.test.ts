import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ApiClient } from '@harbor/api-client';
import { Journal, type LocalJob, type Root } from '../src/journal';
import { BACKUP_QUIET_MS, FolderBackups } from '../src/backups';
import { GAVE_UP_ATTEMPTS, GIVE_UP_AFTER, retryDelay } from '../src/retry-policy';

it('waits twice as long after each failure, up to a limit', () => {
  expect([1, 2, 3, 4].map((n) => retryDelay(n, 60_000, 600_000))).toEqual([
    60_000, 120_000, 240_000, 480_000,
  ]);
  expect(retryDelay(9, 60_000, 600_000)).toBe(600_000);
  expect(retryDelay(500, 60_000, 600_000)).toBe(600_000);
});

let directory: string, journal: Journal, root: Root, backups: FolderBackups;
let tries: number, runs: number, now: number;
const failing = async (_root: Root, _job: LocalJob) => {
  tries++;
  // Refused by the app itself, as a name harbor0 can't take is: nothing retrying can fix.
  throw new Error('Another archived file has the same name with different capitalization.');
};
const process = (manual = false) => {
  if (manual) journal.set(`backup-now:${root.id}`, true);
  return backups.process(root, failing, () => false);
};
const job = () => journal.jobs()[0]!;

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'harbor-retry-'));
  journal = new Journal(':memory:');
  tries = 0;
  runs = 0;
  now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  root = {
    id: 'local',
    backupId: 'backup',
    localPath: directory,
    remoteId: 'remote',
    mode: 'backup',
    paused: false,
    excluded: [],
  };
  journal.root(root);
  const api = new ApiClient(async (url, init) => {
    if (url === '/v1/backups/backup') return { root: { state: 'ACTIVE' } };
    if (url.endsWith('/pending-restores')) return { items: [] };
    if (url === '/v1/backups/backup/runs' && init?.method === 'POST') runs++;
    return {};
  });
  backups = new FolderBackups(api, journal);
  await writeFile(path.join(directory, 'IMG_8692.mov'), 'a video');
  const old = new Date(now - BACKUP_QUIET_MS - 5000);
  await utimes(path.join(directory, 'IMG_8692.mov'), old, old);
  journal.enqueue(root.id, 'IMG_8692.mov', 'upsert');
});
afterEach(async () => {
  vi.restoreAllMocks();
  journal.close();
  await rm(directory, { recursive: true, force: true });
});

it('backs off a backup file that keeps failing, then stops until it changes or is asked for', async () => {
  const waits: number[] = [];
  for (let n = 1; n <= GIVE_UP_AFTER.backup; n++) {
    await process();
    expect(tries).toBe(n);
    if (n < GIVE_UP_AFTER.backup) {
      const wait = (job().payload.retryAfter as number) - now;
      waits.push(wait);
      // Not tried again before its wait is up.
      now += wait - 1000;
      await process();
      expect(tries).toBe(n);
      now += 1000;
    }
  }
  expect(waits).toEqual([60, 120, 240, 480, 960, 1920, 3840].map((m) => m * 1000));
  // Given up: no more tries or runs, however long it waits.
  expect(job()).toMatchObject({ attempts: GAVE_UP_ATTEMPTS });
  expect(job().error).toContain('stopped retrying');
  expect(journal.pendingCount(root.id)).toBe(0);
  const runsSoFar = runs;
  now += 30 * 24 * 3600_000;
  await process();
  expect([tries, runs]).toEqual([GIVE_UP_AFTER.backup, runsSoFar]);

  // Back up now tries it again.
  await process(true);
  expect(tries).toBe(GIVE_UP_AFTER.backup + 1);
  expect(job().attempts).toBe(1);
});

it('tries a given-up backup file again once it changes', async () => {
  for (let n = 1; n <= GIVE_UP_AFTER.backup; n++) {
    now = Math.max(now, (job().payload.retryAfter as number | undefined) ?? 0);
    await process();
  }
  expect(job().attempts).toBe(GAVE_UP_ATTEMPTS);
  // The person edits it (and it's been quiet since).
  await writeFile(path.join(directory, 'IMG_8692.mov'), 'an edited video');
  const later = new Date(now - BACKUP_QUIET_MS - 1000);
  await utimes(path.join(directory, 'IMG_8692.mov'), later, later);
  await process();
  expect(tries).toBe(GIVE_UP_AFTER.backup + 1);
  expect(job().attempts).toBe(1);
});
