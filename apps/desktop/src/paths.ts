import path from 'node:path';
import { lstat, mkdir } from 'node:fs/promises';
const ILLEGAL = /[<>:"|?*\u0000-\u001f]/;
function unsafeLocally(name: string) {
  if (!name || name === '.' || name === '..' || /[\\/\0]/.test(name))
    throw new Error('Unsafe remote filename.');
  return (
    ILLEGAL.test(name) ||
    /[. ]$/.test(name) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
  );
}
/**
 * The local name for a cloud name. One that is not valid on every OS gets its illegal characters
 * replaced and a `~id` suffix before the extension, so it stays unique and keeps its file type.
 */
export function safeSegment(name: string, id: string) {
  if (!unsafeLocally(name)) return name;
  const clean = name.replace(new RegExp(ILLEGAL, 'g'), '_').replace(/[. ]+$/, '');
  const ext = path.extname(clean);
  return `${clean.slice(0, clean.length - ext.length) || 'file'}~${id.slice(0, 8)}${ext}`;
}
/** The local name earlier versions chose; files already synced under it keep that name. */
export function legacySafeSegment(name: string, id: string) {
  if (!unsafeLocally(name)) return name;
  return `${name.replace(/[^a-zA-Z0-9._ -]/g, '_').replace(/[. ]+$/, '') || 'file'}~${id.slice(0, 8)}`;
}
// OS and file-manager bookkeeping that should never be synced or backed up.
const METADATA_NAMES = new Set([
  '.ds_store',
  '.appledouble',
  '.lsoverride',
  '.spotlight-v100',
  '.trashes',
  '.fseventsd',
  '.temporaryitems',
  '.documentrevisions-v100',
  '.apdisk',
  'icon\r',
  'thumbs.db',
  'ehthumbs.db',
  'desktop.ini',
  '$recycle.bin',
  '.directory',
]);
export function metadataSegment(name: string) {
  return name.startsWith('._') || METADATA_NAMES.has(name.toLowerCase());
}
// Local copies kept after a remote folder deletion: visible to the user, but never synced again.
const RECOVERED = / \(Recovered by harbor0 \d{4}-\d{2}-\d{2} \d{2}\.\d{2}\.\d{2}\)$/;
export function recoveredName(name: string, at: Date) {
  const two = (value: number) => String(value).padStart(2, '0');
  return `${name} (Recovered by harbor0 ${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}.${two(at.getMinutes())}.${two(at.getSeconds())})`;
}
export function internalPath(relative: string) {
  return relative
    .split('/')
    .some(
      (p) =>
        p.startsWith('.harbor-') ||
        p.endsWith('.harbor-part') ||
        RECOVERED.test(p) ||
        metadataSegment(p),
    );
}
export function contained(root: string, relative: string) {
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..'))
    throw new Error('Unsafe relative path.');
  const result = path.resolve(root, relative);
  if (result !== path.resolve(root) && !result.startsWith(path.resolve(root) + path.sep))
    throw new Error('Path leaves the selected folder.');
  return result;
}
export async function safeParents(root: string, relative: string, create = true) {
  const base = await lstat(root);
  if (base.isSymbolicLink() || !base.isDirectory())
    throw new Error('The selected folder must be a real directory.');
  const pieces = relative.split('/').slice(0, -1);
  let current = root;
  for (const p of pieces) {
    current = contained(current, p);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory())
        throw new Error('A symbolic link or file blocks this destination.');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT' || !create) throw e;
      await mkdir(current);
    }
  }
  const target = contained(root, relative);
  try {
    if ((await lstat(target)).isSymbolicLink())
      throw new Error('Refusing to overwrite a symbolic link.');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  return target;
}
export function conflictName(name: string, device: string, operationId: string) {
  const ext = path.extname(name);
  const label =
    device
      .replace(/\.local$/i, '')
      .replace(/[^\p{L}\p{N} '-]/gu, '_')
      .trim()
      .slice(0, 40) || 'another device';
  return `${path.basename(name, ext)} (Conflict - ${label} - ${operationId.slice(0, 8)})${ext}`;
}
