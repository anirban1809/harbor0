import { it, expect } from 'vitest';
import { mkdtemp, mkdir, symlink, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { contained, internalPath, safeSegment, safeParents, conflictName } from '../src/paths';
it('blocks path escapes and adapts unsafe Windows names deterministically', () => {
  expect(() => contained('/tmp/root', '../../outside')).toThrow();
  expect(() => contained('/tmp/root', '/outside')).toThrow();
  expect(() => safeSegment('../evil', '12345678')).toThrow();
  expect(safeSegment('CON', '12345678')).toBe('CON~12345678');
  expect(safeSegment('résumé.pdf', '12345678')).toBe('résumé.pdf');
  expect(conflictName('report.pdf', 'MacBook', 'abcdef12-3456')).toBe(
    'report (Conflict - MacBook - abcdef12).pdf',
  );
});
it('refuses to follow symlinks in destination paths', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harbor-paths-'));
  try {
    await mkdir(path.join(root, 'inside'));
    await symlink(os.tmpdir(), path.join(root, 'linked'));
    await expect(safeParents(root, 'linked/escape.txt')).rejects.toThrow('symbolic');
    const target = await safeParents(root, 'inside/new/file.txt');
    expect(target.startsWith(root)).toBe(true);
    await writeFile(target, 'safe');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it('treats OS metadata files as internal at any depth without hiding ordinary dotfiles', () => {
  for (const name of ['.DS_Store', 'a/b/.DS_Store', 'a/._photo.jpg', 'Thumbs.db', 'a/desktop.ini'])
    expect(internalPath(name)).toBe(true);
  expect(internalPath('.Spotlight-V100/Store-V2/index')).toBe(true);
  for (const name of ['.gitignore', '.env', 'a/DS_Store.txt', 'thumbs.db.bak', 'notes.txt'])
    expect(internalPath(name)).toBe(false);
});
