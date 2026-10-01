import { Check, File as FileIcon, Folder, Pause, Play, X } from 'lucide-react';
import { summarizeUploads, type FileUpload, type UploadActivity } from '../lib/upload-activity';
import { Button } from './ui/button';
import { Progress } from './ui/progress';

const bytes = (n: number) =>
  n < 1000
    ? `${n} B`
    : n < 1e6
      ? `${(n / 1e3).toFixed(1)} KB`
      : n < 1e9
        ? `${(n / 1e6).toFixed(1)} MB`
        : `${(n / 1e9).toFixed(1)} GB`;

const count = (n: number) => `${n} ${n === 1 ? 'file' : 'files'}`;

function detail(a: UploadActivity) {
  const amount = `${bytes(a.loaded)} of ${bytes(a.size)}`;
  if (a.kind === 'file')
    return {
      queued: 'Waiting…',
      hashing: 'Preparing file…',
      uploading: amount,
      paused: `Paused · ${amount}`,
      done: 'Uploaded',
      failed: a.error ?? 'Upload failed',
    }[a.phase];
  const failed = a.filesFailed ? ` · ${a.filesFailed} failed` : '';
  const files = `${a.filesDone} of ${count(a.files)}`;
  return {
    queued: `Waiting · ${count(a.files)}`,
    hashing: `${files} · ${amount}${failed}`,
    uploading: `${files} · ${amount}${failed}`,
    paused: `Paused · ${files}${failed}`,
    done: `${count(a.files)} uploaded`,
    failed: `${a.filesFailed} of ${count(a.files)} failed${a.error ? ` · ${a.error}` : ''}`,
  }[a.phase];
}

/**
 * Floating card listing upload activity. Files from the same folder are shown as one row.
 * Pause, resume and cancel are offered only when the host passes a handler for them.
 */
export function UploadTray({
  uploads,
  onDismiss,
  onPause,
  onResume,
  onCancel,
}: {
  uploads: FileUpload[];
  onDismiss: () => void;
  onPause?: (keys: string[]) => void;
  onResume?: (keys: string[]) => void;
  onCancel?: (keys: string[]) => void;
}) {
  if (!uploads.length) return null;
  const activity = summarizeUploads(uploads);
  const running = activity.filter((a) => !['done', 'failed'].includes(a.phase)).length;
  return (
    <aside className="floating-card upload-tray" aria-label="Uploads" aria-live="polite">
      <div className="upload-title">
        <strong>
          {running
            ? `Uploading ${running} ${running === 1 ? 'item' : 'items'}`
            : activity.some((a) => a.phase === 'failed')
              ? 'Some uploads failed'
              : 'Uploads complete'}
        </strong>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Dismiss finished uploads"
          title="Dismiss finished uploads"
          disabled={running === activity.length}
          onClick={onDismiss}
        >
          <X />
        </Button>
      </div>
      <div className="upload-list">
        {activity.map((a) => {
          const Icon = a.kind === 'folder' ? Folder : FileIcon;
          const resumable = a.phase === 'paused' || a.phase === 'failed';
          return (
            <div className="upload-entry" key={a.key} data-phase={a.phase}>
              <div>
                <span className="upload-name">
                  <Icon size={16} aria-hidden="true" />
                  <strong title={a.name}>{a.name}</strong>
                </span>
                <span>
                  {a.phase === 'done' ? (
                    <Check size={16} className="upload-done" aria-label="Uploaded" />
                  ) : resumable ? (
                    onResume && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`${a.phase === 'failed' ? 'Retry' : 'Resume'} ${a.name}`}
                        title={a.phase === 'failed' ? 'Retry' : 'Resume'}
                        onClick={() => onResume(a.keys)}
                      >
                        <Play />
                      </Button>
                    )
                  ) : (
                    onPause && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Pause ${a.name}`}
                        title="Pause"
                        onClick={() => onPause(a.keys)}
                      >
                        <Pause />
                      </Button>
                    )
                  )}
                  {a.phase !== 'done' && onCancel && (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Cancel ${a.name}`}
                      title="Cancel"
                      onClick={() => onCancel(a.keys)}
                    >
                      <X />
                    </Button>
                  )}
                </span>
              </div>
              <Progress value={a.loaded} max={a.size || 1} />
              <small>{detail(a)}</small>
            </div>
          );
        })}
      </div>
    </aside>
  );
}
