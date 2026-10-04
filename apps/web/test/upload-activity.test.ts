import { describe, expect, it } from 'vitest';
import {
  finishedKeys,
  mergeUploads,
  orderActivity,
  summarizeUploads,
  transferRate,
  uploadTotals,
  type FileUpload,
} from '../lib/upload-activity';

const trip = { key: 'b/Trip', name: 'Trip' };
const file = (key: string, change: Partial<FileUpload> = {}): FileUpload => ({
  key,
  name: key + '.txt',
  size: 100,
  loaded: 0,
  phase: 'queued',
  ...change,
});

describe('summarizeUploads', () => {
  it('rolls a folder’s files into one row and keeps loose files separate', () => {
    const rows = summarizeUploads([
      file('loose', { phase: 'uploading', loaded: 40 }),
      file('a', { group: trip, phase: 'done', loaded: 100 }),
      file('b', { group: trip, phase: 'uploading', loaded: 50 }),
      file('c', { group: trip }),
    ]);
    expect(rows).toMatchObject([
      { key: 'loose', kind: 'file', phase: 'uploading', loaded: 40, size: 100 },
      {
        key: 'b/Trip',
        kind: 'folder',
        name: 'Trip',
        phase: 'uploading',
        files: 3,
        filesDone: 1,
        loaded: 150,
        size: 300,
        keys: ['a', 'b', 'c'],
      },
    ]);
  });

  it('reports a folder as paused, failed or done once nothing is running', () => {
    const phase = (...phases: FileUpload['phase'][]) =>
      summarizeUploads(phases.map((p, i) => file(String(i), { group: trip, phase: p })))[0].phase;
    expect(phase('done', 'paused', 'queued')).toBe('paused');
    expect(phase('done', 'failed', 'queued')).toBe('queued');
    expect(phase('done', 'failed')).toBe('failed');
    expect(phase('done', 'done')).toBe('done');
  });
});

describe('mergeUploads and finishedKeys', () => {
  it('updates by key, appends new uploads and finds finished rows', () => {
    const list = mergeUploads(
      [file('a', { group: trip }), file('b', { group: trip }), file('c')],
      [file('a', { group: trip, phase: 'done' }), file('c', { phase: 'failed' }), file('d')],
    );
    expect(list.map((u) => `${u.key}:${u.phase}`)).toEqual([
      'a:done',
      'b:queued',
      'c:failed',
      'd:queued',
    ]);
    // Trip is still waiting on b, so only the failed loose file is finished.
    expect([...finishedKeys(list)]).toEqual(['c']);
  });
});

describe('uploadTotals', () => {
  it('counts files by state and sums bytes, treating finished files as fully loaded', () => {
    expect(
      uploadTotals([
        file('a', { phase: 'done', loaded: 0 }),
        file('b', { phase: 'uploading', loaded: 30 }),
        file('c', { phase: 'failed', loaded: 10 }),
        file('d', { phase: 'paused', loaded: 20 }),
        file('e'),
      ]),
    ).toEqual({ files: 5, done: 1, failed: 1, paused: 1, pending: 2, size: 500, loaded: 160 });
  });
});

describe('orderActivity', () => {
  it('puts transferring rows first and finished rows last, keeping order within a state', () => {
    const rows = summarizeUploads([
      file('done', { phase: 'done' }),
      file('wait'),
      file('up', { phase: 'uploading' }),
      file('bad', { phase: 'failed' }),
      file('hash', { phase: 'hashing' }),
    ]);
    expect(orderActivity(rows).map((r) => r.key)).toEqual(['up', 'hash', 'bad', 'wait', 'done']);
  });
});

describe('transferRate', () => {
  it('needs a second of history', () => {
    expect(transferRate([{ at: 0, loaded: 0 }])).toBeNull();
    expect(
      transferRate([
        { at: 0, loaded: 0 },
        { at: 500, loaded: 100 },
      ]),
    ).toBeNull();
  });
  it('averages bytes per second across the window', () => {
    expect(
      transferRate([
        { at: 0, loaded: 0 },
        { at: 1000, loaded: 500 },
        { at: 2000, loaded: 2000 },
      ]),
    ).toBe(1000);
  });
});
describe('upload name conflicts', () => {
  it('offers replace only when every taken name is a file', () => {
    const [row] = summarizeUploads([
      file('a', { group: trip, phase: 'failed', conflict: 'file' }),
      file('b', { group: trip, phase: 'done' }),
      file('c', { group: trip, phase: 'failed', error: 'Network' }),
    ]);
    expect(row.conflictKeys).toEqual(['a']);
    expect(row.replaceable).toBe(true);
    const [folder] = summarizeUploads([file('d', { phase: 'failed', conflict: 'folder' })]);
    expect(folder.conflictKeys).toEqual(['d']);
    expect(folder.replaceable).toBe(false);
  });
});
