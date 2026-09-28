import type { FolderDownload } from '@harbor/contracts';
import type { ApiClient } from './index';

export type FolderDownloadProgress = {
  phase: 'queued' | 'listing' | 'building' | 'downloading' | 'finalizing';
  files: number;
  bytes: number;
  currentFile: string | null;
  fileBytes: number;
  fileSize: number | null;
};

function delay(signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, 1500);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

/** Poll metadata only. File contents and ZIP construction stay in the backend. */
export async function prepareFolderDownload(
  api: ApiClient,
  folderId: string,
  onProgress?: (progress: FolderDownloadProgress) => void,
  signal?: AbortSignal,
): Promise<FolderDownload & { downloadUrl: string; sizeBytes: number }> {
  signal?.throwIfAborted();
  let job: FolderDownload | undefined;
  try {
    // Do not abort the creation request: retain its ID so cancellation can clean up the job.
    job = await api.request('/v1/folder-downloads', {
      method: 'POST',
      body: { driveItemId: folderId, operationId: crypto.randomUUID() },
    });
    for (;;) {
      signal?.throwIfAborted();
      if (job!.state === 'READY') {
        if (!job!.downloadUrl || job!.sizeBytes === undefined)
          throw new Error('The ZIP download is unavailable. Please try again.');
        return job as FolderDownload & { downloadUrl: string; sizeBytes: number };
      }
      if (['FAILED', 'CANCELLED', 'EXPIRED'].includes(job!.state))
        throw new Error(job!.error ?? 'ZIP preparation ended. Please try again.');
      const phase = {
        QUEUED: 'queued',
        LISTING: 'listing',
        BUILDING: 'building',
        FINALIZING: 'finalizing',
      } as const;
      onProgress?.({
        phase: phase[job!.state as keyof typeof phase],
        files: job!.files,
        bytes: job!.bytes,
        currentFile: job!.currentFile,
        fileBytes: job!.bytes,
        fileSize: job!.totalBytes,
      });
      await delay(signal);
      job = await api.request(`/v1/folder-downloads/${job!.id}`, { signal });
    }
  } catch (error) {
    if (job && !['FAILED', 'CANCELLED', 'EXPIRED'].includes(job.state))
      await api.request(`/v1/folder-downloads/${job.id}`, { method: 'DELETE' }).catch(() => {});
    throw error;
  }
}
