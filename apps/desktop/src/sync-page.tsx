import { useState } from 'react';
import {
    AlertCircle,
    Check,
    Clock,
    FolderOpen,
    FolderSync,
    Pause,
    Play,
    Plus,
    RefreshCw,
    WifiOff,
} from 'lucide-react';
import { FolderProgress, FolderProgressBanner } from '../../web/components/folder-progress';
import { Button } from '../../web/components/ui/button';
import { Dialog, DialogActions } from '../../web/components/ui/dialog';
import { Alert } from '../../web/components/ui/alert';
import { Badge } from '../../web/components/ui/badge';
import { Card } from '../../web/components/ui/card';
import { Field } from '../../web/components/ui/field';
import { Textarea } from '../../web/components/ui/input';
import type { SyncFolderItem } from '@harbor/contracts';
import { ActionsMenu, MenuItem, MenuSeparator } from '../../web/components/ui/menu';
import {
    folderState,
    syncRequirements,
    WAITING,
    type SyncFolder,
    type SyncIssue,
    type SyncJob,
    type SyncRuntime,
} from './sync-state';
import { storageSize } from './overview';
import { ShareSyncFolderDialog } from './sync-sharing';

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
const needsAttention = (state: string) =>
    ['Action required', 'Conflict', 'Folder unavailable'].includes(state);
function StateIcon({ state }: { state: string; }) {
    if (state === 'Up to date') return <Check aria-hidden="true" />;
    if (state === 'Paused') return <Pause aria-hidden="true" />;
    if (state === 'Offline') return <WifiOff aria-hidden="true" />;
    if (state === 'Syncing') return <RefreshCw className="spin" aria-hidden="true" />;
    if (state === WAITING) return <Clock aria-hidden="true" />;
    return <AlertCircle aria-hidden="true" />;
}
function StateBadge({ state, className }: { state: string; className?: string; }) {
    return (
        <Badge
            className={`${className ?? ''} ${needsAttention(state) ? 'sync-state-error' : ''}`}
            tone={
                needsAttention(state)
                    ? 'danger'
                    : state === 'Up to date'
                        ? 'success'
                        : state === 'Syncing'
                            ? 'accent'
                            : 'neutral'
            }
        >
            <StateIcon state={state} />
            {state}
        </Badge>
    );
}
// An owned folder stops everywhere; a folder shared with you only stops on this computer.
const stopLabel = (root: SyncFolder) =>
    root.shareId ? 'Stop syncing on this computer' : 'Stop syncing on all devices';
/** Banner over an open synced or backed-up folder while its sync or backup is under way. */
export function OpenFolderProgress({
    roots,
    trail,
    state,
    jobs,
}: {
    roots: SyncFolder[];
    trail: { id: string; }[];
    state: SyncRuntime;
    jobs: SyncJob[];
}) {
    const root = roots.find((r) => r.remoteId && trail.some((entry) => entry.id === r.remoteId));
    const percent = root && state.progress?.[root.id];
    if (!root || percent === undefined) return null;
    const sync = root.mode === 'sync';
    if (sync ? folderState(root, state, jobs) !== 'Syncing' : state.paused || root.paused)
        return null;
    const active = state.active?.rootId === root.id ? state.active : null;
    return (
        <FolderProgressBanner
            percent={percent}
            title={`${sync ? 'Syncing' : 'Backing up'} ${root.localPathDisplayName}`}
            detail={
                active
                    ? `${active.direction === 'upload' ? 'Uploading' : 'Downloading'} ${active.relativePath.split('/').at(-1)}`
                    : sync
                        ? 'Syncing changes…'
                        : 'Saving changed files…'
            }
        />
    );
}
const issueText: Record<SyncIssue['code'], string> = {
    MAPPING_REQUIRED: 'Finish setting up this local folder to start syncing.',
    FOLDER_MISSING: 'The local folder can no longer be found.',
    PERMISSION_DENIED: 'harbor0 no longer has permission to access this folder.',
    STORAGE_QUOTA_EXCEEDED: 'Your cloud storage is full. New changes cannot be uploaded.',
    DISK_FULL: 'This computer does not have enough free disk space to download new changes.',
    AUTH_INVALID: 'Your session ended. Sign in again to continue syncing.',
    CONFLICT:
        'This file was changed in more than one place. The local version has been preserved separately for review.',
    FOLDER_RECOVERED:
        'This folder was removed from sync elsewhere. The copy on this computer was kept under a new name and no longer syncs.',
    SYNC_ERROR: 'A change could not be synchronized.',
};
export function SyncProblem({
    issue,
    root,
    action,
    review,
    storage,
    manageFolders,
}: {
    issue: SyncIssue;
    root?: SyncFolder;
    action: (action: string, root: SyncFolder) => void;
    review: (issue: SyncIssue) => void;
    storage: () => void;
    manageFolders: () => void;
}) {
    // Problems with one file or subfolder retry by themselves; relocating the folder cannot fix them.
    const item = issue.scope === 'item';
    return (
        <article className="sync-problem">
            <AlertCircle size={16} aria-hidden="true" />
            <div>
                <h3>{issue.relativePath ?? root?.localPathDisplayName ?? 'Sync needs attention'}</h3>
                <p>
                    {item && issue.code === 'PERMISSION_DENIED'
                        ? 'harbor0 does not have permission to read or change this item. Once its permissions are fixed, syncing retries automatically.'
                        : issueText[issue.code]}
                </p>
                {issue.code === 'SYNC_ERROR' && <p>{issue.message}</p>}
                <div className="sync-problem-actions">
                    {issue.code === 'CONFLICT' && (
                        <Button variant="outline" size="sm" onClick={() => review(issue)}>
                            Review conflict
                        </Button>
                    )}
                    {issue.code === 'FOLDER_RECOVERED' && (
                        <Button variant="outline" size="sm" onClick={() => review(issue)}>
                            Review kept folder
                        </Button>
                    )}
                    {root && item && issue.code !== 'STORAGE_QUOTA_EXCEEDED' && (
                        <Button variant="outline" size="sm" onClick={() => action('open', root)}>
                            Open local folder
                        </Button>
                    )}
                    {root && issue.code === 'MAPPING_REQUIRED' && (
                        <Button variant="outline" size="sm" onClick={() => action('mapping', root)}>
                            Set up sync
                        </Button>
                    )}
                    {root && !item && ['FOLDER_MISSING', 'PERMISSION_DENIED'].includes(issue.code) && (
                        <Button variant="outline" size="sm" onClick={() => action('location', root)}>
                            {issue.code === 'FOLDER_MISSING' ? 'Locate folder' : 'Grant access'}
                        </Button>
                    )}
                    {root && issue.code === 'FOLDER_MISSING' && (
                        <Button
                            variant="ghost"
                            className="sync-remove"
                            size="sm"
                            onClick={() => action('stop', root)}
                        >
                            {stopLabel(root)}…
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
                </div>
            </div>
        </article>
    );
}
export function AddSyncFolderDialog({
    close,
    refresh,
    root,
    remote,
}: {
    root?: SyncFolder;
    // An existing synced folder from another device to link here.
    remote?: { id: string; name: string; };
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
                ...(remote ? { cloudFolderId: remote.id } : {}),
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
                remote
                    ? `Sync “${remote.name}” to this computer`
                    : root
                        ? 'Set up folder sync'
                        : 'Add folder to sync'
            }
            description={
                remote
                    ? 'Choose where this folder lives on this computer. Its files download from your other devices.'
                    : 'Choose a local folder. Its files are kept in your cloud storage and sync to your linked devices.'
            }
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
                    {remote &&
                        'Choose an empty folder, or one that already holds a copy of these files. Anything else in it will sync to your other devices. '}
                    Changes, including deletions, sync between linked devices. Every file is kept in the
                    cloud, so your other devices download changes from there, even when this computer is
                    offline. Conflicting versions are preserved.
                </p>
                {error && <Alert tone="error">{error}</Alert>}
                <DialogActions>
                    <Button variant="outline" disabled={busy} onClick={close}>
                        Cancel
                    </Button>
                    <Button disabled={busy || selecting || !local} onClick={() => void start()}>
                        {busy ? 'Starting…' : 'Start syncing'}
                    </Button>
                </DialogActions>
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
            title={
                root.shareId
                    ? `Stop syncing “${root.localPathDisplayName}” on this computer?`
                    : `Stop syncing “${root.localPathDisplayName}” on all devices?`
            }
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
                {error && <Alert tone="error">{error}</Alert>}
                <DialogActions>
                    <Button variant="outline" disabled={busy} onClick={close}>
                        Cancel
                    </Button>
                    <Button variant="danger" disabled={busy} onClick={() => void stop()}>
                        {busy ? 'Stopping…' : stopLabel(root)}
                    </Button>
                </DialogActions>
            </div>
        </Dialog>
    );
}
export function FolderSettingsDialog({
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
                    <dl className="details sync-details">
                        <dt>Cloud storage</dt>
                        <dd>Every file is kept in your cloud storage</dd>
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
                        <Field label="Relative folders to exclude, one per line">
                            <Textarea
                                rows={5}
                                value={excluded}
                                onChange={(event) => setExcluded(event.target.value)}
                            />
                        </Field>
                        <p>
                            Excluded folders stop syncing in both directions. Existing local and cloud files stay
                            where they are.
                        </p>
                    </>
                )}
                {error && <Alert tone="error">{error}</Alert>}
                <DialogActions>
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
                </DialogActions>
            </div>
        </Dialog>
    );
}
export function ConflictDialog({
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
    const folder = issue.code === 'FOLDER_RECOVERED';
    return (
        <Dialog
            open
            onOpenChange={(value) => {
                if (!value) close();
            }}
            title={folder ? 'Folder kept on this computer' : 'Review conflict'}
            description={issue.relativePath}
        >
            <div className="sync-dialog">
                {folder ? (
                    <p>
                        This folder was removed from sync elsewhere. Because it may contain work that was never
                        synced, the copy on this computer was kept as <strong>{issue.conflictPath}</strong>. It
                        no longer syncs; move anything you still need and delete the rest.
                    </p>
                ) : (
                    <p>
                        Your local version was preserved as <strong>{issue.conflictPath}</strong>. The cloud
                        copy may only be available temporarily. Review the versions on your linked devices
                        before deciding which to keep.
                    </p>
                )}
                <p>
                    Marking this reviewed only dismisses this notice. It does not delete or overwrite
                    {folder ? ' anything.' : ' either version.'}
                </p>
                {error && <Alert tone="error">{error}</Alert>}
                <DialogActions>
                    <Button variant="outline" onClick={() => void open()}>
                        {folder ? 'Show kept folder' : 'Show preserved file'}
                    </Button>
                    <Button onClick={() => void reviewed()}>Mark reviewed</Button>
                </DialogActions>
            </div>
        </Dialog>
    );
}
/** The status and controls of a synced folder, shown above its files in My Drive. */
export function SyncFolderPanel({
    root,
    remote,
    state,
    jobs,
    refresh,
    manageStorage,
}: {
    /** The folder as synced on this computer. */
    root?: SyncFolder;
    /** The folder as synced on other devices, offered here when this computer doesn't sync it. */
    remote?: SyncFolderItem;
    state: SyncRuntime;
    jobs: SyncJob[];
    refresh: () => Promise<void>;
    manageStorage: () => void;
}) {
    const [dialog, setDialog] = useState<{ mode: string; root: SyncFolder; } | null>(null);
    const [conflict, setConflict] = useState<SyncIssue | null>(null);
    const [linking, setLinking] = useState(false);
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
    function action(action: string, folder: SyncFolder) {
        if (action === 'open') void run(() => bridge.reveal({ rootId: folder.id }));
        else if (action === 'pause')
            void run(() =>
                bridge.rootSettings({ id: folder.id, paused: !folder.paused, excluded: folder.excluded }),
            );
        else setDialog({ mode: action, root: folder });
    }
    if (!root) {
        if (!remote) return null;
        const devices = remote.syncDevices.map((device) => device.name);
        return (
            <div className="folder-panel">
                <Card className="backup-summary" aria-label={`${remote.name} sync`}>
                    <div className="backup-summary-main">
                        <span className="icon-tile" aria-hidden="true">
                            <FolderSync />
                        </span>
                        <div>
                            <div className="backup-summary-title">
                                <h2>Not synced on this computer</h2>
                            </div>
                            <p>
                                {devices.length ? `Synced on ${devices.join(', ')}. ` : ''}Choose a local folder to
                                keep a copy here too.
                            </p>
                        </div>
                    </div>
                    <div className="backup-actions backup-summary-actions">
                        <Button size="sm" onClick={() => setLinking(true)}>
                            <Plus />
                            Sync to this computer
                        </Button>
                    </div>
                </Card>
                {linking && (
                    <AddSyncFolderDialog remote={remote} close={() => setLinking(false)} refresh={refresh} />
                )}
            </div>
        );
    }
    const label = folderState(root, state, jobs);
    const percent = label === 'Syncing' ? state.progress?.[root.id] : undefined;
    const issues = syncRequirements([root], state, jobs).filter((issue) => issue.rootId === root.id);
    const synced = root.lastSyncedAt
        ? `Last synced ${ago(root.lastSyncedAt)}`
        : root.needsReconcile
            ? 'Preparing first sync'
            : 'Not synced yet';
    return (
        <div className="folder-panel">
            <Card className="backup-summary" aria-label={`${root.localPathDisplayName} sync`}>
                <div className="backup-summary-main">
                    <span className="icon-tile" aria-hidden="true">
                        <FolderSync />
                    </span>
                    <div>
                        <div className="backup-summary-title">
                            <h2>Synced on this computer</h2>
                            <StateBadge state={label} />
                            {root.shareId && <Badge>Shared with you</Badge>}
                        </div>
                        <p>
                            {root.localPathDisplay ?? root.localPath} · {synced}
                            {root.diskSizeBytes ? ` · ${storageSize(root.diskSizeBytes)}` : ''}
                        </p>
                        {percent !== undefined && (
                            <FolderProgress
                                percent={percent}
                                label={`${root.localPathDisplayName} sync progress`}
                            />
                        )}
                    </div>
                </div>
                <div className="backup-actions backup-summary-actions">
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => action('pause', root)}>
                        {root.paused ? <Play /> : <Pause />}
                        {root.paused ? 'Resume' : 'Pause'}
                    </Button>
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => action('open', root)}>
                        <FolderOpen />
                        Open local folder
                    </Button>
                    <ActionsMenu label={`More actions for ${root.localPathDisplayName}`} disabled={busy}>
                        {!root.shareId && (
                            <MenuItem onClick={() => action('share', root)}>Share folder</MenuItem>
                        )}
                        <MenuItem onClick={() => action('location', root)}>Change local folder</MenuItem>
                        <MenuItem onClick={() => action('exclusions', root)}>Manage exclusions</MenuItem>
                        <MenuItem onClick={() => action('details', root)}>Folder details</MenuItem>
                        <MenuSeparator />
                        <MenuItem tone="danger" onClick={() => action('stop', root)}>
                            {stopLabel(root)}…
                        </MenuItem>
                    </ActionsMenu>
                </div>
            </Card>
            {error && <Alert tone="error">{error}</Alert>}
            {issues.length > 0 && (
                <section className="sync-problems" aria-label="Needs attention">
                    {issues.map((issue) => (
                        <SyncProblem
                            key={issue.id}
                            issue={issue}
                            root={root}
                            action={action}
                            review={setConflict}
                            storage={manageStorage}
                            manageFolders={() => { }}
                        />
                    ))}
                </section>
            )}
            {dialog?.mode === 'stop' && (
                <StopSyncDialog root={dialog.root} close={() => setDialog(null)} refresh={refresh} />
            )}
            {dialog?.mode === 'mapping' && (
                <AddSyncFolderDialog root={dialog.root} close={() => setDialog(null)} refresh={refresh} />
            )}
            {dialog?.mode === 'share' && (
                <ShareSyncFolderDialog root={dialog.root} close={() => setDialog(null)} />
            )}
            {dialog && ['location', 'exclusions', 'details'].includes(dialog.mode) && (
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
