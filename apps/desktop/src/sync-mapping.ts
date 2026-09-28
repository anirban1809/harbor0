import { realpath, lstat, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { ApiClient } from '@harbor/api-client';

export type CloudLocation = {
  id: string | null;
  name: string;
  path: string;
  trail: { id: string; name: string }[];
};
export async function cloudLocation(api: ApiClient, id: string | null): Promise<CloudLocation> {
  const trail: { id: string; name: string }[] = [];
  let current = id;
  const seen = new Set<string>();
  while (current) {
    if (seen.has(current) || seen.size >= 64) throw new Error('Cloud folder path is unavailable.');
    seen.add(current);
    const { item } = await api.request(`/v1/drive/items/${encodeURIComponent(current)}`);
    if (item.type !== 'FOLDER' || item.deletedAt)
      throw new Error('Choose an available folder in My Drive.');
    trail.unshift({ id: item.id, name: item.name });
    current = item.parentId;
  }
  return {
    id,
    name: trail.at(-1)?.name ?? 'My Drive',
    path: ['My Drive', ...trail.map((item) => item.name)].join(' / '),
    trail,
  };
}
export async function localDirectory(selected: string) {
  const info = await lstat(selected);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error('Choose a real local folder, not a shortcut.');
  const resolved = await realpath(selected);
  await access(resolved, constants.R_OK | constants.W_OK);
  return resolved;
}
