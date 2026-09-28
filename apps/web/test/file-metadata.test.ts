import { it, expect } from 'vitest';
import { fileDate, fileKind, fileSize, fileSummary, type FileEntry } from '../lib/file-metadata';
const file: FileEntry = { id: 'one', name: 'notes.md', type: 'FILE', sizeBytes: 45 };
it('preserves small and empty file sizes and distinguishes unavailable sizes', () => {
  expect(fileSize(0)).toBe('0 B');
  expect(fileSize(45)).toBe('45 B');
  expect(fileSize(2400000)).toBe('2.4 MB');
  expect(fileSize(undefined)).toBe('—');
  expect(fileSize(NaN)).toBe('—');
});
it('describes common types and folders without inferring folder contents', () => {
  expect(fileKind(file)).toBe('Markdown document');
  expect(fileKind({ ...file, name: 'archive.constructor' })).toBe('CONSTRUCTOR file');
  expect(fileKind({ ...file, name: 'scan.PDF' })).toBe('PDF document');
  expect(fileKind({ ...file, name: 'photo.jpg', mimeType: 'image/jpeg' })).toBe('JPG image');
  expect(fileKind({ ...file, type: 'FOLDER' })).toBe('Folder');
});
it('uses unavailable dates honestly and totals only visible files', () => {
  expect(fileDate('invalid').date).toBe('—');
  expect(fileDate(null).time).toBe('');
  expect(fileSummary([file, { ...file, id: 'folder', type: 'FOLDER', sizeBytes: 9999 }])).toBe(
    '1 file · 1 folder · 45 B in shown files',
  );
});
