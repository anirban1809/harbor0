'use client';
import { useEffect, useState } from 'react';
import {
  Archive,
  Folder,
  File,
  History,
  RotateCcw,
  Download,
  Plus,
  ChevronRight,
  RefreshCw,
} from 'lucide-react';
import type { ApiClient } from '@harbor/api-client';
import type { DriveItem, FileVersion } from '@harbor/contracts';
import type {
  BackupRoot,
  BackupRun,
  BackupEntry,
  BackupRestore,
} from '../../../packages/contracts/src/backups';
import { Button } from './ui/button';
import { Dialog } from './ui/dialog';
import { EmptyState } from './empty-state';
const date = (value: string) => new Date(value).toLocaleString();
const size = (value: number) =>
  value < 1024
    ? `${value} B`
    : value < 1024 ** 2
      ? `${(value / 1024).toFixed(1)} KB`
      : `${(value / 1024 ** 2).toFixed(1)} MB`;
const label = (value: string) => value.charAt(0) + value.slice(1).toLowerCase();
type LocalRoot = {
  id: string;
  remoteId: string | null;
  paused: boolean;
  localPathDisplay?: string;
  localPathDisplayName?: string;
};
type Props = {
  api: ApiClient;
  desktop?: {
    roots: LocalRoot[];
    add: () => Promise<unknown>;
    backup: (id: string) => Promise<unknown>;
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
export function BackupsPage({ api, desktop }: Props) {
  const [tab, setTab] = useState('Archives');
  const [roots, setRoots] = useState<BackupRoot[]>([]);
  const [rootId, setRootId] = useState('');
  const root = roots.find((r) => r.id === rootId);
  const [trail, setTrail] = useState<{ id: string; name: string }[]>([]);
  const [items, setItems] = useState<DriveItem[]>([]);
  const [selected, setSelected] = useState<DriveItem | null>(null);
  const [versions, setVersions] = useState<FileVersion[]>([]);
  const [runs, setRuns] = useState<BackupRun[]>([]);
  const [restores, setRestores] = useState<BackupRestore[]>([]);
  const [run, setRun] = useState<BackupRun | null>(null);
  const [entries, setEntries] = useState<BackupEntry[]>([]);
  const [restore, setRestore] = useState<{
    itemId: string;
    versionId: string;
    name: string;
    createdAt: string;
    requestId: string;
  } | null>(null);
  const [exports, setExports] = useState<{ name: string; at: string }[]>([]);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [versionLoading, setVersionLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const local = desktop?.roots.find((r) => r.remoteId === root?.remoteRootDriveItemId);
  useEffect(() => {
    let active = true;
    api
      .request('/v1/backups')
      .then((result) => {
        if (!active) return;
        setRoots(result.items);
        setRootId((current) =>
          result.items.some((r: BackupRoot) => r.id === current)
            ? current
            : (result.items[0]?.id ?? ''),
        );
        setLoading(false);
      })
      .catch((e) => {
        if (active) {
          setError(e.message);
          setLoading(false);
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
  const folderId = trail.at(-1)?.id ?? root?.remoteRootDriveItemId;
  useEffect(() => {
    let active = true;
    if (!root || !folderId) return;
    setLoading(true);
    const base = `/v1/backups/${root.id}`;
    Promise.all([
      collection<DriveItem>(api, `/v1/drive/folders/${encodeURIComponent(folderId)}/children`),
      collection<BackupRun>(api, `${base}/runs`),
      collection<BackupRestore>(api, `${base}/restores`),
    ])
      .then(([files, history, recovery]) => {
        if (!active) return;
        setItems(
          files.sort((a, b) =>
            a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'FOLDER' ? -1 : 1,
          ),
        );
        setRuns(history.sort((a, b) => b.startedAt.localeCompare(a.startedAt)));
        setRestores(recovery.sort((a, b) => b.requestedAt.localeCompare(a.requestedAt)));
        setLoading(false);
      })
      .catch((e) => {
        if (active) {
          setError(e.message);
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [api, root, folderId, refresh]);
  useEffect(() => {
    let active = true;
    setVersions([]);
    if (!selected) return;
    setVersionLoading(true);
    api
      .request(`/v1/drive/items/${selected.id}/versions`)
      .then((result) => {
        if (active) {
          setVersions(result.items);
          setVersionLoading(false);
        }
      })
      .catch((e) => {
        if (active) {
          setError(e.message);
          setVersionLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [api, selected, refresh]);
  useEffect(() => {
    let active = true;
    setEntries([]);
    if (!run || !root) return;
    collection<BackupEntry>(api, `/v1/backups/${root.id}/runs/${run.id}/files`)
      .then((result) => {
        if (active) setEntries(result);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [api, run, root, refresh]);
  function changeRoot(id: string) {
    setRootId(id);
    setTrail([]);
    setItems([]);
    setRuns([]);
    setRestores([]);
    setSelected(null);
    setRun(null);
    setError('');
  }
  async function act(action: () => Promise<unknown>, success: string) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await action();
      setMessage(success);
      setRefresh((value) => value + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const exportVersion = (itemId: string, versionId: string, name: string) =>
    act(async () => {
      const signed = await api.download({ driveItemId: itemId, versionId });
      const anchor = document.createElement('a');
      anchor.href = signed.downloadUrl;
      anchor.download = name;
      anchor.rel = 'noopener';
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setExports((current) => [{ name, at: new Date().toISOString() }, ...current]);
    }, 'Export download started.');
  function actions(itemId: string, versionId: string, name: string, createdAt: string) {
    return (
      <div className="backup-actions">
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() =>
            setRestore({ itemId, versionId, name, createdAt, requestId: crypto.randomUUID() })
          }
        >
          <RotateCcw size={14} />
          Restore
        </Button>
        {!desktop && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void exportVersion(itemId, versionId, name)}
          >
            <Download size={14} />
            Export
          </Button>
        )}
      </div>
    );
  }
  return (
    <div className="backup-page">
      <div className="backup-heading">
        <div>
          <h2>Folder backups</h2>
          <p>Keep a version history of the folders that matter.</p>
        </div>
        <div className="backup-actions">
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => {
              setError('');
              setRefresh((value) => value + 1);
            }}
          >
            <RefreshCw size={15} />
            Refresh
          </Button>
          {desktop && (
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  await desktop.add();
                  await desktop.refresh();
                }, 'Backup folders updated.')
              }
            >
              <Plus size={16} />
              Add folder
            </Button>
          )}
        </div>
      </div>
      <div className="backup-tabs" role="tablist" aria-label="Backup views">
        {['Archives', 'Backups', 'Restore/Export'].map((name) => (
          <button
            key={name}
            id={`backup-tab-${name}`}
            role="tab"
            tabIndex={tab === name ? 0 : -1}
            onKeyDown={(event) => {
              const names = ['Archives', 'Backups', 'Restore/Export'];
              const offset = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
              if (!offset && event.key !== 'Home' && event.key !== 'End') return;
              event.preventDefault();
              const next =
                names[
                  event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? 2
                      : (names.indexOf(name) + offset + 3) % 3
                ];
              setTab(next);
              document.getElementById(`backup-tab-${next}`)?.focus();
            }}
            aria-selected={tab === name}
            aria-controls="backup-content"
            onClick={() => setTab(name)}
          >
            {name}
          </button>
        ))}
      </div>
      {error && (
        <p role="alert" className="backup-error">
          {error}{' '}
          <button
            onClick={() => {
              setError('');
              setRefresh((value) => value + 1);
            }}
          >
            Retry
          </button>
        </p>
      )}
      {message && (
        <p role="status" className="backup-notice">
          {message}
        </p>
      )}
      {roots.length > 0 && (
        <div className="backup-toolbar">
          <label>
            Backup folder{' '}
            <select
              aria-label="Backup folder"
              value={rootId}
              onChange={(event) => changeRoot(event.target.value)}
            >
              {roots.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.localPathDisplayName} ({r.deviceName ?? 'Source computer'})
                </option>
              ))}
            </select>
          </label>
          <span>
            {local
              ? local.paused
                ? 'Paused on this computer'
                : 'On this computer'
              : `Backed up from ${root?.deviceName ?? 'a connected computer'}`}
          </span>
        </div>
      )}
      <section id="backup-content" role="tabpanel" aria-labelledby={`backup-tab-${tab}`}>
        {!roots.length ? (
          loading ? (
            <p role="status">Loading backup folders…</p>
          ) : (
            <EmptyState
              icon={<Archive />}
              title="No backup folders yet"
              description={
                desktop
                  ? 'Add a folder to start keeping its file versions. Automatic backups wait until files have been unchanged for one hour.'
                  : 'Add a folder in the desktop app. Its archives, backup history, and downloads will appear here.'
              }
            />
          )
        ) : (
          <>
            {tab === 'Archives' && (
              <>
                <nav className="backup-breadcrumbs" aria-label="Archive folders">
                  <button
                    onClick={() => {
                      setTrail([]);
                      setSelected(null);
                    }}
                  >
                    {root?.localPathDisplayName}
                  </button>
                  {trail.map((folder, index) => (
                    <span key={folder.id}>
                      <ChevronRight size={14} />
                      <button
                        onClick={() => {
                          setTrail(trail.slice(0, index + 1));
                          setSelected(null);
                        }}
                      >
                        {folder.name}
                      </button>
                    </span>
                  ))}
                </nav>
                <div className="backup-browser">
                  <div className="backup-files" aria-label="Archived files">
                    <div className="backup-list-heading">
                      <span>Name</span>
                      <span>Size</span>
                    </div>
                    {items.map((item) => (
                      <button
                        key={item.id}
                        className={`backup-file ${selected?.id === item.id ? 'selected' : ''}`}
                        onClick={() =>
                          item.type === 'FOLDER'
                            ? (setTrail([...trail, { id: item.id, name: item.name }]),
                              setItems([]),
                              setSelected(null))
                            : setSelected(item)
                        }
                      >
                        {item.type === 'FOLDER' ? <Folder size={19} /> : <File size={18} />}
                        <span>{item.name}</span>
                        <small>
                          {item.type === 'FILE' ? size(item.sizeBytes) : <ChevronRight size={15} />}
                        </small>
                      </button>
                    ))}
                    {!items.length && (
                      <p className="backup-empty">
                        {loading
                          ? 'Loading archived files…'
                          : 'No archived files in this folder yet. New files appear after their first backup.'}
                      </p>
                    )}
                  </div>
                  <aside className="backup-versions" aria-label="File versions">
                    {selected ? (
                      <>
                        <h3>{selected.name}</h3>
                        <p>Saved versions</p>
                        {versionLoading ? (
                          <p role="status">Loading versions…</p>
                        ) : !versions.length ? (
                          <p>No saved versions.</p>
                        ) : (
                          versions.map((version, index) => (
                            <div className="backup-version" key={version.id}>
                              <div>
                                <strong>Version {version.versionNumber}</strong>
                                {index === 0 && <small>Latest</small>}
                              </div>
                              <p>{date(version.createdAt)}</p>
                              <p>{size(version.sizeBytes)}</p>
                              {actions(selected.id, version.id, selected.name, version.createdAt)}
                            </div>
                          ))
                        )}
                      </>
                    ) : (
                      <div className="backup-empty">
                        <History size={28} />
                        <h3>Select a file</h3>
                        <p>
                          Browse every saved version and restore the one you need.
                          {!desktop && ' Export a version to download a copy.'}
                        </p>
                      </div>
                    )}
                  </aside>
                </div>
              </>
            )}
            {tab === 'Backups' && (
              <>
                <div className="backup-folder-detail">
                  <Folder size={24} />
                  <div>
                    <h3>{root?.localPathDisplayName}</h3>
                    <p>{local?.localPathDisplay ?? `Added ${root && date(root.createdAt)}`}</p>
                    <p>
                      Automatic backups save changed files after one hour without edits. Back up now
                      includes recent edits. Deleted local files stay in Archives.
                    </p>
                  </div>
                  {local && desktop && (
                    <div className="backup-actions">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onClick={() => desktop.options(local)}
                      >
                        Folder options
                      </Button>
                      <Button
                        size="sm"
                        disabled={busy || local.paused}
                        onClick={() =>
                          void act(
                            () => desktop.backup(local.id),
                            'Backup queued. This run will appear here when it starts.',
                          )
                        }
                      >
                        <Archive size={15} />
                        Back up now
                      </Button>
                    </div>
                  )}
                </div>
                {!local && (
                  <p className="backup-notice">
                    Open the desktop app on the source computer to add folders or back up now.
                  </p>
                )}
                <h3 className="backup-section-title">Backup history</h3>
                <p className="backup-help">
                  Each run lists the files it covered. Unchanged content reuses its saved version.
                </p>
                {!runs.length && (
                  <p className="backup-empty">
                    {loading
                      ? 'Loading backup history…'
                      : 'No backup runs yet. Existing archives are still available in Archives.'}
                  </p>
                )}
                {runs.map((value) => (
                  <div className="backup-run" key={value.id}>
                    <button
                      aria-expanded={run?.id === value.id}
                      onClick={() => setRun(run?.id === value.id ? null : value)}
                    >
                      <Archive size={19} />
                      <span>
                        <strong>{date(value.startedAt)}</strong>
                        <small>
                          {label(value.trigger)} backup · {value.fileCount}{' '}
                          {value.fileCount === 1 ? 'file' : 'files'} · {size(value.sizeBytes)}
                        </small>
                      </span>
                      <span className="backup-state">{label(value.state)}</span>
                      <ChevronRight size={16} />
                    </button>
                    {run?.id === value.id && (
                      <div className="backup-run-files">
                        <p>
                          Started {date(value.startedAt)}
                          {value.completedAt
                            ? ` · Finished ${date(value.completedAt)}`
                            : ' · In progress'}
                        </p>
                        {value.error && <p role="alert">{value.error}</p>}
                        {!entries.length && <p>No files recorded in this run.</p>}
                        {entries.map((entry) => (
                          <div key={`${entry.itemId}-${entry.versionId}`}>
                            <span>
                              <strong>{entry.relativePath}</strong>
                              <small>
                                {size(entry.sizeBytes)} · Modified {date(entry.modifiedAt)}
                              </small>
                            </span>
                            {actions(
                              entry.itemId,
                              entry.versionId,
                              entry.relativePath.split('/').at(-1)!,
                              entry.savedAt,
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </>
            )}
            {tab === 'Restore/Export' && (
              <>
                <div className="backup-recovery">
                  <RotateCcw size={25} />
                  <div>
                    <h3>Bring back a saved version</h3>
                    <p>
                      Choose a file in Archives, then select a version. Restore replaces that file
                      in its original local folder when the source computer is online and backups
                      are running.
                      {!desktop
                        ? ' Export downloads a copy to this browser.'
                        : ' To export a copy, open Backups on the web.'}
                    </p>
                    <Button variant="outline" size="sm" onClick={() => setTab('Archives')}>
                      Browse archives
                    </Button>
                  </div>
                </div>
                <h3 className="backup-section-title">Restore requests</h3>
                {!restores.length && (
                  <p className="backup-empty">No restore requests for this folder.</p>
                )}
                {restores.map((value) => (
                  <div className="backup-recovery-row" key={value.id}>
                    <RotateCcw size={17} />
                    <div>
                      <strong>{value.relativePath}</strong>
                      <small>
                        {date(value.requestedAt)}
                        {value.completedAt && ` · Finished ${date(value.completedAt)}`}
                      </small>
                      {value.state === 'PENDING' && <p>Waiting for the source computer</p>}
                      {value.error && <p role="alert">{value.error}</p>}
                    </div>
                    <span>{label(value.state)}</span>
                  </div>
                ))}
                {!desktop && (
                  <>
                    <h3 className="backup-section-title">Exports started in this session</h3>
                    {!exports.length && (
                      <p className="backup-empty">
                        Export a file version from Archives to download a copy.
                      </p>
                    )}
                    {exports.map((value, index) => (
                      <div className="backup-recovery-row" key={index}>
                        <Download size={17} />
                        <div>
                          <strong>{value.name}</strong>
                          <small>{date(value.at)} · Check your browser downloads</small>
                        </div>
                      </div>
                    ))}
                  </>
                )}
              </>
            )}
          </>
        )}
      </section>
      <Dialog
        open={!!restore}
        onOpenChange={(open) => {
          if (!open && !busy) setRestore(null);
        }}
        title="Restore this version?"
        description={`Replace ${restore?.name ?? 'this file'} in its original local folder with the version saved ${restore ? date(restore.createdAt) : ''}. Any current local edits will be replaced.`}
      >
        <p>
          The source computer must be online with backups running. Until then, this request will
          wait.
        </p>
        <div className="backup-actions">
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
                setTab('Restore/Export');
              }, 'Restore requested. Track its status below.')
            }
          >
            Restore version
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
