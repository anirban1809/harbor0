import { useState } from 'react';
import {
  AlertCircle,
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  Folder,
  Info,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  RefreshCw,
  WifiOff,
  File,
  Trash2,
} from 'lucide-react';
import * as Menu from '@radix-ui/react-dropdown-menu';
import { DataTable } from '../../web/components/ui/data-table';
import { SyncFileBrowser, type SyncBrowserState } from './sync-file-browser';
import { Button } from '../../web/components/ui/button';
import { Dialog } from '../../web/components/ui/dialog';
import { storageSize } from './overview';
import {
  folderState,
  globalSyncState,
  type SyncFolder,
  type SyncIssue,
  type SyncJob,
  type SyncProgress,
  type SyncRuntime,
} from './sync-state';
import './sync-page.css';
import { SharedSyncInvitations, ShareSyncFolderDialog } from './sync-sharing';

const bridge = window.harbor;
function ago(value?: string | null) {
  if (!value) return 'Not checked yet';
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  return new Date(value).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
function StateIcon({ state }: { state: string }) {
  if (state === 'Up to date') return <Check size={15} />;
  if (state === 'Paused') return <Pause size={15} />;
  if (state === 'Offline') return <WifiOff size={15} />;
  if (state === 'Syncing') return <RefreshCw size={15} />;
  return <AlertCircle size={15} />;
}
export function SyncStatus({ label, detail }: { label: string; detail?: string }) {
  return (
    <div className="sync-status" role="status" aria-live="polite">
      <span
        className={`sync-state ${['Action required', 'Conflict', 'Folder unavailable'].includes(label) ? 'sync-state-error' : ''}`}
      >
        <StateIcon state={label} />
        {label}
      </span>
      {detail && <span className="sync-status-detail">{detail}</span>}
    </div>
  );
}
function TransferProgress({ active }: { active: SyncProgress }) {
  return (
    <div className="sync-progress">
      <p>
        <span>
          {storageSize(active.loaded)} / {storageSize(active.total)}
        </span>
      </p>
      <progress
        aria-label={`${active.direction === 'upload' ? 'Uploading' : 'Downloading'} ${active.relativePath}`}
        max={Math.max(1, active.total)}
        value={active.loaded}
      />
    </div>
  );
}
function HowSyncWorks() {
  return (
    <details className="sync-help">
      <summary>How does sync work?</summary>
      <ul>
        <li>Only folders you explicitly select are kept synchronized on this computer.</li>
        <li>Changes sync between linked devices. Deletions are mirrored.</li>
        <li>Conflicting versions are preserved so you can review them.</li>
        <li>
          Pausing queues changes until you resume. A transfer already in progress may finish first.
        </li>
        <li>
          Sync uses temporary cloud copies, released once all linked devices confirm receipt. Your
          files remain on your devices.
        </li>
        <li>
          Use Backups to protect existing folders in the cloud without syncing changes back to this
          computer.
        </li>
      </ul>
    </details>
  );
}
export function SyncEmptyState({ add }: { add: () => void }) {
  return (
    <section className="sync-empty">
      <span className="sync-empty-icon">
        <Folder size={27} />
      </span>
      <h2>Choose what stays synced on this computer</h2>
      <p>
        Choose a local folder to keep up to date across linked devices. Files are stored in the
        cloud temporarily while syncing. No cloud destination is needed.
      </p>
      <Button onClick={add}>
        <Plus size={16} />
        Add your first sync folder
      </Button>
    </section>
  );
}
function FolderMenu({
  root,
  onAction,
}: {
  root: SyncFolder;
  onAction: (action: string, root: SyncFolder) => void;
}) {
  return (
    <Menu.Root>
      <Menu.Trigger asChild>
        <Button variant="ghost" size="icon" aria-label={`Manage ${root.localPathDisplayName}`}>
          <MoreHorizontal />
        </Button>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content className="dropdown sync-menu" align="end" sideOffset={6}>
          <Menu.Item onSelect={() => onAction('pause', root)}>
            {root.paused ? 'Resume folder sync' : 'Pause folder sync'}
          </Menu.Item>
          {!root.shareId && (
            <Menu.Item onSelect={() => onAction('share', root)}>Share folder</Menu.Item>
          )}
          <Menu.Item onSelect={() => onAction('open', root)}>Open local folder</Menu.Item>
          <Menu.Item onSelect={() => onAction('location', root)}>Change local folder</Menu.Item>
          <Menu.Item onSelect={() => onAction('activity', root)}>View sync activity</Menu.Item>
          <Menu.Item onSelect={() => onAction('exclusions', root)}>Manage exclusions</Menu.Item>
          <Menu.Item onSelect={() => onAction('details', root)}>Folder details</Menu.Item>
          <Menu.Separator className="sync-menu-separator" />
          <Menu.Item className="sync-menu-stop" onSelect={() => onAction('stop', root)}>
            Remove from sync
          </Menu.Item>
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}
export function SyncFolderRow({
  root,
  state,
  jobs,
  action,
}: {
  root: SyncFolder;
  state: SyncRuntime;
  jobs: SyncJob[];
  action: (action: string, root: SyncFolder) => void;
}) {
  const label = folderState(root, state, jobs);
  const pending = jobs.filter((job) => job.rootId === root.id).length;
  return (
    <tr className="sync-folder-row">
      <td>
        <div className="sync-folder-title">
          <Folder size={18} />
          <button onClick={() => action('browse', root)}>{root.localPathDisplayName}</button>
          {root.shareId && <span className="badge">Shared</span>}
        </div>
      </td>
      <td className="sync-folder-path">{root.localPathDisplay ?? root.localPath}</td>
      <td className="sync-folder-counts">
        <span>{(root.fileCount ?? 0).toLocaleString()} files</span>
        <small>{(root.folderCount ?? 0).toLocaleString()} subfolders</small>
      </td>
      <td>
        <span
          className={`sync-folder-state ${['Action required', 'Conflict', 'Folder unavailable'].includes(label) ? 'sync-state-error' : ''}`}
        >
          <StateIcon state={label} />
          {label}
        </span>
      </td>
      <td>
        {root.lastSyncedAt ? (
          <time dateTime={root.lastSyncedAt} title={new Date(root.lastSyncedAt).toLocaleString()}>
            {ago(root.lastSyncedAt)}
          </time>
        ) : root.needsReconcile ? (
          'Preparing first sync'
        ) : (
          'Not synced yet'
        )}
      </td>
      <td>{pending ? `${pending.toLocaleString()} queued` : 'None'}</td>
      <td>
        <button
          className="sync-exclusions"
          onClick={() => action('exclusions', root)}
          title={root.excluded.join(', ') || 'Manage exclusions'}
        >
          {root.excluded.length
            ? `${root.excluded.length} exclusion${root.excluded.length === 1 ? '' : 's'}`
            : 'None'}
        </button>
      </td>
      <td>
        <div className="sync-folder-actions">
          <Button variant="ghost" size="sm" onClick={() => action('open', root)}>
            Open folder
          </Button>
          <FolderMenu root={root} onAction={action} />
        </div>
      </td>
    </tr>
  );
}
export function SyncFolderList({
  roots,
  state,
  jobs,
  action,
}: {
  roots: SyncFolder[];
  state: SyncRuntime;
  jobs: SyncJob[];
  action: (action: string, root: SyncFolder) => void;
}) {
  return (
    <section className="sync-folders" id="sync-folders">
      <div className="sync-section-heading">
        <h2>Folders synced on this computer</h2>
        <p>Local folders kept up to date across linked devices using temporary cloud storage.</p>
      </div>
      <DataTable label="Synced folders" className="sync-folders-table">
        <thead>
          <tr>
            {[
              'Folder',
              'Local location',
              'Contents',
              'Status',
              'Last synced',
              'Changes',
              'Exclusions',
              'Actions',
            ].map((heading) => (
              <th key={heading} scope="col">
                {heading}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {roots.map((root) => (
            <SyncFolderRow key={root.id} root={root} state={state} jobs={jobs} action={action} />
          ))}
        </tbody>
      </DataTable>
    </section>
  );
}
const issueText: Record<SyncIssue['code'], string> = {
  MAPPING_REQUIRED: 'Finish setting up this local folder to start syncing.',
  FOLDER_MISSING: 'The local folder can no longer be found.',
  PERMISSION_DENIED: 'harbor0 no longer has permission to access this folder.',
  STORAGE_QUOTA_EXCEEDED: 'Your cloud storage is full. New changes cannot be uploaded.',
  DISK_FULL: 'This computer does not have enough free disk space to download new changes.',
  AUTH_INVALID: 'Sign in again to continue syncing.',
  CONFLICT:
    'This file was changed in more than one place. The local version has been preserved separately for review.',
  SYNC_ERROR: 'A change could not be synchronized.',
};
export function SyncProblem({
  issue,
  root,
  action,
  review,
  storage,
  signIn,
  manageFolders,
}: {
  issue: SyncIssue;
  root?: SyncFolder;
  action: (action: string, root: SyncFolder) => void;
  review: (issue: SyncIssue) => void;
  storage: () => void;
  signIn: () => void;
  manageFolders: () => void;
}) {
  return (
    <article className="sync-problem">
      <AlertCircle size={18} />
      <div>
        <h3>{issue.relativePath ?? root?.localPathDisplayName ?? 'Sync needs attention'}</h3>
        <p>{issueText[issue.code]}</p>
        {issue.code === 'SYNC_ERROR' && <p>{issue.message}</p>}
        <div className="sync-problem-actions">
          {issue.code === 'CONFLICT' && (
            <Button variant="outline" size="sm" onClick={() => review(issue)}>
              Review conflict
            </Button>
          )}
          {root && issue.code === 'MAPPING_REQUIRED' && (
            <Button variant="outline" size="sm" onClick={() => action('mapping', root)}>
              Set up sync
            </Button>
          )}
          {root && ['FOLDER_MISSING', 'PERMISSION_DENIED'].includes(issue.code) && (
            <Button variant="outline" size="sm" onClick={() => action('location', root)}>
              {issue.code === 'FOLDER_MISSING' ? 'Locate folder' : 'Grant access'}
            </Button>
          )}
          {root && issue.code === 'FOLDER_MISSING' && (
            <Button variant="ghost" size="sm" onClick={() => action('stop', root)}>
              Remove from sync
            </Button>
          )}
          {issue.code === 'STORAGE_QUOTA_EXCEEDED' && (
            <Button variant="outline" size="sm" onClick={storage}>
              Manage storage
            </Button>
          )}
          {issue.code === 'DISK_FULL' && (
            <Button variant="outline" size="sm" onClick={manageFolders}>
              Manage synced folders
            </Button>
          )}
          {issue.code === 'AUTH_INVALID' && (
            <Button variant="outline" size="sm" onClick={signIn}>
              Sign in
            </Button>
          )}
        </div>
      </div>
    </article>
  );
}
export function SyncActivity({
  roots,
  state,
  jobs,
  filter,
  clearFilter,
}: {
  roots: SyncFolder[];
  state: SyncRuntime;
  jobs: SyncJob[];
  filter?: string;
  clearFilter: () => void;
}) {
  const ids = new Set(roots.filter((root) => !filter || root.id === filter).map((root) => root.id));
  const active = state.active && ids.has(state.active.rootId) ? state.active : null;
  const queued = jobs.filter(
    (job) =>
      ids.has(job.rootId) &&
      !(job.rootId === active?.rootId && job.relativePath === active?.relativePath),
  );
  const recent = (state.recent ?? []).filter((item) => ids.has(item.rootId)).slice(0, 5);
  const idle = !active && !queued.length;
  const needsAttention = state.issues?.some((issue) => ids.has(issue.rootId) || !issue.rootId);
  return (
    <section className="sync-activity" id="sync-activity" tabIndex={-1}>
      <div className="sync-section-heading sync-activity-heading">
        <div>
          <h2>Sync activity</h2>
          <p>
            {active ? '1 syncing' : 'No active transfers'} · {queued.length} pending
          </p>
        </div>
        {filter && (
          <Button variant="ghost" size="sm" onClick={clearFilter}>
            Show all folders
          </Button>
        )}
      </div>
      {filter && (
        <p className="sync-filter-label">
          {roots.find((root) => root.id === filter)?.localPathDisplayName}
        </p>
      )}
      {!idle && (
        <DataTable
          label="Current sync activity"
          className="sync-activity-table"
          containerClassName="sync-queue"
        >
          <caption className="sr-only">Active transfers and pending sync changes</caption>
          <thead>
            <tr>
              <th scope="col">File</th>
              <th scope="col">Folder</th>
              <th scope="col">Operation</th>
              <th scope="col">Progress</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {active && (
              <tr className="sync-active-row">
                <td>
                  <span className="sync-table-file">
                    <File size={18} />
                    <strong>{active.relativePath}</strong>
                  </span>
                </td>
                <td>{roots.find((root) => root.id === active.rootId)?.localPathDisplayName}</td>
                <td>{active.direction === 'upload' ? 'Upload' : 'Download'}</td>
                <td>
                  <TransferProgress active={active} />
                </td>
                <td>
                  <span className="badge">Syncing</span>
                </td>
              </tr>
            )}
            {queued.map((job) => (
              <tr key={job.id}>
                <td>
                  <span className="sync-table-file">
                    {job.kind === 'delete' ? <Trash2 size={18} /> : <File size={18} />}
                    <strong>{job.relativePath}</strong>
                  </span>
                </td>
                <td>{roots.find((root) => root.id === job.rootId)?.localPathDisplayName}</td>
                <td>{job.kind === 'delete' ? 'Delete' : 'Upload'}</td>
                <td>
                  <span className="muted">—</span>
                </td>
                <td>
                  <span className="badge">
                    {job.error
                      ? 'Retry pending'
                      : state.paused || roots.find((root) => root.id === job.rootId)?.paused
                        ? 'Pending · Paused'
                        : !state.online
                          ? 'Pending · Offline'
                          : 'Pending'}
                  </span>
                  {job.error && <p className="error">{job.error}</p>}
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}
      {idle && (
        <div className="sync-idle">
          <StateIcon
            state={
              needsAttention
                ? 'Action required'
                : state.paused
                  ? 'Paused'
                  : !state.online
                    ? 'Offline'
                    : 'Up to date'
            }
          />
          <div>
            <strong>
              {needsAttention
                ? 'Review the items that need attention below'
                : state.paused
                  ? 'Sync is paused'
                  : !state.online
                    ? 'Waiting for a connection'
                    : roots.some((root) => root.needsReconcile)
                      ? 'Checking files for changes'
                      : 'Everything is up to date'}
            </strong>
            <p>
              {state.lastSync
                ? `Last successful check ${ago(state.lastSync)}`
                : 'Waiting for the first successful check'}
            </p>
          </div>
        </div>
      )}
      {!!recent.length && (
        <details className="sync-recent" open>
          <summary>Recent activity</summary>
          <DataTable label="Recent sync activity" className="sync-recent-table">
            <thead>
              <tr>
                <th scope="col">File</th>
                <th scope="col">Folder</th>
                <th scope="col">Operation</th>
                <th scope="col">Completed</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((item) => (
                <tr key={item.id}>
                  <td>
                    <span className="sync-table-file">
                      {item.direction === 'upload' ? (
                        <ArrowUpFromLine size={16} />
                      ) : (
                        <ArrowDownToLine size={16} />
                      )}
                      <strong>{item.relativePath}</strong>
                    </span>
                  </td>
                  <td>{roots.find((root) => root.id === item.rootId)?.localPathDisplayName}</td>
                  <td>{item.direction === 'upload' ? 'Uploaded' : 'Downloaded'}</td>
                  <td>
                    <time dateTime={item.at} title={new Date(item.at).toLocaleString()}>
                      {ago(item.at)}
                    </time>
                  </td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        </details>
      )}
    </section>
  );
}

export function AddSyncFolderDialog({
  close,
  refresh,
  root,
}: {
  root?: SyncFolder;
  close: () => void;
  refresh: () => Promise<void>;
}) {
  const [local, setLocal] = useState<Awaited<ReturnType<typeof bridge.selectSyncLocal>>>(
    root ? { selectionId: '', path: root.localPath, name: root.localPathDisplayName } : null,
  );
  const [busy, setBusy] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [error, setError] = useState('');
  async function chooseLocal() {
    setSelecting(true);
    setError('');
    try {
      const selected = await bridge.selectSyncLocal();
      if (selected) setLocal(selected);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setSelecting(false);
    }
  }
  async function start() {
    if (!local) return;
    setBusy(true);
    setError('');
    try {
      await bridge.addSyncRoot({
        selectionId: local.selectionId || undefined,
        rootId: root?.id,
      });
      await refresh();
      close();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(value) => {
        if (!value && !busy) close();
      }}
      title={root ? 'Set up folder sync' : 'Add folder to sync'}
      description="Choose a local folder. Files use temporary cloud storage while syncing between linked devices."
    >
      <div className="sync-dialog">
        <div className="sync-location-picker">
          <div>
            <span>Local folder</span>
            <strong>{local?.path ?? 'Choose a folder on this computer'}</strong>
          </div>
          <Button variant="outline" disabled={busy || selecting} onClick={() => void chooseLocal()}>
            Choose local folder
          </Button>
        </div>
        <p className="sync-setup-note">
          Changes, including deletions, sync between linked devices. Cloud copies are temporary and
          released once all linked devices confirm receipt. No cloud destination is needed.
          Conflicting versions are preserved.
        </p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <Button variant="outline" disabled={busy} onClick={close}>
            Cancel
          </Button>
          <Button disabled={busy || selecting || !local} onClick={() => void start()}>
            {busy ? 'Starting…' : 'Start syncing'}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

export function StopSyncDialog({
  root,
  close,
  refresh,
}: {
  root: SyncFolder;
  close: () => void;
  refresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function stop() {
    setBusy(true);
    try {
      await bridge.stopSyncRoot({ id: root.id });
      await refresh();
      close();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(value) => {
        if (!value && !busy) close();
      }}
      title={`Remove from sync “${root.localPathDisplayName}”?`}
      description={
        root.shareId
          ? 'This shared folder will stop syncing on this computer. Your local files will stay where they are.'
          : 'This folder will stop syncing on all linked devices and disappear from the app. Your local files will stay where they are.'
      }
    >
      <div className="sync-dialog">
        <p>
          {root.shareId
            ? 'Other devices and the owner’s folder are unaffected. You can link this folder again from Shared with you.'
            : 'Local folders and their contents are preserved on every device. Offline devices will stop syncing this folder when they reconnect.'}
        </p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <Button variant="outline" disabled={busy} onClick={close}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={busy} onClick={() => void stop()}>
            {busy ? 'Removing…' : 'Remove from sync'}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
function FolderSettingsDialog({
  root,
  mode,
  close,
  refresh,
}: {
  root: SyncFolder;
  mode: string;
  close: () => void;
  refresh: () => Promise<void>;
}) {
  const [selection, setSelection] =
    useState<Awaited<ReturnType<typeof bridge.selectSyncLocal>>>(null);
  const [excluded, setExcluded] = useState(root.excluded.join('\n'));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function select() {
    try {
      const local = await bridge.selectSyncLocal();
      if (local) setSelection(local);
    } catch (error) {
      setError((error as Error).message);
    }
  }
  async function save() {
    setBusy(true);
    setError('');
    try {
      if (mode === 'location' && selection)
        await bridge.changeSyncLocal({ id: root.id, selectionId: selection.selectionId });
      else
        await bridge.rootSettings({
          id: root.id,
          paused: root.paused,
          excluded: excluded
            .split('\n')
            .map((value) => value.trim())
            .filter(Boolean),
        });
      await refresh();
      close();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(value) => {
        if (!value && !busy) close();
      }}
      title={
        mode === 'location'
          ? 'Change local folder'
          : mode === 'details'
            ? 'Folder details'
            : 'Manage exclusions'
      }
      description={root.localPathDisplayName}
    >
      <div className="sync-dialog">
        {mode === 'location' ? (
          <>
            <p>
              Choose a new local location for <strong>{root.localPathDisplayName}</strong>. Your
              previous local folder stays untouched. Sync will resume at the new location after you
              confirm.
            </p>
            <div className="sync-location-picker">
              <strong>{selection?.path ?? root.localPath}</strong>
              <Button variant="outline" disabled={busy} onClick={() => void select()}>
                Choose local folder
              </Button>
            </div>
          </>
        ) : mode === 'details' ? (
          <dl className="sync-details">
            <dt>Cloud storage</dt>
            <dd>Temporary, until linked devices confirm receipt</dd>
            <dt>This computer</dt>
            <dd>{root.localPath}</dd>
            <dt>Tracked files</dt>
            <dd>{root.fileCount}</dd>
            <dt>Subfolders</dt>
            <dd>{root.folderCount}</dd>
            <dt>Exclusions</dt>
            <dd>{root.excluded.join(', ') || 'None'}</dd>
          </dl>
        ) : (
          <>
            <label>
              Relative folders to exclude, one per line
              <textarea
                rows={5}
                value={excluded}
                onChange={(event) => setExcluded(event.target.value)}
              />
            </label>
            <p>
              Excluded folders stop syncing in both directions. Existing local and cloud files stay
              where they are.
            </p>
          </>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <Button variant="outline" disabled={busy} onClick={close}>
            {mode === 'details' ? 'Close' : 'Cancel'}
          </Button>
          {mode !== 'details' && (
            <Button
              disabled={busy || (mode === 'location' && !selection)}
              onClick={() => void save()}
            >
              {busy ? 'Saving…' : mode === 'location' ? 'Use folder and resume' : 'Save exclusions'}
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  );
}
function ConflictDialog({
  issue,
  close,
  refresh,
}: {
  issue: SyncIssue;
  close: () => void;
  refresh: () => Promise<void>;
}) {
  const [error, setError] = useState('');
  async function open() {
    try {
      await bridge.reviewSyncConflict({ id: issue.id });
    } catch (error) {
      setError((error as Error).message);
    }
  }
  async function reviewed() {
    try {
      await bridge.dismissSyncConflict({ id: issue.id });
      await refresh();
      close();
    } catch (error) {
      setError((error as Error).message);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(value) => {
        if (!value) close();
      }}
      title="Review conflict"
      description={issue.relativePath}
    >
      <div className="sync-dialog">
        <p>
          Your local version was preserved as <strong>{issue.conflictPath}</strong>. The cloud copy
          may only be available temporarily. Review the versions on your linked devices before
          deciding which to keep.
        </p>
        <p>
          Marking this reviewed only dismisses this notice. It does not delete or overwrite either
          version.
        </p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <Button variant="outline" onClick={() => void open()}>
            Show preserved file
          </Button>
          <Button onClick={() => void reviewed()}>Mark reviewed</Button>
        </div>
      </div>
    </Dialog>
  );
}
export function SyncPage({
  roots: allRoots,
  jobs,
  state,
  deviceName,
  refresh,
  openCloud,
  manageStorage,
}: {
  roots: SyncFolder[];
  jobs: SyncJob[];
  state: SyncBrowserState;
  deviceName: string;
  refresh: () => Promise<void>;
  openCloud: (root: SyncFolder) => void;
  manageStorage: () => void;
}) {
  const roots = allRoots.filter((root) => root.mode === 'sync');
  const ids = new Set(roots.map((root) => root.id));
  const syncJobs = jobs.filter((job) => ids.has(job.rootId));
  const issues = (state.issues ?? []).filter((issue) => ids.has(issue.rootId) || !issue.rootId);
  // Older queued errors still surface before the engine has classified them.
  for (const job of syncJobs.filter(
    (job) =>
      state.online !== false && job.error && !issues.some((issue) => issue.rootId === job.rootId),
  ))
    issues.push({
      id: job.id,
      rootId: job.rootId,
      relativePath: job.relativePath,
      code: 'SYNC_ERROR',
      message: job.error!,
      at: '',
    });
  const label = globalSyncState(roots, state, syncJobs);
  const [adding, setAdding] = useState(false);
  const [dialog, setDialog] = useState<{ mode: string; root: SyncFolder } | null>(null);
  const [conflict, setConflict] = useState<SyncIssue | null>(null);
  const [filter, setFilter] = useState<string>();
  const [tab, setTab] = useState<'files' | 'activity'>('files');
  const [browseRoot, setBrowseRoot] = useState<string>();
  function showFiles() {
    setBrowseRoot(undefined);
    setTab('files');
    document.getElementById('sync-tab-files')?.focus();
  }
  const browsing = roots.find((root) => root.id === browseRoot);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function run(task: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await task();
      await refresh();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function action(action: string, root: SyncFolder) {
    if (action === 'browse') setBrowseRoot(root.id);
    else if (action === 'open') void run(() => bridge.reveal({ rootId: root.id }));
    else if (action === 'cloud') openCloud(root);
    else if (action === 'pause')
      void run(() =>
        bridge.rootSettings({ id: root.id, paused: !root.paused, excluded: root.excluded }),
      );
    else if (action === 'activity') {
      setFilter(root.id);
      setTab('activity');
      document.getElementById('sync-tab-activity')?.focus();
    } else setDialog({ mode: action, root });
  }
  const detail = state.paused
    ? 'Changes are being queued and will continue when syncing resumes.'
    : !state.online
      ? 'You’re offline. Changes will sync when the connection returns.'
      : state.lastSync
        ? `Last checked ${ago(state.lastSync)}`
        : 'Waiting for the first check';
  return (
    <div className="sync-page">
      <header className="sync-page-header">
        <div>
          <h1>Sync on {deviceName || 'this computer'}</h1>
          <SyncStatus label={label} detail={detail} />
        </div>
        <div className="sync-header-actions">
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void run(() => bridge.pause({ paused: !state.paused }))}
          >
            {state.paused ? <Play size={15} /> : <Pause size={15} />}
            {state.paused ? 'Resume sync' : 'Pause sync'}
          </Button>
          <Button onClick={() => setAdding(true)}>
            <Plus size={16} />
            Add folder to sync
          </Button>
        </div>
      </header>
      <div className="sync-tabs" role="tablist" aria-label="Sync views">
        {(['files', 'activity'] as const).map((value, index) => (
          <button
            key={value}
            id={`sync-tab-${value}`}
            type="button"
            role="tab"
            aria-selected={tab === value}
            aria-controls={`sync-panel-${value}`}
            tabIndex={tab === value ? 0 : -1}
            onClick={() => setTab(value)}
            onKeyDown={(event) => {
              const next =
                event.key === 'Home'
                  ? 'files'
                  : event.key === 'End'
                    ? 'activity'
                    : ['ArrowLeft', 'ArrowRight'].includes(event.key)
                      ? index === 0
                        ? 'activity'
                        : 'files'
                      : null;
              if (next) {
                event.preventDefault();
                setTab(next);
                document.getElementById(`sync-tab-${next}`)?.focus();
              }
            }}
          >
            {value === 'files' ? 'Files' : 'Activity'}
          </button>
        ))}
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div
        id="sync-panel-files"
        role="tabpanel"
        aria-labelledby="sync-tab-files"
        hidden={tab !== 'files'}
        tabIndex={0}
      >
        <div className="sync-selective-note">
          <Info size={17} />
          <p>
            Only the folders listed below are kept synchronized on this computer. Sync files use
            temporary cloud storage until all linked devices confirm receipt.
          </p>
        </div>
        {browsing ? (
          <>
            <div className="sync-browser-heading">
              <h2>{browsing.localPathDisplayName}</h2>
              <span>
                {browsing.shareId && <span className="badge">Shared · Can edit</span>}
                <FolderMenu root={browsing} onAction={action} />
              </span>
            </div>
            <SyncFileBrowser
              key={browsing.id}
              root={browsing}
              state={state}
              back={() => setBrowseRoot(undefined)}
            />
          </>
        ) : roots.length ? (
          <SyncFolderList roots={roots} state={state} jobs={syncJobs} action={action} />
        ) : (
          <SyncEmptyState add={() => setAdding(true)} />
        )}
        <SharedSyncInvitations roots={roots} refresh={refresh} />
      </div>
      <div
        id="sync-panel-activity"
        role="tabpanel"
        aria-labelledby="sync-tab-activity"
        hidden={tab !== 'activity'}
        tabIndex={0}
      >
        <SyncActivity
          roots={roots}
          state={state}
          jobs={syncJobs}
          filter={roots.some((root) => root.id === filter) ? filter : undefined}
          clearFilter={() => setFilter(undefined)}
        />
      </div>
      {!!issues.length && (
        <section className="sync-problems" aria-label="Needs attention">
          <h2>
            Needs attention <span>{issues.length}</span>
          </h2>
          {issues.map((issue) => (
            <SyncProblem
              key={issue.id}
              issue={issue}
              root={roots.find((root) => root.id === issue.rootId)}
              action={action}
              review={setConflict}
              storage={manageStorage}
              signIn={() => void run(() => bridge.logout())}
              manageFolders={showFiles}
            />
          ))}
        </section>
      )}
      <HowSyncWorks />
      {adding && <AddSyncFolderDialog close={() => setAdding(false)} refresh={refresh} />}
      {dialog?.mode === 'stop' && (
        <StopSyncDialog root={dialog.root} close={() => setDialog(null)} refresh={refresh} />
      )}
      {dialog?.mode === 'mapping' && (
        <AddSyncFolderDialog root={dialog.root} close={() => setDialog(null)} refresh={refresh} />
      )}
      {dialog?.mode === 'share' && (
        <ShareSyncFolderDialog root={dialog.root} close={() => setDialog(null)} />
      )}
      {dialog && !['stop', 'mapping', 'share'].includes(dialog.mode) && (
        <FolderSettingsDialog
          root={dialog.root}
          mode={dialog.mode}
          close={() => setDialog(null)}
          refresh={refresh}
        />
      )}
      {conflict && (
        <ConflictDialog issue={conflict} close={() => setConflict(null)} refresh={refresh} />
      )}
    </div>
  );
}
