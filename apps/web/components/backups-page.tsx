'use client';
import { useEffect, useState, type ReactNode } from 'react';
import {
  AlertCircle,
  Archive,
  CheckCircle2,
  ChevronRight,
  Download,
  Folder,
  Loader2,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Trash2,
  Settings2,
  X,
} from 'lucide-react';
import type { ApiClient } from '@harbor/api-client';
import type { DriveItem, FileVersion } from '@harbor/contracts';
import type {
  BackupRoot,
  BackupRun,
  BackupEntry,
  BackupRestore,
} from '../../../packages/contracts/src/backups';
import { fileDate, fileKind, fileSize } from '../lib/file-metadata';
import { Button } from './ui/button';
import { Dialog, DialogActions, Drawer } from './ui/dialog';
import { Alert } from './ui/alert';
import { Badge, type BadgeTone } from './ui/badge';
import { Card } from './ui/card';
import { Tab, TabList, TabPanel, Tabs } from './ui/tabs';
import { EmptyState } from './empty-state';
import { FileCollection, FileCollectionSkeleton } from './file-collection';

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const date = (value: string) => dateFormat.format(new Date(value));
const relativeFormat = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
function ago(value: string) {
  const minutes = Math.round((new Date(value).getTime() - Date.now()) / 60000);
  if (Math.abs(minutes) < 1) return 'just now';
  if (Math.abs(minutes) < 60) return relativeFormat.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return relativeFormat.format(hours, 'hour');
  const days = Math.round(hours / 24);
  return Math.abs(days) < 7 ? relativeFormat.format(days, 'day') : `on ${date(value)}`;
}
const count = (value: number, noun: string) => `${value} ${noun}${value === 1 ? '' : 's'}`;
const runStates: Record<BackupRun['state'], string> = {
  RUNNING: 'In progress',
  COMPLETED: 'Done',
  PARTIAL: 'Some files skipped',
  FAILED: 'Failed',
};
const restoreStates: Record<BackupRestore['state'], string> = {
  PENDING: 'Waiting',
  COMPLETED: 'Restored',
  FAILED: 'Failed',
};
type Tab = 'Files' | 'History';
const tabs: Tab[] = ['Files', 'History'];
type Tone = 'ok' | 'busy' | 'paused' | 'error' | 'stopped';
type LocalRoot = {
  id: string;
  remoteId: string | null;
  paused: boolean;
  excluded?: string[];
  localPathDisplay?: string;
  localPathDisplayName?: string;
};
type Props = {
  api: ApiClient;
  desktop?: {
    roots: LocalRoot[];
    add: () => Promise<unknown>;
    backup: (id: string) => Promise<unknown>;
    disconnect: (id: string) => Promise<unknown>;
    setPaused: (root: LocalRoot, paused: boolean) => Promise<unknown>;
    download: (input: { itemId: string; versionId: string; name: string }) => Promise<unknown>;
    options: (root: LocalRoot) => void;
    refresh: () => Promise<unknown>;
  };
};
async function collection<T>(api: ApiClient, url: string): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  do {
    const result = await api.request(
      `${url}${cursor ? `${url.includes('?') ? '&' : '?'}cursor=${encodeURIComponent(cursor)}` : ''}`,
    );
    items.push(...result.items);
    cursor = result.nextCursor ?? undefined;
  } while (cursor);
  return items;
}
function StatusBadge({ tone, children }: { tone: Tone; children: ReactNode }) {
  const Icon =
    tone === 'ok'
      ? CheckCircle2
      : tone === 'busy'
        ? Loader2
        : tone === 'paused'
          ? Pause
          : tone === 'error'
            ? AlertCircle
            : X;
  const tones: Record<Tone, BadgeTone> = {
    ok: 'success',
    busy: 'accent',
    paused: 'neutral',
    error: 'danger',
    stopped: 'neutral',
  };
  return (
    <Badge className="backup-badge" tone={tones[tone]} data-state={tone}>
      <Icon aria-hidden="true" className={tone === 'busy' ? 'spin' : undefined} />
      {children}
    </Badge>
  );
}
export function BackupsPage({ api, desktop }: Props) {
  const [tab, setTab] = useState<Tab>('Files');
  const [roots, setRoots] = useState<BackupRoot[]>([]);
  const [rootId, setRootId] = useState('');
  const [stopping, setStopping] = useState(false);
  const [removing, setRemoving] = useState(false);
  const root = roots.find((r) => r.id === rootId);
  const [trail, setTrail] = useState<{ id: string; name: string }[]>([]);
  const [items, setItems] = useState<DriveItem[]>([]);
  const [loadedFolder, setLoadedFolder] = useState('');
  const [selected, setSelected] = useState<DriveItem | null>(null);
  const [versions, setVersions] = useState<FileVersion[]>([]);
  const [versionsFor, setVersionsFor] = useState('');
  const [runs, setRuns] = useState<BackupRun[]>([]);
  const [restores, setRestores] = useState<BackupRestore[]>([]);
  const [historyFor, setHistoryFor] = useState('');
  const [run, setRun] = useState<BackupRun | null>(null);
  const [entries, setEntries] = useState<BackupEntry[]>([]);
  const [entriesFor, setEntriesFor] = useState('');
  const [restore, setRestore] = useState<{
    itemId: string;
    versionId: string;
    name: string;
    createdAt: string;
    requestId: string;
  } | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [rootsLoaded, setRootsLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const local = desktop?.roots.find((r) => r.remoteId === root?.remoteRootDriveItemId);
  const removed = root?.state === 'REMOVED';
  const device = (value: BackupRoot | undefined) =>
    desktop?.roots.some((r) => r.remoteId === value?.remoteRootDriveItemId)
      ? 'This computer'
      : (value?.deviceName ?? 'Another computer');
  const deviceName = local ? 'this computer' : (root?.deviceName ?? 'the source computer');
  useEffect(() => {
    let active = true;
    api
      .request('/v1/backups')
      .then((result) => {
        if (!active) return;
        // Active folders first; stopped backups stay listed so their history remains reachable.
        const list = [...(result.items as BackupRoot[])].sort(
          (a, b) =>
            Number(a.state === 'REMOVED') - Number(b.state === 'REMOVED') ||
            a.localPathDisplayName.localeCompare(b.localPathDisplayName),
        );
        setRoots(list);
        setRootId((current) =>
          list.some((r) => r.id === current) ? current : (list[0]?.id ?? ''),
        );
        setRootsLoaded(true);
      })
      .catch((e) => {
        if (active) {
          setError(e.message);
          setRootsLoaded(true);
        }
      });
    return () => {
      active = false;
    };
  }, [api, refresh]);
  useEffect(() => {
    const timer = setInterval(() => setRefresh((value) => value + 1), 15000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(''), 8000);
    return () => clearTimeout(timer);
  }, [message]);
  const activeRootId = root?.id;
  const folderId = trail.at(-1)?.id ?? root?.remoteRootDriveItemId;
  useEffect(() => {
    let active = true;
    if (!activeRootId || !folderId) return;
    collection<DriveItem>(api, `/v1/drive/folders/${encodeURIComponent(folderId)}/children`)
      .then((files) => {
        if (!active) return;
        setItems(
          files.sort((a, b) =>
            a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'FOLDER' ? -1 : 1,
          ),
        );
        setLoadedFolder(folderId);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [api, activeRootId, folderId, refresh]);
  useEffect(() => {
    let active = true;
    if (!activeRootId) return;
    const base = `/v1/backups/${activeRootId}`;
    Promise.all([
      collection<BackupRun>(api, `${base}/runs`),
      collection<BackupRestore>(api, `${base}/restores`),
    ])
      .then(([history, recovery]) => {
        if (!active) return;
        setRuns(history.sort((a, b) => b.startedAt.localeCompare(a.startedAt)));
        setRestores(recovery.sort((a, b) => b.requestedAt.localeCompare(a.requestedAt)));
        setHistoryFor(activeRootId);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [api, activeRootId, refresh]);
  const selectedId = selected?.id;
  useEffect(() => {
    let active = true;
    if (!selectedId) return;
    api
      .request(`/v1/drive/items/${selectedId}/versions`)
      .then((result) => {
        if (!active) return;
        setVersions(result.items);
        setVersionsFor(selectedId);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [api, selectedId, refresh]);
  const runId = run?.id;
  useEffect(() => {
    let active = true;
    if (!runId || !activeRootId) return;
    collection<BackupEntry>(api, `/v1/backups/${activeRootId}/runs/${runId}/files`)
      .then((result) => {
        if (!active) return;
        setEntries(result);
        setEntriesFor(runId);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [api, runId, activeRootId, refresh]);
  // Only show loading placeholders when the view changes, never on background refreshes.
  const folderLoading = loadedFolder !== folderId;
  const historyLoading = historyFor !== activeRootId;
  const shownItems = folderLoading ? [] : items;
  const shownRuns = historyLoading ? [] : runs;
  const shownRestores = historyLoading ? [] : restores;
  const pendingRestores = shownRestores.filter((r) => r.state === 'PENDING').length;
  function changeRoot(id: string) {
    setRootId(id);
    setTrail([]);
    setSelected(null);
    setRun(null);
    setError('');
  }
  function openFolder(next: { id: string; name: string }[]) {
    setTrail(next);
    setSelected(null);
  }
  async function act(action: () => Promise<unknown>, success: string | (() => string)) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await action();
      setMessage(typeof success === 'string' ? success : success());
      setRefresh((value) => value + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const download = (itemId: string, versionId: string, name: string) => {
    // The desktop save dialog can be cancelled; only confirm copies that were written.
    let saved = true;
    return act(
      async () => {
        if (desktop) {
          saved = !!(await desktop.download({ itemId, versionId, name }));
          return;
        }
        const signed = await api.download({ driveItemId: itemId, versionId });
        const anchor = document.createElement('a');
        anchor.href = signed.downloadUrl;
        anchor.download = name;
        anchor.rel = 'noopener';
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
      },
      () => (!saved ? '' : desktop ? `Saved a copy of ${name}.` : `Downloading a copy of ${name}.`),
    );
  };
  function versionActions(itemId: string, versionId: string, name: string, createdAt: string) {
    return (
      <div className="backup-actions">
        {!removed && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() =>
              setRestore({ itemId, versionId, name, createdAt, requestId: crypto.randomUUID() })
            }
          >
            <RotateCcw />
            Restore
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          aria-label={`Download this version of ${name}`}
          onClick={() => void download(itemId, versionId, name)}
        >
          <Download />
          Download
        </Button>
      </div>
    );
  }
  const latestRun = shownRuns[0];
  const lastGoodRun = shownRuns.find((r) => r.state === 'COMPLETED' || r.state === 'PARTIAL');
  const status: { tone: Tone; label: string; detail: string } = !root
    ? { tone: 'ok', label: '', detail: '' }
    : removed
      ? {
          tone: 'stopped',
          label: 'Stopped',
          detail: `No new versions are saved. The backed-up files are now regular files in My Drive → Cloud.`,
        }
      : local?.paused || root.state === 'PAUSED'
        ? {
            tone: 'paused',
            label: 'Paused',
            detail: 'No new versions are saved until you resume. Saved versions are still here.',
          }
        : latestRun?.state === 'RUNNING'
          ? {
              tone: 'busy',
              label: 'Backing up',
              detail: `Saving ${count(latestRun.fileCount, 'file')} so far…`,
            }
          : root.state === 'ERROR' || latestRun?.state === 'FAILED'
            ? {
                tone: 'error',
                label: 'Needs attention',
                detail: latestRun?.error
                  ? `The last backup didn’t finish: ${latestRun.error}`
                  : `The last backup didn’t finish. It will try again automatically.`,
              }
            : lastGoodRun
              ? {
                  tone: latestRun?.state === 'PARTIAL' ? 'error' : 'ok',
                  label: latestRun?.state === 'PARTIAL' ? 'Some files skipped' : 'Backed up',
                  detail: `Last backed up ${ago(lastGoodRun.completedAt ?? lastGoodRun.startedAt)}.`,
                }
              : {
                  tone: 'ok',
                  label: 'Waiting',
                  detail: historyLoading
                    ? 'Checking backup status…'
                    : 'The first backup runs once files have been unchanged for an hour.',
                };
  const rootTone = (value: BackupRoot): [Tone, string] => {
    const localRoot = desktop?.roots.find((r) => r.remoteId === value.remoteRootDriveItemId);
    if (value.id === root?.id) return [status.tone, status.label];
    if (value.state === 'REMOVED') return ['stopped', 'Stopped'];
    if (value.state === 'PAUSED' || localRoot?.paused) return ['paused', 'Paused'];
    if (value.state === 'ERROR') return ['error', 'Needs attention'];
    return ['ok', 'On'];
  };
  const addFolder = () =>
    void act(async () => {
      await desktop!.add();
      await desktop!.refresh();
    }, 'Folder added. Its first backup starts once files have been unchanged for an hour.');
  return (
    <div className="backup-page">
      <div className="backup-heading">
        <p>
          harbor0 keeps earlier versions of every file in these folders. A new version is saved
          about an hour after you stop editing a file, so you can always go back.
        </p>
        {desktop && roots.length > 0 && (
          <Button variant="outline" disabled={busy} onClick={addFolder}>
            <Plus />
            Add folder
          </Button>
        )}
      </div>
      {error && (
        <Alert
          tone="error"
          className="backup-error"
          action={
            <Button
              variant="link"
              onClick={() => {
                setError('');
                setRefresh((value) => value + 1);
              }}
            >
              Try again
            </Button>
          }
        >
          {error}
        </Alert>
      )}
      {message && (
        <Alert tone="success" className="backup-notice" onDismiss={() => setMessage('')}>
          {message}
        </Alert>
      )}
      {!roots.length ? (
        !rootsLoaded ? (
          <p role="status" className="backup-empty">
            Loading backup folders…
          </p>
        ) : (
          <EmptyState
            icon={<Archive />}
            title="Back up a folder"
            description={
              desktop
                ? 'Choose a folder on this computer. harbor0 will keep earlier versions of its files so you can restore or download any of them later.'
                : 'Backups are set up from the harbor0 desktop app. Open it on your computer, go to Backups and choose Add folder. Saved versions will then appear here.'
            }
            actions={
              desktop && (
                <Button disabled={busy} onClick={addFolder}>
                  <Plus />
                  Add folder
                </Button>
              )
            }
          />
        )
      ) : (
        <>
          {roots.length > 1 && (
            <div className="backup-folder-list" role="group" aria-label="Backup folders">
              {roots.map((r) => {
                const [tone, text] = rootTone(r);
                return (
                  <button
                    key={r.id}
                    className="backup-folder-card"
                    aria-pressed={r.id === rootId}
                    onClick={() => changeRoot(r.id)}
                  >
                    <Folder size={16} aria-hidden="true" />
                    <span>
                      <strong>{r.localPathDisplayName}</strong>
                      <small>{device(r)}</small>
                    </span>
                    <StatusBadge tone={tone}>{text}</StatusBadge>
                  </button>
                );
              })}
            </div>
          )}
          {root && (
            <Card className="backup-summary" aria-label={`${root.localPathDisplayName} backup`}>
              <div className="backup-summary-main">
                <span className="icon-tile" aria-hidden="true">
                  <Folder />
                </span>
                <div>
                  <div className="backup-summary-title">
                    <h2>{root.localPathDisplayName}</h2>
                    <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
                  </div>
                  <p>
                    {local?.localPathDisplay ?? device(root)}
                    {' · '}
                    {status.detail}
                  </p>
                </div>
              </div>
              {local && desktop && !removed ? (
                <div className="backup-actions backup-summary-actions">
                  <Button
                    size="sm"
                    disabled={busy || local.paused || status.tone === 'busy'}
                    onClick={() =>
                      void act(
                        () => desktop.backup(local.id),
                        'Backup started. Recent edits will be saved in a moment.',
                      )
                    }
                  >
                    <Archive />
                    Back up now
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void act(
                        async () => {
                          await desktop.setPaused(local, !local.paused);
                          await desktop.refresh();
                        },
                        local.paused ? 'Backups resumed.' : 'Backups paused.',
                      )
                    }
                  >
                    {local.paused ? <Play /> : <Pause />}
                    {local.paused ? 'Resume' : 'Pause'}
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    disabled={busy}
                    aria-label="Backup settings"
                    title="Backup settings"
                    onClick={() => desktop.options(local)}
                  >
                    <Settings2 />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="backup-stop"
                    disabled={busy}
                    onClick={() => setStopping(true)}
                  >
                    Stop backing up
                  </Button>
                </div>
              ) : (
                <div className="backup-actions backup-summary-actions">
                  {removed ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => setRemoving(true)}
                    >
                      <Trash2 />
                      Remove from Backups
                    </Button>
                  ) : (
                    <>
                      <small className="backup-hint">
                        To back up now or pause, open the desktop app on {deviceName}.
                      </small>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="backup-stop"
                        disabled={busy}
                        onClick={() => setStopping(true)}
                      >
                        Stop backing up
                      </Button>
                    </>
                  )}
                </div>
              )}
            </Card>
          )}
          <Tabs value={tab} onValueChange={setTab}>
            <TabList className="backup-tabs" aria-label="Backup views">
              {tabs.map((name) => (
                <Tab key={name} value={name} id={`backup-tab-${name}`}>
                  {name === 'Files' ? 'Files & versions' : 'History'}
                  {name === 'History' && pendingRestores > 0 && (
                    <Badge tone="accent" className="backup-tab-count">
                      {pendingRestores} waiting
                    </Badge>
                  )}
                </Tab>
              ))}
            </TabList>
            <TabPanel value={tab} id="backup-content">
              {tab === 'Files' && (
                <>
                  {trail.length > 0 && (
                    <nav className="breadcrumbs backup-breadcrumbs" aria-label="Archive folders">
                      <button onClick={() => openFolder([])}>{root?.localPathDisplayName}</button>
                      {trail.map((folder, index) => (
                        <span key={folder.id}>
                          <ChevronRight size={14} aria-hidden="true" />
                          <button onClick={() => openFolder(trail.slice(0, index + 1))}>
                            {folder.name}
                          </button>
                        </span>
                      ))}
                    </nav>
                  )}
                  <div className="backup-browser">
                    <div className="backup-files" aria-label="Backed-up files">
                      {shownItems.length > 0 ? (
                        <FileCollection
                          label="Backed-up files"
                          items={shownItems}
                          selected={selected ? [selected.id] : []}
                          onOpen={(item) =>
                            item.type === 'FOLDER'
                              ? openFolder([...trail, { id: item.id, name: item.name }])
                              : setSelected(item)
                          }
                          renderActions={() => null}
                        />
                      ) : folderLoading ? (
                        <FileCollectionSkeleton />
                      ) : (
                        <p className="backup-empty">
                          {trail.length
                            ? 'This folder has no backed-up files.'
                            : 'Nothing backed up yet. Files appear here after their first backup.'}
                        </p>
                      )}
                    </div>
                  </div>
                </>
              )}
              {tab === 'History' && (
                <>
                  {shownRestores.length > 0 && (
                    <>
                      <h3 className="backup-section-title">Restores</h3>
                      {shownRestores.map((value) => (
                        <div className="list-row backup-recovery-row" key={value.id}>
                          <RotateCcw aria-hidden="true" />
                          <div className="list-row-text">
                            <strong>{value.relativePath}</strong>
                            <small>
                              Requested {date(value.requestedAt)}
                              {value.completedAt && ` · Finished ${date(value.completedAt)}`}
                            </small>
                            {value.state === 'PENDING' && (
                              <p>
                                {!local
                                  ? `Will be restored the next time ${deviceName} is online.`
                                  : local.paused
                                    ? 'Resume backups to finish this restore.'
                                    : 'Will be restored in a moment.'}
                              </p>
                            )}
                            {value.error && (
                              <p role="alert" className="backup-row-error">
                                {value.error}
                              </p>
                            )}
                          </div>
                          <StatusBadge
                            tone={
                              value.state === 'PENDING'
                                ? 'busy'
                                : value.state === 'FAILED'
                                  ? 'error'
                                  : 'ok'
                            }
                          >
                            {restoreStates[value.state]}
                          </StatusBadge>
                        </div>
                      ))}
                    </>
                  )}
                  <h3 className="backup-section-title">Backups</h3>
                  {!shownRuns.length && (
                    <p className="backup-empty">
                      {historyLoading ? 'Loading history…' : 'No backups have run yet.'}
                    </p>
                  )}
                  {shownRuns.map((value) => (
                    <div className="backup-run" key={value.id}>
                      <button
                        aria-expanded={run?.id === value.id}
                        onClick={() => setRun(run?.id === value.id ? null : value)}
                      >
                        <Archive size={18} aria-hidden="true" />
                        <span className="list-row-text">
                          <strong>{date(value.startedAt)}</strong>
                          <small>
                            {value.trigger === 'MANUAL' ? 'Backed up manually' : 'Automatic backup'}{' '}
                            · {count(value.fileCount, 'file')} saved · {fileSize(value.sizeBytes)}
                          </small>
                        </span>
                        <StatusBadge
                          tone={
                            value.state === 'RUNNING'
                              ? 'busy'
                              : value.state === 'COMPLETED'
                                ? 'ok'
                                : 'error'
                          }
                        >
                          {runStates[value.state]}
                        </StatusBadge>
                        <ChevronRight size={16} aria-hidden="true" className="backup-run-chevron" />
                      </button>
                      {run?.id === value.id && (
                        <div className="backup-run-files">
                          {value.error && <Alert tone="error">{value.error}</Alert>}
                          {entriesFor !== value.id ? (
                            <p role="status">Loading files…</p>
                          ) : !entries.length ? (
                            <p>No files were saved in this backup.</p>
                          ) : (
                            entries.map((entry) => (
                              <div className="list-row" key={`${entry.itemId}-${entry.versionId}`}>
                                <span className="list-row-text">
                                  <strong>{entry.relativePath}</strong>
                                  <small>
                                    {fileSize(entry.sizeBytes)} · Edited {date(entry.modifiedAt)}
                                  </small>
                                </span>
                                {versionActions(
                                  entry.itemId,
                                  entry.versionId,
                                  entry.relativePath.split('/').at(-1)!,
                                  entry.savedAt,
                                )}
                              </div>
                            ))
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </>
              )}
            </TabPanel>
          </Tabs>
        </>
      )}
      <Drawer
        open={!!selected && tab === 'Files'}
        modal={false}
        className="backup-file-tray"
        title={selected?.name ?? ''}
        description="File details and saved versions."
        closeLabel="Close file details"
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      >
        {selected && (
          <>
            <dl className="details">
              {[
                ['Type', fileKind(selected)],
                ['Size', fileSize(selected.sizeBytes)],
                ['Modified', fileDate(selected.updatedAt).full],
                [
                  'Location',
                  [root?.localPathDisplayName, ...trail.map((folder) => folder.name)]
                    .filter(Boolean)
                    .join(' / '),
                ],
                ['Backed up from', device(root)],
              ].map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
            <section className="backup-versions" aria-label="File versions">
              <h3>Saved versions</h3>
              <p>
                {versionsFor === selected.id
                  ? `${count(versions.length, 'saved version')}, newest first. `
                  : ''}
                {!removed && `Restore puts a version back on ${deviceName}. `}
                Download saves a separate copy.
              </p>
              {versionsFor !== selected.id ? (
                <p role="status">Loading versions…</p>
              ) : !versions.length ? (
                <p>No saved versions.</p>
              ) : (
                versions.map((version, index) => (
                  <div className="backup-version" key={version.id}>
                    <div>
                      <strong>{date(version.createdAt)}</strong>
                      {index === 0 && <Badge className="backup-latest">Latest</Badge>}
                    </div>
                    <small>
                      Version {version.versionNumber} · {fileSize(version.sizeBytes)}
                    </small>
                    {versionActions(selected.id, version.id, selected.name, version.createdAt)}
                  </div>
                ))
              )}
            </section>
          </>
        )}
      </Drawer>
      <Dialog
        open={stopping}
        onOpenChange={(open) => {
          if (!busy) setStopping(open);
        }}
        title={`Stop backing up ${root?.localPathDisplayName ?? 'this folder'}?`}
        description="No new versions will be saved. Everything already backed up moves to My Drive → Cloud as regular files. Nothing on your computer is deleted."
      >
        {error && <Alert tone="error">{error}</Alert>}
        <DialogActions>
          <Button variant="outline" disabled={busy} onClick={() => setStopping(false)}>
            Keep backing up
          </Button>
          <Button
            variant="danger"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                if (!root) return;
                if (local && desktop) {
                  await desktop.disconnect(local.id);
                  await desktop.refresh();
                } else await api.request(`/v1/backups/${root.id}`, { method: 'DELETE' });
                setStopping(false);
              }, `Stopped backing up ${root?.localPathDisplayName}. Its files are in My Drive → Cloud.`)
            }
          >
            Stop backing up
          </Button>
        </DialogActions>
      </Dialog>
      <Dialog
        open={removing}
        onOpenChange={(open) => {
          if (!busy) setRemoving(open);
        }}
        title={`Remove ${root?.localPathDisplayName ?? 'this folder'} from Backups?`}
        description="This removes the folder and its backup history from this list. Its files stay in My Drive → Cloud, and nothing on your computer is deleted."
      >
        {error && <Alert tone="error">{error}</Alert>}
        <DialogActions>
          <Button variant="outline" disabled={busy} onClick={() => setRemoving(false)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={busy}
            onClick={() => {
              const name = root?.localPathDisplayName;
              void act(async () => {
                if (!root) return;
                await api.request(`/v1/backups/${root.id}/forget`, { method: 'POST' });
                setRemoving(false);
                setSelected(null);
                setTrail([]);
                setRun(null);
              }, `Removed ${name} from Backups.`);
            }}
          >
            {busy ? 'Removing…' : 'Remove'}
          </Button>
        </DialogActions>
      </Dialog>
      <Dialog
        open={!!restore}
        onOpenChange={(open) => {
          if (!open && !busy) setRestore(null);
        }}
        title={`Restore ${restore?.name ?? 'this file'}?`}
        description={`The copy of ${restore?.name ?? 'this file'} on ${deviceName} will be replaced with the version from ${restore ? date(restore.createdAt) : ''}.`}
      >
        <p className="muted">
          {local
            ? 'Any changes made to the file since then will be replaced. '
            : `If ${deviceName} is offline, the restore happens the next time it’s online. `}
          To keep both, download this version instead.
        </p>
        {error && <Alert tone="error">{error}</Alert>}
        <DialogActions>
          <Button variant="outline" disabled={busy} onClick={() => setRestore(null)}>
            Cancel
          </Button>
          <Button
            disabled={busy}
            onClick={() =>
              void act(async () => {
                if (!root || !restore) return;
                await api.request(`/v1/backups/${root.id}/restores`, {
                  method: 'POST',
                  body: {
                    id: restore.requestId,
                    itemId: restore.itemId,
                    versionId: restore.versionId,
                  },
                });
                setRestore(null);
              }, `Restoring ${restore?.name}. Follow its progress in History.`)
            }
          >
            <RotateCcw />
            Restore
          </Button>
        </DialogActions>
      </Dialog>
    </div>
  );
}
