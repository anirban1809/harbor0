import type { ApiClient } from '@harbor/api-client';
import type { DriveItem } from '@harbor/contracts';
import {
  prepareFolderDownload,
  type FolderDownloadProgress,
} from '../../../packages/api-client/src/archive-download';

export async function downloadFolderZip(
  api: ApiClient,
  folder: Pick<DriveItem, 'id' | 'name'>,
  signal: AbortSignal,
  onProgress: (progress: FolderDownloadProgress) => void,
) {
  const archive = await prepareFolderDownload(api, folder.id, onProgress, signal);
  signal.throwIfAborted();
  const link = document.createElement('a');
  link.href = archive.downloadUrl;
  link.download = archive.name;
  link.rel = 'noreferrer';
  document.body.appendChild(link);
  link.click();
  link.remove();
  return true;
}
