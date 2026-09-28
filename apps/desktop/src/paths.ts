import path from 'node:path';
import { lstat, mkdir } from 'node:fs/promises';
export function safeSegment(name: string, id: string) {
  if (!name || name === '.' || name === '..' || /[\\/\0]/.test(name))
    throw new Error('Unsafe remote filename.');
  if (
    /[<>:"|?*\u0000-\u001f]/.test(name) ||
    /[. ]$/.test(name) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
  )
    return `${name.replace(/[^a-zA-Z0-9._ -]/g, '_').replace(/[. ]+$/, '') || 'file'}~${id.slice(0, 8)}`;
  return name;
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
  return `${path.basename(name, ext)} (Conflict - ${device.replace(/[^a-zA-Z0-9 -]/g, '_')} - ${operationId.slice(0, 8)})${ext}`;
}
