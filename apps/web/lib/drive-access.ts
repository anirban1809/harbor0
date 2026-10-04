import type { DriveItem } from '@harbor/contracts';

export type ShareAccess = DriveItem['access'];

/**
 * What the caller may do with an item. `access` is set only on someone else's item reached
 * through a share; `folderAccess` is the open folder's. Outside a shared folder, someone else's
 * item is the shared item itself, which only its owner may rename, move or trash.
 */
export function itemAccess(item: { access?: ShareAccess }, folderAccess?: ShareAccess) {
  const owner = !item.access;
  const edit = owner || item.access === 'EDITOR';
  return {
    owner,
    /** Upload new versions and restore old ones. */
    edit,
    /** Rename, move and trash. */
    manage: edit && (owner || !!folderAccess),
    /** Share, send and favourite act on the owner's copy, so only the owner may. */
    share: owner,
  };
}

/** Uploads and new folders are refused in a folder shared with the caller as a viewer. */
export const canWriteIn = (folderAccess?: ShareAccess) => folderAccess !== 'VIEWER';
