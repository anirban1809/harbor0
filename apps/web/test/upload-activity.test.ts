import { describe, expect, it } from 'vitest';
import {
  finishedKeys,
  mergeUploads,
  summarizeUploads,
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
