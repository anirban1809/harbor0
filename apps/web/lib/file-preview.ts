import type { FileEntry } from './file-metadata';
import type { TextPreview } from '../../../packages/api-client/src/preview';

export type PreviewKind = 'text' | 'image' | 'video' | 'audio';
export type PreviewContent = TextPreview | { url: string };
export type PreviewLoader = (item: FileEntry, signal: AbortSignal) => Promise<PreviewContent>;

const extensions: Record<PreviewKind, Set<string>> = {
  text: new Set(
    'txt md markdown csv tsv json jsonl ndjson yaml yml xml html htm css scss sass less js jsx mjs cjs ts tsx py rb go rs java c h cpp hpp cs sh bash zsh sql log ini conf cfg toml env gitignore dockerfile makefile'.split(
      ' ',
    ),
  ),
  image: new Set('png jpg jpeg gif webp avif bmp ico svg'.split(' ')),
  video: new Set('mp4 m4v webm ogv mov'.split(' ')),
  audio: new Set('mp3 wav wave ogg oga opus m4a aac flac weba aif aiff'.split(' ')),
};
export function previewKind(item: FileEntry): PreviewKind | null {
  if (item.type !== 'FILE') return null;
  const mime = item.mimeType?.split(';')[0].trim().toLowerCase() ?? '';
  for (const kind of ['image', 'video', 'audio'] as const) {
    if (mime.startsWith(`${kind}/`)) return kind;
  }
  if (
    mime.startsWith('text/') ||
    /^application\/(json|.+\+json|xml|.+\+xml|javascript|x-javascript|yaml|x-yaml|toml)$/.test(mime)
  )
    return 'text';
  // Desktop uploads may have a generic MIME type; use their filename as a fallback.
  if (mime && !['application/octet-stream', 'binary/octet-stream'].includes(mime)) return null;
  const name = item.name.toLowerCase();
  const extension = name.split('.').at(-1)!;
  for (const kind of ['text', 'image', 'video', 'audio'] as const) {
    if (extensions[kind].has(extension)) return kind;
  }
  return null;
}
