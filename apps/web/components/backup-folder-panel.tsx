'use client';
import { useEffect, useState, type ReactNode } from 'react';
import {
  AlertCircle,
  Archive,
  ArchiveRestore,
  CheckCircle2,
  ChevronRight,
  Download,
  History,
  Loader2,
  Pause,
  Play,
  RotateCcw,
  Trash2,
  Settings2,
  X,
} from 'lucide-react';
import type { ApiClient } from '@harbor/api-client';
import type {
  BackupRoot,
  BackupRun,
  BackupEntry,
  BackupRestore,
} from '../../../packages/contracts/src/backups';
import { fileSize } from '../lib/file-metadata';
import { Button } from './ui/button';
import { Dialog, DialogActions, Drawer } from './ui/dialog';
import { Alert } from './ui/alert';
import { Badge, type BadgeTone } from './ui/badge';
import { FolderProgress } from './folder-progress';
import { Card } from './ui/card';
import { ActionsMenu, MenuItem, MenuSeparator } from './ui/menu';
import { drivePlaces } from './device-folders';

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
type Tone = 'ok' | 'busy' | 'paused' | 'error' | 'stopped' | 'archived';
export type LocalBackupRoot = {
  id: string;
  remoteId: string | null;
  paused: boolean;
  excluded?: string[];
  archive?: 'pending' | 'removing' | 'archived' | 'restoring';
  archiveError?: string;
  localPathDisplay?: string;
  localPathDisplayName?: string;
  // Percent complete of the backup run under way on this device.
  progress?: number;
};
/** What the desktop app can do with a folder it backs up itself. */
export type BackupDesktop = {
  roots: LocalBackupRoot[];
  backup: (id: string) => Promise<{ changes: number }>;
  disconnect: (id: string) => Promise<unknown>;
  archive: (id: string, archived: boolean) => Promise<unknown>;
  setPaused: (root: LocalBackupRoot, paused: boolean) => Promise<unknown>;
  download: (input: { itemId: string; versionId: string; name: string }) => Promise<unknown>;
  options: (root: LocalBackupRoot) => void;
  refresh: () => Promise<unknown>;
};
type Props = {
  api: ApiClient;
  /** The open folder. The panel shows only when it is the top folder of a backup. */
  folderId: string;
  desktop?: BackupDesktop;
  /** After the backup is stopped, archived or removed, so the place lists catch up. */
  onChanged?: () => void;
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
            : tone === 'archived'
              ? Archive
              : X;
  const tones: Record<Tone, BadgeTone> = {
    ok: 'success',
    busy: 'accent',
    paused: 'neutral',
    error: 'danger',
    stopped: 'neutral',
    archived: 'neutral',
  };
  return (
    <Badge className="backup-badge" tone={tones[tone]} data-state={tone}>
      <Icon aria-hidden="true" className={tone === 'busy' ? 'spin' : undefined} />
      {children}
    </Badge>
  );
}
/**
 * The status and controls of a backed-up or archived folder, shown above its files in My Drive:
 * back up now, pause, archive or stop, plus the history of backup runs and restores.
 */
export function BackupFolderPanel({ api, folderId, desktop, onChanged }: Props) {
  const [root, setRoot] = useState<BackupRoot | null>(null);
  const [stopping, setStopping] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
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
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const local = desktop?.roots.find((r) => r.remoteId === folderId);
  const removed = root?.state === 'REMOVED';
  // The source computer knows about an archive in progress before the cloud copy is sealed.
  const archived = root?.state === 'ARCHIVED' || (!!local?.archive && local.archive !== 'pending');
  const deviceName = local ? 'this computer' : (root?.deviceName ?? 'the source computer');
  const name = root?.localPathDisplayName ?? 'this folder';
  useEffect(() => {
    let active = true;
    api
      .request('/v1/backups')
      .then((result) => {
        if (!active) return;
        setRoot(
          (result.items as BackupRoot[]).find((r) => r.remoteRootDriveItemId === folderId) ?? null,
        );
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [api, folderId, refresh]);
  useEffect(() => {
    const timer = setInterval(() => setRefresh((value) => value + 1), 15000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(''), 8000);
    return () => clearTimeout(timer);
  }, [message]);
  const rootId = root?.id;
  useEffect(() => {
    let active = true;
    if (!rootId) return;
    const base = `/v1/backups/${rootId}`;
    Promise.all([
      collection<BackupRun>(api, `${base}/runs`),
      collection<BackupRestore>(api, `${base}/restores`),
    ])
      .then(([history, recovery]) => {
        if (!active) return;
        setRuns(history.sort((a, b) => b.startedAt.localeCompare(a.startedAt)));
        setRestores(recovery.sort((a, b) => b.requestedAt.localeCompare(a.requestedAt)));
        setHistoryFor(rootId);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [api, rootId, refresh]);
  const runId = run?.id;
  useEffect(() => {
    let active = true;
    if (!runId || !rootId) return;
    collection<BackupEntry>(api, `/v1/backups/${rootId}/runs/${runId}/files`)
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
  }, [api, runId, rootId, refresh]);
  if (!root) return null;
  // Only show loading placeholders when the folder changes, never on background refreshes.
  const historyLoading = historyFor !== root.id;
  const shownRuns = historyLoading ? [] : runs;
  const shownRestores = historyLoading ? [] : restores;
  const pendingRestores = shownRestores.filter((r) => r.state === 'PENDING').length;
  async function act(
    action: () => Promise<unknown>,
    success: string | (() => string),
    changed = false,
  ) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await action();
      setMessage(typeof success === 'string' ? success : success());
      setRefresh((value) => value + 1);
      if (changed) onChanged?.();
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
        {/* Restoring writes to the source computer, so only the desktop app offers it. */}
        {desktop && !removed && !archived && (
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
  const status: { tone: Tone; label: string; detail: string } = removed
    ? {
        tone: 'stopped',
        label: 'Stopped',
        detail: `No new versions are saved. The backed-up files are now regular files in My Drive.`,
      }
    : local?.archive === 'restoring'
      ? {
          tone: 'busy',
          label: 'Restoring',
          detail: 'Putting the folder back on this computer. Backups resume when it’s done.',
        }
      : local?.archive === 'removing'
        ? {
            tone: 'busy',
            label: 'Archiving',
            detail: 'Everything is saved. Removing the copy on this computer…',
          }
        : archived
          ? {
              tone: 'archived',
              label: 'Archived',
              detail: `Backups from ${deviceName} are stopped. Every backed-up file and version is kept here, read-only.`,
            }
          : local?.archive === 'pending'
            ? {
                tone: 'busy',
                label: 'Archiving',
                detail:
                  'Saving a final backup. The copy on this computer is removed once every file is saved.',
              }
            : local?.paused || root.state === 'PAUSED'
              ? {
                  tone: 'paused',
                  label: 'Paused',
                  detail:
                    'No new versions are saved until you resume. Saved versions are still here.',
                }
              : local?.progress !== undefined
                ? {
                    tone: 'busy',
                    label: 'Backing up',
                    detail: `Saving changed files · ${local.progress}% complete`,
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
                          label:
                            latestRun?.state === 'PARTIAL' ? 'Some files skipped' : 'Backed up',
                          detail: `Last backed up ${ago(lastGoodRun.completedAt ?? lastGoodRun.startedAt)}.`,
                        }
                      : {
                          tone: 'ok',
                          label: 'Waiting',
                          detail: historyLoading
                            ? 'Checking backup status…'
                            : 'The first backup runs once files have been unchanged for an hour.',
                        };
  const historyButton = (
    <Button size="sm" variant="ghost" onClick={() => setHistoryOpen(true)}>
      <History />
      History
      {pendingRestores > 0 && (
        <Badge tone="accent" className="backup-tab-count">
          {pendingRestores} waiting
        </Badge>
      )}
    </Button>
  );
  const Icon = archived ? drivePlaces.archives.icon : drivePlaces.backups.icon;
  return (
    <div className="folder-panel">
      <Card className="backup-summary" aria-label={`${name} backup`}>
        <div className="backup-summary-main">
          <span className="icon-tile" aria-hidden="true">
            <Icon />
          </span>
          <div>
            <div className="backup-summary-title">
              <h2>{archived ? 'Archived backup' : 'Backup'}</h2>
              <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
            </div>
            <p>
              {local?.localPathDisplay ?? (local ? 'This computer' : root.deviceName)}
              {' · '}
              {status.detail}
            </p>
            {local?.progress !== undefined && !local.paused && !removed && (
              <FolderProgress percent={local.progress} label={`${name} backup progress`} />
            )}
          </div>
        </div>
        {local && desktop && !removed && (archived || local.archive) ? (
          <div className="backup-actions backup-summary-actions">
            {local.archive === 'archived' && (
              <Button
                size="sm"
                disabled={busy || local.paused}
                onClick={() =>
                  void act(
                    async () => {
                      await desktop.archive(local.id, false);
                      await desktop.refresh();
                    },
                    `Restoring ${name} to this computer. Backups resume when it’s done.`,
                    true,
                  )
                }
              >
                <ArchiveRestore />
                Restore folder
              </Button>
            )}
            {historyButton}
            {archived && (
              <ActionsMenu label={`More actions for ${name}`} disabled={busy}>
                <MenuItem
                  tone="danger"
                  disabled={local.archive !== 'archived'}
                  onClick={() => setStopping(true)}
                >
                  Stop backing up…
                </MenuItem>
              </ActionsMenu>
            )}
          </div>
        ) : local && desktop && !removed ? (
          <div className="backup-actions backup-summary-actions">
            <Button
              size="sm"
              disabled={busy || local.paused || status.tone === 'busy'}
              onClick={() => {
                let changes = 0;
                void act(
                  async () => {
                    ({ changes } = await desktop.backup(local.id));
                  },
                  () =>
                    changes
                      ? `Backing up ${count(changes, 'changed file')}.`
                      : 'Nothing has changed since the last backup.',
                );
              }}
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
            {historyButton}
            <ActionsMenu label={`More actions for ${name}`} disabled={busy}>
              <MenuItem onClick={() => desktop.options(local)}>
                <Settings2 aria-hidden="true" /> Backup settings
              </MenuItem>
              <MenuItem disabled={local.paused} onClick={() => setArchiving(true)}>
                <Archive aria-hidden="true" /> Archive…
              </MenuItem>
              <MenuSeparator />
              <MenuItem tone="danger" onClick={() => setStopping(true)}>
                Stop backing up…
              </MenuItem>
            </ActionsMenu>
          </div>
        ) : (
          <div className="backup-actions backup-summary-actions">
            {removed ? (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => setRemoving(true)}>
                <Trash2 />
                Remove from Backups
              </Button>
            ) : (
              <small className="backup-hint">
                {archived
                  ? `To restore this folder, open the desktop app on ${deviceName}.`
                  : `To back up now, pause or archive, open the desktop app on ${deviceName}.`}
              </small>
            )}
            {historyButton}
            {!removed && (
              <ActionsMenu label={`More actions for ${name}`} disabled={busy}>
                <MenuItem tone="danger" onClick={() => setStopping(true)}>
                  Stop backing up…
                </MenuItem>
              </ActionsMenu>
            )}
          </div>
        )}
      </Card>
      {local?.archiveError && (!local.archive || local.archive === 'archived') && (
        <Alert tone="error" className="backup-error">
          {name}{' '}
          {local.archive
            ? 'was not restored and is still archived.'
            : 'was not archived and is still backed up.'}{' '}
          {local.archiveError}
        </Alert>
      )}
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
      <Drawer
        open={historyOpen}
        className="backup-history"
        title={`${name} history`}
        description="Every backup run and file restore for this folder."
        closeLabel="Close history"
        onOpenChange={setHistoryOpen}
      >
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
                    value.state === 'PENDING' ? 'busy' : value.state === 'FAILED' ? 'error' : 'ok'
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
                  {value.trigger === 'MANUAL' ? 'Backed up manually' : 'Automatic backup'} ·{' '}
                  {count(value.fileCount, 'file')} saved · {fileSize(value.sizeBytes)}
                </small>
              </span>
              <StatusBadge
                tone={
                  value.state === 'RUNNING' ? 'busy' : value.state === 'COMPLETED' ? 'ok' : 'error'
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
      </Drawer>
      <Dialog
        open={stopping}
        onOpenChange={(open) => {
          if (!busy) setStopping(open);
        }}
        title={`Stop backing up ${name}?`}
        description="No new versions will be saved. Everything already backed up stays in My Drive as regular files. Nothing on your computer is deleted."
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
              void act(
                async () => {
                  if (local && desktop) {
                    await desktop.disconnect(local.id);
                    await desktop.refresh();
                  } else await api.request(`/v1/backups/${root.id}`, { method: 'DELETE' });
                  setStopping(false);
                },
                `Stopped backing up ${name}. Its files stay in My Drive.`,
                true,
              )
            }
          >
            Stop backing up
          </Button>
        </DialogActions>
      </Dialog>
      <Dialog
        open={archiving}
        onOpenChange={(open) => {
          if (!busy) setArchiving(open);
        }}
        title={`Archive ${name}?`}
        description={`harbor0 saves one last backup, then stops backing up and removes the folder’s backed-up files from this computer. The cloud copy and every saved version move to ${drivePlaces.archives.name}.`}
      >
        <p className="muted">
          Excluded files and anything that can’t be verified against its saved copy are left in
          place. Restore the folder at any time to bring it back and resume backups.
        </p>
        {error && <Alert tone="error">{error}</Alert>}
        <DialogActions>
          <Button variant="outline" disabled={busy} onClick={() => setArchiving(false)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={busy}
            onClick={() =>
              void act(
                async () => {
                  if (!local || !desktop) return;
                  await desktop.archive(local.id, true);
                  await desktop.refresh();
                  setArchiving(false);
                },
                `Archiving ${name}. Its local copy is removed once the final backup is saved.`,
                true,
              )
            }
          >
            <Archive />
            Archive and remove local copy
          </Button>
        </DialogActions>
      </Dialog>
      <Dialog
        open={removing}
        onOpenChange={(open) => {
          if (!busy) setRemoving(open);
        }}
        title={`Remove ${name} from Backups?`}
        description="This removes the folder’s backup history. Its files stay in My Drive, and nothing on your computer is deleted."
      >
        {error && <Alert tone="error">{error}</Alert>}
        <DialogActions>
          <Button variant="outline" disabled={busy} onClick={() => setRemoving(false)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={busy}
            onClick={() =>
              void act(
                async () => {
                  await api.request(`/v1/backups/${root.id}/forget`, { method: 'POST' });
                  setRemoving(false);
                  setRun(null);
                },
                `Removed ${name} from Backups.`,
                true,
              )
            }
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
                if (!restore) return;
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
