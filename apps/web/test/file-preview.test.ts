import { expect, it } from 'vitest';
import { previewKind } from '../lib/file-preview';
import type { FileEntry } from '../lib/file-metadata';

const file: FileEntry = { id: 'file', type: 'FILE', name: 'example', sizeBytes: 10 };
it.each([
  ['notes.TXT', 'application/octet-stream', 'text'],
  ['.env', '', 'text'],
  ['Dockerfile', '', 'text'],
  ['photo.PNG', 'application/octet-stream', 'image'],
  ['clip.webm', undefined, 'video'],
  ['song.mp3', 'application/octet-stream', 'audio'],
  ['data', 'application/ld+json; charset=utf-8', 'text'],
  ['page', 'TEXT/HTML', 'text'],
  ['image', 'image/svg+xml', 'image'],
  ['recording', 'audio/ogg', 'audio'],
  ['movie', 'video/mp4', 'video'],
  ['archive.zip', 'application/zip', null],
  ['document.pdf', 'application/pdf', null],
  ['misleading.txt', 'application/pdf', null],
  ['unknown', 'application/octet-stream', null],
])('classifies %s (%s) as %s', (name, mimeType, kind) => {
  expect(previewKind({ ...file, name, mimeType })).toBe(kind);
});
it('never previews folders', () => {
  expect(
    previewKind({ ...file, type: 'FOLDER', name: 'folder.txt', mimeType: 'text/plain' }),
  ).toBeNull();
});
