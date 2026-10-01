import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import chokidar from 'chokidar';
import { ApiClient } from '@harbor/api-client';
import { Journal, type Root } from '../src/journal';
import { SyncEngine } from '../src/sync';

vi.mock('chokidar', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    default: { watch: vi.fn(() => Object.assign(new EventEmitter(), { close: async () => {} })) },
  };
});
let directory: string;
let journal: Journal;
let engine: SyncEngine;
let root: Root;
let checks: number;
let hold: Promise<void> | undefined;
let release: (() => void) | undefined;
let updates: any[];
beforeEach(async () => {
  vi.useFakeTimers();
  checks = 0;
  hold = undefined;
  release = undefined;
  updates = [];
  directory = await mkdtemp(path.join(os.tmpdir(), 'harbor-scheduling-'));
  journal = new Journal(':memory:');
  root = {
    id: 'root',
    localPath: directory,
    remoteId: 'remote',
    mode: 'sync',
    paused: false,
    excluded: [],
  };
  engine = new SyncEngine(
    new ApiClient(async (endpoint) => {
      if (endpoint.includes('/changes')) {
        checks++;
        await hold;
        return { changes: [], nextCursor: 0, hasMore: false };
      }
      return {};
    }),
    journal,
    'device',
    (state) => updates.push(state),
  );
});
afterEach(async () => {
  release?.();
  await engine.stop();
  await vi.advanceTimersByTimeAsync(0);
  journal.close();
  vi.useRealTimers();
  await rm(directory, { recursive: true, force: true });
});

it('coalesces watcher bursts and starts work without waiting for the periodic poll', async () => {
  journal.root(root);
  await engine.watch(root);
  const watcher = vi.mocked(chokidar.watch).mock.results.at(-1)!.value;
  for (let i = 0; i < 10; i++) watcher.emit('add', path.join(directory, `file-${i}`));
  expect(journal.jobCount()).toBe(10);
  await vi.advanceTimersByTimeAsync(50);
  expect(updates.at(-1).queued).toBe(10);
  expect(updates).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(99);
  expect(checks).toBe(0);
  await vi.advanceTimersByTimeAsync(1);
  await vi.waitFor(() => expect(journal.jobCount()).toBe(0));
  expect(checks).toBe(1);
});

it('publishes new queued files immediately even while sync is paused', async () => {
  journal.root(root);
  await engine.watch(root);
  engine.pause(true);
  const watcher = vi.mocked(chokidar.watch).mock.results.at(-1)!.value;
  watcher.emit('add', path.join(directory, 'waiting.txt'));
  await vi.advanceTimersByTimeAsync(50);
  expect(updates.at(-1)).toMatchObject({ paused: true, queued: 1, active: null });
  await vi.advanceTimersByTimeAsync(2000);
  expect(checks).toBe(0);
  expect(journal.jobCount()).toBe(1);
});

it('ignores late watcher events for removed folders while keeping other folders active', async () => {
  journal.root(root);
  await engine.watch(root);
  engine.pause(true);
  const watcher = vi.mocked(chokidar.watch).mock.results.at(-1)!.value;
  journal.root({ ...root, excluded: ['removed'] });
  watcher.emit('change', path.join(directory, 'removed', 'local-edit.txt'));
  watcher.emit('change', path.join(directory, 'active.txt'));
  expect(journal.jobs().map((job) => job.relativePath)).toEqual(['active.txt']);
  journal.removeRoot(root.id);
  watcher.emit('change', path.join(directory, 'late-edit.txt'));
  expect(journal.jobCount()).toBe(0);
});

it('schedules another pass for changes arriving during a running sync', async () => {
  journal.root(root);
  await engine.watch(root);
  hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const work = engine.tick();
  await vi.waitFor(() => expect(checks).toBe(1));
  const watcher = vi.mocked(chokidar.watch).mock.results.at(-1)!.value;
  watcher.emit('add', path.join(directory, 'arrived-during-sync'));
  release!();
  await work;
  expect(journal.jobCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(150);
  await vi.waitFor(() => expect(journal.jobCount()).toBe(0));
  expect(checks).toBe(2);
});

it('backs off idle cloud checks to 30 seconds, wakes immediately, and cancels checks on stop', async () => {
  const start = Date.now();
  await engine.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(checks).toBe(1);
  // Each quiet check doubles the wait: 4s, 8s, 16s, then 30s.
  for (const [at, expected] of [
    [2000, 1],
    [4000, 2],
    [12000, 3],
    [28000, 4],
    [58000, 5],
    [88000, 6],
  ]) {
    await vi.advanceTimersByTimeAsync(at - Date.now() + start);
    expect(checks).toBe(expected);
  }
  engine.wake();
  await vi.advanceTimersByTimeAsync(150);
  expect(checks).toBe(7);
  // After a wake the next quiet check is 4s away again (on the next 2s timer tick), not 30s.
  await vi.advanceTimersByTimeAsync(6000);
  expect(checks).toBe(8);
  await engine.stop();
  await vi.advanceTimersByTimeAsync(60000);
  expect(checks).toBe(8);
});

it('stretches idle checks beyond 30 seconds only while live updates are connected', async () => {
  const start = Date.now();
  await engine.start();
  engine.setLive(true);
  await vi.advanceTimersByTimeAsync(0);
  // 4s, 8s, 16s, then 32s: past the 30s ceiling that applies without live updates.
  await vi.advanceTimersByTimeAsync(58000 - (Date.now() - start));
  expect(checks).toBe(4);
  await vi.advanceTimersByTimeAsync(2000);
  expect(checks).toBe(5);
  // The next check was 64s away; losing the connection brings it back within 30s.
  engine.setLive(false);
  await vi.advanceTimersByTimeAsync(30000);
  expect(checks).toBe(6);
});

it('keeps two-second checks while remote changes arrive and checkpoints only a moved cursor', async () => {
  let sequence = 0;
  const checkpoints: number[] = [];
  engine = new SyncEngine(
    new ApiClient(async (endpoint, init) => {
      if (endpoint.includes('/changes')) {
        checks++;
        // Two busy checks, then quiet.
        if (sequence >= 2) return { changes: [], nextCursor: sequence, hasMore: false };
        sequence++;
        return {
          changes: [{ sequence, type: 'NOOP', entityId: 'x' }],
          nextCursor: sequence,
          hasMore: false,
        };
      }
      if (endpoint === '/v1/sync/checkpoints')
        checkpoints.push((init?.body as { cursor: number }).cursor);
      return {};
    }),
    journal,
    'device',
    () => {},
  );
  await engine.start();
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(2000);
  await vi.advanceTimersByTimeAsync(2000);
  expect(checks).toBe(3);
  expect(checkpoints).toEqual([1, 2]);
  // Quiet from here: the next check waits 4s and sends no checkpoint.
  await vi.advanceTimersByTimeAsync(2000);
  expect(checks).toBe(3);
  await vi.advanceTimersByTimeAsync(2000);
  expect(checks).toBe(4);
  expect(checkpoints).toEqual([1, 2]);
});

it('publishes paused sync mappings, retries offline, and removes stopped roots without publishing backups', async () => {
  const calls: string[][] = [];
  let offline = true;
  engine = new SyncEngine(
    new ApiClient(async (endpoint, init) => {
      if (endpoint === '/v1/sync/folders') {
        calls.push((init?.body as { folderIds: string[] }).folderIds);
        if (offline) throw new Error('Offline');
      }
      return {};
    }),
    journal,
    'device',
    () => {},
  );
  journal.root({ ...root, paused: true });
  journal.root({ ...root, id: 'backup', mode: 'backup', remoteId: 'backup-cloud' });
  engine.state.paused = true;
  await engine.tick();
  await vi.advanceTimersByTimeAsync(0);
  expect(calls).toEqual([['remote']]);
  offline = false;
  await vi.advanceTimersByTimeAsync(15000);
  await engine.tick();
  await vi.advanceTimersByTimeAsync(0);
  expect(calls).toEqual([['remote'], ['remote']]);
  await engine.tick();
  expect(calls).toHaveLength(2);
  journal.removeRoot(root.id);
  await engine.tick();
  await vi.advanceTimersByTimeAsync(0);
  expect(calls.at(-1)).toEqual([]);
});

it('retries confirmations while a file-change request remains blocked', async () => {
  journal.root(root);
  const receipt = { id: root.remoteId!, type: 'FOLDER', revision: 1, currentVersionId: null };
  let acknowledgements = 0;
  let offline = true;
  hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  engine = new SyncEngine(
    new ApiClient(async (endpoint) => {
      if (endpoint.endsWith('/acknowledge')) {
        acknowledgements++;
        if (offline) throw new TypeError('offline');
        return { ok: true };
      }
      if (endpoint.startsWith('/v1/sync/status')) return { items: [] };
      if (endpoint.includes('/changes')) {
        checks++;
        await hold;
        return { changes: [], nextCursor: 0, hasMore: false };
      }
      return {};
    }),
    journal,
    'device',
    () => {},
  );
  (engine as any).receipts.queue(root, '.', receipt, null);
  const work = engine.tick();
  await vi.waitFor(() => expect(acknowledgements).toBeGreaterThanOrEqual(1));
  await vi.waitFor(() => expect((engine as any).confirmationWork).toBeUndefined());
  offline = false;
  await vi.advanceTimersByTimeAsync(6000);
  void engine.tick();
  await vi.waitFor(() => expect(journal.get('syncReceipts')).toEqual({}));
  expect(engine.state.running).toBe(true);
  expect(checks).toBe(1);
  release!();
  await work;
});

it('waits for an in-flight sync before completing stop for an account change', async () => {
  hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  void engine.tick();
  await vi.waitFor(() => expect(checks).toBe(1));
  let stopped = false;
  const stopping = engine.stop().then(() => {
    stopped = true;
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(stopped).toBe(false);
  release!();
  await stopping;
  expect(stopped).toBe(true);
  await engine.tick();
  expect(checks).toBe(1);
});
