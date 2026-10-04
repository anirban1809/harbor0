import { storageSize } from './overview';
import type { SyncFolder, SyncIssue } from './sync-state';

/** Whose storage refused the upload, and by how much when the server said. */
export function storageText(issue: SyncIssue, root?: SyncFolder) {
  if (issue.storage?.owner || root?.shareId)
    return 'The owner of this shared folder is out of cloud storage, so new changes cannot be uploaded. Syncing resumes once they free up space.';
  const { requiredBytes, availableBytes } = issue.storage ?? {};
  if (requiredBytes === undefined || availableBytes === undefined)
    return 'There is not enough cloud storage left to upload this change. Syncing resumes once space is freed.';
  const needs = storageSize(requiredBytes);
  return availableBytes > 0
    ? `This file is too big for your remaining cloud storage (needs ${needs}, ${storageSize(availableBytes)} free). Smaller files keep syncing.`
    : `Your cloud storage is full (this file needs ${needs}). Syncing resumes once space is freed.`;
}
