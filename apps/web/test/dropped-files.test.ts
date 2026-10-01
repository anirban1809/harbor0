import { describe, expect, it } from 'vitest';
import { readDroppedFiles } from '../lib/dropped-files';

const file = (name: string) =>
  ({
    name,
    isFile: true,
    isDirectory: false,
    file: (ok: (f: File) => void) => ok(new File(['x'], name)),
  }) as unknown as FileSystemEntry;

// Hands out children in batches of two, like Chrome's 100-entry readEntries pages.
const dir = (name: string, children: FileSystemEntry[]) =>
  ({
    name,
    isFile: false,
    isDirectory: true,
    createReader: () => {
      let offset = 0;
      return {
        readEntries: (ok: (batch: FileSystemEntry[]) => void) => {
          ok(children.slice(offset, offset + 2));
          offset += 2;
        },
      };
    },
  }) as unknown as FileSystemEntry;

const drop = (entries: (FileSystemEntry | null)[], files: File[] = []) =>
  ({
    items: entries.map((entry) => ({ kind: 'file', webkitGetAsEntry: () => entry })),
    files,
  }) as unknown as DataTransfer;

describe('readDroppedFiles', () => {
  it('walks dropped folders and keeps each file’s folder path', async () => {
    const result = await readDroppedFiles(
      drop([
        file('loose.txt'),
        dir('Photos', [file('a.jpg'), file('b.jpg'), file('c.jpg'), dir('2026', [file('d.jpg')])]),
      ]),
    );
    expect(result.map(({ file, folders }) => [...folders, file.name].join('/'))).toEqual([
      'loose.txt',
      'Photos/a.jpg',
      'Photos/b.jpg',
      'Photos/c.jpg',
      'Photos/2026/d.jpg',
    ]);
  });

  it('falls back to top-level files without the entries API', async () => {
    const plain = new File(['x'], 'plain.txt');
    const result = await readDroppedFiles(drop([null], [plain]));
    expect(result).toEqual([{ file: plain, folders: [] }]);
  });
});
