import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ApiClient, createTransport } from '@harbor/api-client';
import { Journal } from '../src/journal';
import { SyncEngine } from '../src/sync';

afterEach(() => vi.unstubAllGlobals());

it('treats a gateway error page as the server being unavailable for the whole pass', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'harbor-outage-'));
  const local = path.join(directory, 'synced');
  await mkdir(local);
  const journal = new Journal(':memory:');
  journal.root({
    id: 'root',
    localPath: local,
    remoteId: 'remote',
    mode: 'sync',
    paused: false,
    excluded: [],
  });
  await writeFile(path.join(local, 'a.txt'), 'a');
  journal.enqueue('root', 'a.txt', 'upsert');
  const uploads: string[] = [];
  vi.stubGlobal('fetch', async (url: string) => {
    if (url.endsWith('/v1/uploads')) uploads.push(url);
    return new Response('<html><body><h1>502 Bad Gateway</h1></body></html>', {
      status: 502,
      headers: { 'Content-Type': 'text/html' },
    });
  });
  const engine = new SyncEngine(
    new ApiClient(createTransport('https://api.test', async () => 'token')),
    journal,
    'device',
    () => {},
  );
  try {
    await engine.tick();
    expect(engine.state.online).toBe(false);
    expect(engine.state.message).toBe(
      'harbor0 is unavailable right now. Sync resumes automatically.',
    );
    expect(JSON.stringify(engine.state)).not.toMatch(/Unexpected token|JSON/);
    // Not this file's problem: no per-file failure or retry delay.
    expect(engine.state.issues).toEqual([]);
    expect(journal.jobs()[0].payload.retryAt).toBeUndefined();
    expect(uploads).toHaveLength(1);

    // The 2s timer does not start another pass straight into the outage; an explicit check does.
    await (engine as unknown as { run(): Promise<void> }).run();
    expect(uploads).toHaveLength(1);
    await engine.tick();
    expect(uploads).toHaveLength(2);
  } finally {
    await engine.stop();
    journal.close();
    await rm(directory, { recursive: true, force: true });
  }
});
