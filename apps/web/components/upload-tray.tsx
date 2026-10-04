import {
  AlertCircle,
  Check,
  ChevronDown,
  File as FileIcon,
  Folder,
  Pause,
  Play,
  RotateCw,
  X,
} from 'lucide-react';
import { useRef, useState } from 'react';
import {
  orderActivity,
  summarizeUploads,
  transferRate,
  uploadTotals,
  type FileUpload,
  type RateSample,
  type UploadActivity,
} from '../lib/upload-activity';
import { Button } from './ui/button';

const bytes = (n: number) =>
  n < 1000
    ? `${n} B`
    : n < 1e6
      ? `${(n / 1e3).toFixed(1)} KB`
      : n < 1e9
        ? `${(n / 1e6).toFixed(1)} MB`
        : `${(n / 1e9).toFixed(1)} GB`;

const count = (n: number) => `${n} ${n === 1 ? 'file' : 'files'}`;

const remaining = (seconds: number) =>
  seconds < 60
    ? `${Math.max(1, Math.round(seconds))} s left`
    : seconds < 3600
      ? `${Math.round(seconds / 60)} min left`
      : `${(seconds / 3600).toFixed(1)} h left`;

function detail(a: UploadActivity) {
  const amount = `${bytes(a.loaded)} of ${bytes(a.size)}`;
  if (a.kind === 'file')
    return {
      queued: `Waiting · ${bytes(a.size)}`,
      hashing: 'Preparing…',
      uploading: amount,
      paused: `Paused · ${amount}`,
      done: bytes(a.size),
      failed: a.error ?? 'Upload failed',
    }[a.phase];
  const failed = a.filesFailed ? ` · ${a.filesFailed} failed` : '';
  const files = `${a.filesDone} of ${count(a.files)}`;
  return {
    queued: `Waiting · ${count(a.files)}`,
    hashing: `${files} · ${amount}${failed}`,
    uploading: `${files} · ${amount}${failed}`,
    paused: `Paused · ${files}${failed}`,
    done: `${count(a.files)} · ${bytes(a.size)}`,
    failed: `${a.filesFailed} of ${count(a.files)} failed${a.error ? ` · ${a.error}` : ''}`,
  }[a.phase];
}

function Bar({ value, max, label }: { value: number; max: number; label: string }) {
  const percent = max ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div
      className="progress-track"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(percent)}
    >
      <span style={{ width: `${percent}%` }} />
    </div>
  );
}

/** Keeps a few seconds of byte totals while uploads run, to estimate speed and time left. */
function useRate(loaded: number, running: boolean) {
  const samples = useRef<RateSample[]>([]);
  if (!running) {
    samples.current = [];
    return null;
  }
  const now = Date.now();
  const last = samples.current.at(-1);
  // A cancelled upload drops bytes from the total; start the window over.
  if (last && loaded < last.loaded) samples.current = [];
  samples.current.push({ at: now, loaded });
  samples.current = samples.current.filter((s) => now - s.at <= 6000);
  return transferRate(samples.current);
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
  onReplace,
  onKeepBoth,
}: {
  uploads: FileUpload[];
  onDismiss: () => void;
  onPause?: (keys: string[]) => void;
  onResume?: (keys: string[]) => void;
  onCancel?: (keys: string[]) => void;
  /** Upload files whose name is taken as new versions of the existing files. */
  onReplace?: (keys: string[]) => void;
  /** Upload files whose name is taken under a numbered name instead. */
  onKeepBoth?: (keys: string[]) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const totals = uploadTotals(uploads);
  const running = totals.pending > 0;
  const rate = useRate(totals.loaded, running);
  if (!uploads.length) return null;
  const activity = orderActivity(summarizeUploads(uploads));
  const finished = activity.filter((a) => a.phase === 'done' || a.phase === 'failed').length;
  const failedKeys = uploads.filter((u) => u.phase === 'failed' && !u.conflict).map((u) => u.key);
  const openKeys = uploads.filter((u) => u.phase !== 'done').map((u) => u.key);

  const title = running
    ? `Uploading ${count(totals.pending + totals.paused)}`
    : totals.paused
      ? `${count(totals.paused)} paused`
      : totals.failed
        ? `${totals.failed} of ${count(totals.files)} failed`
        : `${count(totals.done)} uploaded`;
  const summary = running
    ? [
        `${totals.done} of ${totals.files} done`,
        `${bytes(totals.loaded)} of ${bytes(totals.size)}`,
        rate && `${bytes(rate)}/s`,
        rate && remaining((totals.size - totals.loaded) / rate),
      ]
        .filter(Boolean)
        .join(' · ')
    : `${bytes(totals.size)} total`;

  return (
    <aside
      className="floating-card upload-tray"
      aria-label="Uploads"
      data-collapsed={collapsed}
      data-state={running ? 'running' : totals.failed ? 'failed' : 'done'}
    >
      <header className="upload-head">
        <div className="upload-head-text" aria-live="polite">
          <strong>
            {!running &&
              !totals.paused &&
              (totals.failed ? (
                <AlertCircle size={16} className="upload-failed-icon" aria-hidden="true" />
              ) : (
                <Check size={16} className="upload-done" aria-hidden="true" />
              ))}
            {title}
          </strong>
          <small>{summary}</small>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={collapsed ? 'Show uploads' : 'Hide uploads'}
          aria-expanded={!collapsed}
          title={collapsed ? 'Expand' : 'Collapse'}
          className="upload-collapse"
          onClick={() => setCollapsed((c) => !c)}
        >
          <ChevronDown />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Dismiss finished uploads"
          title="Dismiss finished uploads"
          disabled={!finished}
          onClick={onDismiss}
        >
          <X />
        </Button>
      </header>
      {running && <Bar value={totals.loaded} max={totals.size} label="Overall upload progress" />}
      {!collapsed && (
        <>
          <ul className="upload-list">
            {activity.map((a) => {
              const Icon = a.kind === 'folder' ? Folder : FileIcon;
              const resumable = a.phase === 'paused' || a.phase === 'failed';
              const transferring =
                a.phase === 'uploading' || a.phase === 'hashing' || a.phase === 'paused';
              return (
                <li className="upload-entry" key={a.key} data-phase={a.phase}>
                  <span className="upload-icon" aria-hidden="true">
                    <Icon size={16} />
                  </span>
                  <div className="upload-body">
                    <strong title={a.name}>{a.name}</strong>
                    <small>{detail(a)}</small>
                    {transferring && (
                      <Bar value={a.loaded} max={a.size} label={`${a.name} progress`} />
                    )}
                    {a.conflictKeys.length > 0 && (onReplace || onKeepBoth) && (
                      <span className="upload-conflict">
                        {onReplace && a.replaceable && (
                          <Button
                            variant="link"
                            size="sm"
                            aria-label={`Replace the existing ${a.conflictKeys.length === 1 ? 'file' : 'files'} with ${a.name}`}
                            onClick={() => onReplace(a.conflictKeys)}
                          >
                            Replace
                          </Button>
                        )}
                        {onKeepBoth && (
                          <Button
                            variant="link"
                            size="sm"
                            aria-label={`Keep both, uploading ${a.name} under a new name`}
                            onClick={() => onKeepBoth(a.conflictKeys)}
                          >
                            Keep both
                          </Button>
                        )}
                      </span>
                    )}
                  </div>
                  <span className="upload-actions">
                    {a.phase === 'done' ? (
                      <Check size={16} className="upload-done" aria-label="Uploaded" />
                    ) : resumable ? (
                      onResume &&
                      // Retrying a name conflict fails the same way; it offers Replace instead.
                      !(a.phase === 'failed' && a.conflictKeys.length === a.filesFailed) && (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`${a.phase === 'failed' ? 'Retry' : 'Resume'} ${a.name}`}
                          title={a.phase === 'failed' ? 'Retry' : 'Resume'}
                          onClick={() => onResume(a.keys)}
                        >
                          {a.phase === 'failed' ? <RotateCw /> : <Play />}
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
                </li>
              );
            })}
          </ul>
          {((failedKeys.length > 0 && onResume) || (openKeys.length > 1 && onCancel)) && (
            <footer className="upload-foot">
              {failedKeys.length > 0 && onResume && (
                <Button variant="ghost" size="sm" onClick={() => onResume(failedKeys)}>
                  <RotateCw /> Retry failed
                </Button>
              )}
              {openKeys.length > 1 && onCancel && (
                <Button variant="ghost" size="sm" onClick={() => onCancel(openKeys)}>
                  Cancel all
                </Button>
              )}
            </footer>
          )}
        </>
      )}
    </aside>
  );
}
