import {
  Cloud,
  Folder,
  FolderSync,
  HardDrive,
  Plus,
  RefreshCw,
  ShieldCheck,
  Wifi,
  WifiOff,
} from 'lucide-react';
import type { StorageUsage } from '@harbor/contracts';
import type { Root, LocalJob } from './journal';
import { Button } from '../../web/components/ui/button';
import { EmptyState } from '../../web/components/empty-state';

export type FolderStatus = Root & {
  localPathDisplayName: string;
  fileCount: number;
  folderCount: number;
};
export type JobStatus = Pick<
  LocalJob,
  'id' | 'rootId' | 'relativePath' | 'kind' | 'error' | 'attempts'
>;
export type SyncStatus = {
  paused?: boolean;
  online?: boolean;
  running?: boolean;
  message?: string;
  lastSync?: string | null;
};
const count = (value: number) => value.toLocaleString();
export function storageSize(bytes: number) {
  if (bytes < 1000) return `${count(bytes)} B`;
  const unit = Math.min(4, Math.floor(Math.log10(bytes) / 3));
  return `${(bytes / 1000 ** unit).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${['B', 'KB', 'MB', 'GB', 'TB'][unit]}`;
}
export function StoragePanel({
  storage,
  error,
  retry,
}: {
  storage: StorageUsage | null;
  error: boolean;
  retry: () => void;
}) {
  const percent =
    storage && storage.quotaBytes > 0 ? (storage.usedBytes / storage.quotaBytes) * 100 : 0;
  const percentLabel =
    percent > 0 && percent < 0.01
      ? '<0.01'
      : percent.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return (
    <section className="panel storage-overview" aria-label="Storage usage">
      <div className="section-heading">
        <div className="section-title">
          <span className="overview-icon">
            <HardDrive size={19} />
          </span>
          <div>
            <h2>Your storage</h2>
            <p className="muted">Shared across all your devices</p>
          </div>
        </div>
        {storage && <span className="usage-percent">{percentLabel}% used</span>}
      </div>
      {!storage ? (
        <div className="storage-placeholder" role="status">
          {error ? (
            <>
              Storage usage is unavailable.{' '}
              <Button variant="outline" onClick={retry}>
                Retry storage
              </Button>
            </>
          ) : (
            'Loading storage usage…'
          )}
        </div>
      ) : (
        <>
          <div className="storage-amount">
            <strong>{storageSize(storage.usedBytes)}</strong>
            <span>of {storageSize(storage.quotaBytes)} used</span>
          </div>
          <progress
            max={100}
            value={Math.min(100, percent)}
            aria-label="Storage used"
            aria-valuetext={`${percentLabel}% used`}
          />
          <div className="storage-details">
            <span>
              {count(storage.usedBytes)} of {count(storage.quotaBytes)} bytes
            </span>
            <strong>{storageSize(storage.availableBytes)} available</strong>
          </div>
          {storage.reservedBytes > 0 && (
            <p className="storage-reserved">
              {storageSize(storage.reservedBytes)} reserved for uploads in progress
            </p>
          )}
          {error && (
            <p className="storage-reserved" role="status">
              Showing the last available usage. <button onClick={retry}>Refresh usage</button>
            </p>
          )}
        </>
      )}
    </section>
  );
}

export function FolderOverview({
  mode,
  roots,
  jobs,
  sync,
  busy,
  choose,
  open,
  options,
}: {
  mode: 'sync' | 'backup';
  roots: FolderStatus[];
  jobs: JobStatus[];
  sync: SyncStatus;
  busy: boolean;
  choose: () => void;
  open: (root: FolderStatus) => void;
  options: (root: FolderStatus) => void;
}) {
  const backup = mode === 'backup';
  const folders = roots.filter((root) => root.mode === mode);
  const rootIds = new Set(folders.map((root) => root.id));
  const pending = jobs.filter((job) => rootIds.has(job.rootId));
  const failed = pending.filter((job) => job.error);
  const Icon = backup ? Cloud : FolderSync;
  const paused = folders.filter((root) => root.paused).length;
  const state = sync.paused
    ? 'Paused'
    : sync.online === false
      ? 'Offline'
      : failed.length
        ? 'Needs attention'
        : sync.running
          ? 'Working'
          : folders.length
            ? 'Connected'
            : 'Not set up';
  return (
    <div className="folder-overview">
      <div className="folder-metrics">
        <div className="panel">
          <span className="metric-label">
            {backup ? 'Backup folders' : 'Sync folders'}
            <Icon size={17} />
          </span>
          <strong>{count(folders.length)}</strong>
          <p>
            {paused
              ? `${paused} folder${paused === 1 ? '' : 's'} paused`
              : 'Connected on this computer'}
          </p>
        </div>
        <div className="panel">
          <span className="metric-label">
            Tracked files
            <HardDrive size={17} />
          </span>
          <strong>{count(folders.reduce((sum, root) => sum + (root.fileCount ?? 0), 0))}</strong>
          <p>{backup ? 'Files recorded in your backup' : 'Files linked to your cloud drive'}</p>
        </div>
        <div className="panel">
          <span className="metric-label">
            Pending changes
            <RefreshCw size={17} />
          </span>
          <strong>{count(pending.length)}</strong>
          <p>
            {failed.length
              ? `${failed.length} ${failed.length == 1 ? 'needs' : 'need'} attention`
              : 'Waiting for the next update'}
          </p>
        </div>
      </div>
      <section className="panel folder-panel">
        <div className="section-heading">
          <div>
            <h2>{backup ? 'Your backup folders' : 'Your sync folders'}</h2>
            <p className="muted">
              {backup
                ? 'One-way copies from this computer to your cloud drive.'
                : 'Two-way updates between this computer and your cloud drive.'}
            </p>
          </div>
          {!!folders.length && (
            <Button disabled={busy} onClick={choose}>
              <Plus size={16} />
              Choose folder
            </Button>
          )}
        </div>
        {!folders.length ? (
          <EmptyState
            compact
            icon={<Icon />}
            title={backup ? 'No backup folders' : 'No synced folders'}
            description={
              backup
                ? 'Choose a local folder to back up to the cloud.'
                : 'Choose a dedicated folder to keep local and cloud files up to date.'
            }
            actions={
              <Button disabled={busy} onClick={choose}>
                <Plus size={16} />
                Choose folder
              </Button>
            }
          />
        ) : (
          <div className="connected-folders">
            {folders.map((root) => {
              const queue = pending.filter((job) => job.rootId === root.id);
              const errors = queue.filter((job) => job.error).length;
              const label =
                root.paused || sync.paused
                  ? 'Paused'
                  : sync.online === false
                    ? 'Offline'
                    : errors
                      ? 'Needs attention'
                      : queue.length
                        ? 'Changes pending'
                        : 'Connected';
              return (
                <article className="connected-folder" key={root.id}>
                  <div className="folder-line">
                    <span className="overview-icon">
                      <Folder size={21} />
                    </span>
                    <div className="folder-name">
                      <h3>{root.localPathDisplayName}</h3>
                      <p title={root.localPath}>{root.localPath || 'Local folder'}</p>
                    </div>
                    <span className={`badge ${errors ? 'attention-badge' : ''}`}>{label}</span>
                  </div>
                  <div className="folder-detail-line">
                    <dl className="folder-facts">
                      <div>
                        <dt>Tracked files</dt>
                        <dd>{count(root.fileCount ?? 0)}</dd>
                      </div>
                      <div>
                        <dt>Subfolders</dt>
                        <dd>{count(root.folderCount ?? 0)}</dd>
                      </div>
                      <div>
                        <dt>Pending</dt>
                        <dd>{count(queue.length)}</dd>
                      </div>
                      <div>
                        <dt>Exclusions</dt>
                        <dd>{root.excluded.length}</dd>
                      </div>
                    </dl>
                    <div className="folder-actions">
                      <Button
                        variant="ghost"
                        onClick={() => open(root)}
                        aria-label={`Open ${root.localPathDisplayName}`}
                      >
                        Open folder
                      </Button>
                      <Button
                        variant="outline"
                        onClick={() => options(root)}
                        aria-label={`Options for ${root.localPathDisplayName}`}
                      >
                        Options
                      </Button>
                    </div>
                  </div>
                  {!!root.excluded.length && (
                    <p className="folder-exclusions">Excluded: {root.excluded.join(', ')}</p>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </section>
      <div className="sync-detail-grid">
        <section className="panel connection-panel">
          <div className="section-title">
            <span className="overview-icon">
              {sync.online === false ? <WifiOff size={19} /> : <Wifi size={19} />}
            </span>
            <div>
              <h2>{state}</h2>
              <p className="muted">Background activity on this computer</p>
            </div>
          </div>
          <dl className="connection-facts">
            <div>
              <dt>Connection</dt>
              <dd>
                {sync.online === false
                  ? 'Offline · waiting to reconnect'
                  : sync.online === true
                    ? 'Online'
                    : 'Checking connection'}
              </dd>
            </div>
            <div>
              <dt>Last successful check</dt>
              <dd>
                {sync.lastSync ? (
                  <time dateTime={sync.lastSync}>
                    {new Date(sync.lastSync).toLocaleString(undefined, {
                      month: 'short',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </time>
                ) : (
                  'No completed check yet'
                )}
              </dd>
            </div>
            <div>
              <dt>Background sync</dt>
              <dd>{sync.paused ? 'Paused for all folders' : 'Enabled'}</dd>
            </div>
          </dl>
          <p className="detail-note">
            The last check covers all sync and backup folders on this computer.
          </p>
        </section>
        <section className="panel">
          <div className="section-title">
            <span className="overview-icon">
              <ShieldCheck size={19} />
            </span>
            <h2>{backup ? 'How backups work' : 'How sync works'}</h2>
          </div>
          <ul className="behavior-list">
            {(backup
              ? [
                  'New and changed local files are copied to your drive.',
                  'Cloud changes never overwrite your local source.',
                  'Deleting a local file keeps its cloud backup.',
                ]
              : [
                  'Changes travel both ways between this folder and your drive.',
                  'Deletions are mirrored; conflicts are kept as separate copies.',
                  'Paused folders keep their changes queued until you resume.',
                ]
            ).map((text) => (
              <li key={text}>{text}</li>
            ))}
          </ul>
        </section>
      </div>
      <section className="panel queue-panel">
        <div className="section-heading">
          <div>
            <h2>Pending activity</h2>
            <p className="muted">
              {backup ? 'Changes from your backup folders' : 'Changes from your sync folders'}
            </p>
          </div>
          <span className="badge">{pending.length} pending</span>
        </div>
        {!pending.length ? (
          <p className="queue-empty">
            {folders.length
              ? 'No local changes waiting. New changes will appear here.'
              : 'Connect a folder to see its activity here.'}
          </p>
        ) : (
          <div className="activity-list">
            {pending.slice(0, 20).map((job) => {
              const root = folders.find((root) => root.id === job.rootId)!;
              return (
                <div className="activity-row" key={job.id}>
                  <span className="overview-icon">
                    <RefreshCw size={16} />
                  </span>
                  <div>
                    <strong>{job.relativePath}</strong>
                    <p>
                      {root.localPathDisplayName} ·{' '}
                      {job.kind === 'delete' ? 'Local deletion' : 'Upload or update'}
                      {job.attempts > 0
                        ? ` · ${job.attempts} attempt${job.attempts === 1 ? '' : 's'}`
                        : ''}
                    </p>
                    {job.error && <p className="activity-error">{job.error}</p>}
                  </div>
                  <span className="badge">
                    {job.error ? 'Retry pending' : root.paused || sync.paused ? 'Paused' : 'Queued'}
                  </span>
                </div>
              );
            })}
            {pending.length > 20 && (
              <p className="detail-note">Showing 20 of {pending.length} pending changes.</p>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
