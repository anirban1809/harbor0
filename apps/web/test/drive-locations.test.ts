import { expect, it } from 'vitest';
import { ApiError } from '@harbor/api-client';
import type { DriveItem } from '@harbor/contracts';
import { driveLocations } from '../lib/drive-locations';

type Node = Pick<DriveItem, 'id' | 'parentId' | 'backupRootId'>;
const tree = (nodes: Node[], forbidden: string[] = []) => {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return async (id: string) => {
    if (forbidden.includes(id))
      throw new ApiError('FORBIDDEN', 'You do not have access to this item.', 403);
    const node = byId.get(id);
    if (!node) throw new ApiError('ITEM_NOT_FOUND', 'Item was not found.', 404);
    return node;
  };
};

it('classifies items by walking up to a backup or synced ancestor', async () => {
  const load = tree([
    { id: 'backup', parentId: null },
    { id: 'docs', parentId: 'backup' },
    { id: 'synced', parentId: null },
  ]);
  const classify = driveLocations(new Map([['backup', 'root-1']]), new Set(['synced']), load);
  expect(await classify({ id: 'file', parentId: 'docs' })).toEqual({
    location: 'Backup',
    backupRootId: 'root-1',
  });
  expect(await classify({ id: 'file', parentId: 'synced' })).toEqual({ location: 'Sync' });
  expect(await classify({ id: 'file', parentId: null })).toEqual({ location: 'Cloud' });
});

it('stops at a shared folder whose parents belong to someone else', async () => {
  const load = tree([{ id: 'shared', parentId: 'owners-private' }], ['owners-private']);
  const classify = driveLocations(new Map(), new Set(), load);
  expect(await classify({ id: 'file', parentId: 'shared' })).toEqual({ location: 'Cloud' });
  expect(await classify({ id: 'shared', parentId: 'owners-private' })).toEqual({
    location: 'Cloud',
  });
});

it('still reports other failures', async () => {
  const classify = driveLocations(new Map(), new Set(), async () => {
    throw new ApiError('BACKEND_UNAVAILABLE', 'Unavailable', 503);
  });
  await expect(classify({ id: 'file', parentId: 'folder' })).rejects.toMatchObject({
    status: 503,
  });
});
