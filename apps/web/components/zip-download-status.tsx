import { LoaderCircle } from 'lucide-react';
import type { FolderDownloadProgress } from '../../../packages/api-client/src/archive-download';
import { Button } from './ui/button';

export type ZipDownloadStatus = FolderDownloadProgress & { name: string };

const bytes = (value: number) =>
  value < 1024
    ? `${value} B`
    : value < 1024 ** 2
      ? `${(value / 1024).toFixed(1)} KB`
      : value < 1024 ** 3
        ? `${(value / 1024 ** 2).toFixed(1)} MB`
        : `${(value / 1024 ** 3).toFixed(2)} GB`;

export function ZipDownloadStatusPanel({
  progress,
  onCancel,
}: {
  progress: ZipDownloadStatus;
  onCancel?: () => void;
}) {
  const percent =
    ['building', 'downloading'].includes(progress.phase) && progress.fileSize !== null
      ? progress.fileSize === 0
        ? 100
        : Math.min(100, Math.floor((progress.fileBytes / progress.fileSize) * 100))
      : null;
  const message = {
    queued: 'Starting ZIP preparation…',
    building: percent === null ? 'Preparing your ZIP…' : `Preparing ZIP · ${percent}%`,
    listing: 'Finding files and folders…',
    downloading: percent === null ? 'Connecting to storage…' : `Downloading ZIP · ${percent}%`,
    finalizing: 'Finishing your ZIP…',
  }[progress.phase];
  return (
    <section
      className="card status-card zip-download-status"
      role="status"
      aria-label="ZIP download status"
    >
      <div className="status-card-heading">
        <LoaderCircle className="spin" size={18} aria-hidden="true" />
        <strong title={`${progress.name}.zip`}>
          {progress.phase === 'downloading' ? 'Downloading' : 'Preparing'} {progress.name}.zip
        </strong>
        {onCancel && (
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
      <div className="status-card-details">
        <span>{message}</span>
        <span>
          {progress.files} {progress.files === 1 ? 'file' : 'files'} completed ·{' '}
          {bytes(progress.bytes)} {progress.phase === 'downloading' ? 'downloaded' : 'prepared'}
        </span>
      </div>
      {progress.currentFile && (
        <p className="status-card-file" title={progress.currentFile}>
          {progress.currentFile}
        </p>
      )}
      <div
        className="progress-track"
        data-indeterminate={percent === null}
        role="progressbar"
        aria-label={percent === null ? 'ZIP creation in progress' : 'ZIP progress'}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
        aria-valuetext={message}
      >
        <span style={percent === null ? undefined : { width: `${percent}%` }} />
      </div>
    </section>
  );
}
