import { expect, it } from 'vitest';
import { ApiClient } from '@harbor/api-client';
import { Journal } from '../src/journal';
import { SyncEngine } from '../src/sync';

const root = (id: string, mode: 'sync' | 'backup') => ({
  id,
  localPath: `/tmp/${id}`,
  remoteId: `remote-${id}`,
  mode,
  paused: false,
  excluded: [],
});

it('reports percent complete for a sync batch and a backup run', () => {
  const journal = new Journal(':memory:');
  try {
    journal.root(root('photos', 'sync'));
    journal.root(root('docs', 'backup'));
    journal.root(root('idle', 'sync'));
    for (const name of ['a', 'b', 'c']) journal.enqueue('photos', name, 'upsert');
    const states: { progress?: Record<string, number> }[] = [];
    const engine = new SyncEngine(new ApiClient(async () => ({})), journal, 'device', (state) =>
      states.push(state as never),
    );
    const internals = engine as unknown as {
      emit: () => void;
      finished: (rootId: string) => void;
    };
    // One of four files done, the next one half uploaded.
    internals.finished('photos');
    engine.state.active = {
      rootId: 'photos',
      direction: 'upload',
      relativePath: 'a',
      loaded: 50,
      total: 100,
    };
    journal.set('backup-run:docs', { id: 'run', trigger: 'MANUAL', jobs: ['x'], total: 4 });
    internals.emit();
    expect(states.at(-1)!.progress).toEqual({ photos: 37, docs: 75 });
    // Never 100% while a file is still in flight.
    engine.state.active = { ...engine.state.active, rootId: 'docs', loaded: 100 };
    internals.emit();
    expect(states.at(-1)!.progress!.docs).toBe(99);
  } finally {
    journal.close();
  }
});
