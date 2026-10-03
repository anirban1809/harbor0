import { useOptimisticRemoval } from '../../web/lib/use-optimistic-removal';
import { browserSession, clearBrowserCaches } from '../../web/lib/browser-cache';
import { useActivityFeed } from '../../web/components/activity-notifications';
import { BrandLogo } from '../../web/components/brand-logo';
import { FilePreview } from '../../web/components/lazy-file-preview';
import {
  ZipDownloadStatusPanel,
  type ZipDownloadStatus,
} from '../../web/components/zip-download-status';
import { previewKind, type PreviewLoader } from '../../web/lib/file-preview';
import { UploadTray } from '../../web/components/upload-tray';
import { finishedKeys, mergeUploads, type FileUpload } from '../../web/lib/upload-activity';
import { Input, InputGroup, PasswordInput, Textarea } from '../../web/components/ui/input';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import {
  HardDrive,
  Inbox,
  Users,
  Send,
  Cloud,
  Laptop,
  Pause,
  Play,
  RefreshCw,
  Settings,
  Plus,
  ShieldCheck,
  Trash2,
  ChevronRight,
  Search,
  Check,
  ExternalLink,
} from 'lucide-react';
import {
  FileCollection,
  FileCollectionSkeleton,
  FileLoadError,
} from '../../web/components/file-collection';
import { ContentSkeleton, WorkspaceSkeleton } from '../../web/components/loading-states';
import { EmptyState, FileEmptyState, LoadError } from '../../web/components/empty-state';
import { AppearanceSettings } from '../../web/components/appearance-settings';
import { useAccountAppearance } from '../../web/lib/appearance';
import { ApiClient, type Transport } from '@harbor/api-client';
import { ThemeToggle } from '../../web/components/theme-toggle';
import type { Device, StorageUsage, SyncFolderItem } from '@harbor/contracts';
import { StoragePanel } from './overview';
import { BackupFolderPanel, type BackupDesktop } from '../../web/components/backup-folder-panel';
import {
  ConnectedDevices,
  RevokeDetails,
  DevicePlace,
  drivePlaceOrder,
  drivePlacePins,
  drivePlaces,
  placeFolderIds,
  placeGroups,
  placeSizes,
  type DrivePlace,
} from '../../web/components/device-folders';
import { loadUsage, type UsageMap } from '../../web/lib/folder-usage';
import { ownsBackup } from '../../web/lib/devices';
import type { BackupRoot } from '../../../packages/contracts/src/backups';
import { SharedTabs, type SharedTab } from '../../web/components/shared-tabs';
import { TransferTable } from '../../web/components/transfer-table';
import { DriveWorkspace } from '../../web/components/lazy-drive-workspace';
import { publishLive, setLiveConnected } from '../../web/lib/live-updates';
import {
  AccountMenu,
  FolderActivityStatus,
  StorageIndicator,
  type FolderActivity,
} from '../../web/components/drive-account';
import { AddSyncFolderDialog, OpenFolderProgress, SyncFolderPanel } from './sync-page';
import { folderState, syncRequirements, type SyncFolder } from './sync-state';
import { SyncNotifications } from './sync-notifications';
import { SharedSyncInvitations } from './sync-sharing';
import { IncomingDialog } from './incoming-dialog';
import type { IncomingContent } from './incoming';
import { mergeSyncItems } from './sync-drive';
import { Button } from '../../web/components/ui/button';
import { Dialog, DialogActions } from '../../web/components/ui/dialog';
import { Alert } from '../../web/components/ui/alert';
import { Badge } from '../../web/components/ui/badge';
import { Card } from '../../web/components/ui/card';
import { Checkbox } from '../../web/components/ui/checkbox';
import { Field } from '../../web/components/ui/field';
import { RecipientPicker, type RecipientKind } from '../../web/components/recipient-picker';
import { ActionsMenu, MenuItem, MenuSeparator } from '../../web/components/ui/menu';
import '../../web/app/globals.css';
import './desktop.css';
const bridge = window.harbor;
const request = (path: string, method = 'GET', body?: unknown) =>
  bridge.request({ path, method, body });
const appearanceRequest: Transport = (path, init) => request(path, init?.method, init?.body);
const backupApi = new ApiClient(appearanceRequest);
const loadPreview: PreviewLoader = async (item, signal) => {
  if (previewKind(item) === 'text') return bridge.previewText({ driveItemId: item.id });
  const result = await request('/v1/downloads', 'POST', { driveItemId: item.id });
  signal.throwIfAborted();
  return { url: result.downloadUrl };
};
const op = () => ({ operationId: crypto.randomUUID() });
type Confirmation = {
  title: string;
  description: string;
  /** More about what happens, shown below the description. */
  details?: ReactNode;
  label: string;
  done?: string;
  run: () => Promise<unknown>;
};
function App() {
  const [status, setStatus] = useState<any>();
  useEffect(() => {
    if (!status?.signedIn) clearBrowserCaches();
    setModal(null);
  }, [status?.signedIn, status?.accountId]);
  const activity = useActivityFeed(status?.signedIn ? status.accountId : undefined);
  useAccountAppearance(
    status?.signedIn ? (status.accountId ?? 'desktop-session') : undefined,
    appearanceRequest,
  );
  const [section, setSection] = useState('My Drive');
  const [addingSync, setAddingSync] = useState(false);
  const [sharedTab, setSharedTab] = useState<SharedTab>('Received');
  const [incoming, setIncoming] = useState<IncomingContent | null>(null);
  const [invitationRevision, setInvitationRevision] = useState(0);
  useEffect(
    () =>
      bridge.onIncoming((content) => {
        setModal(null);
        setIncoming(content);
        setSection('Shared');
        setSharedTab('Received');
        setCursor(undefined);
        setTrail([]);
        setQuery('');
        setInvitationRevision((value) => value + 1);
      }),
    [],
  );
  const [driveReadOnly, setDriveReadOnly] = useState(true);
  const [items, setItems] = useState<any[]>([]);
  const [trail, setTrail] = useState<any[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState('');
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 4500);
    return () => clearTimeout(timer);
  }, [toast]);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [zipProgress, setZipProgress] = useState<ZipDownloadStatus | null>(null);
  useEffect(() => bridge.onZipProgress(setZipProgress), []);
  const [uploads, setUploads] = useState<FileUpload[]>([]);
  useEffect(
    () =>
      bridge.onUploadProgress((updates) => {
        setUploads((old) => mergeUploads(old, updates));
        // Show each file in the drive as soon as it lands.
        if (updates.some((u) => u.phase === 'done')) setDriveRevision((value) => value + 1);
      }),
    [],
  );
  const [modal, setModal] = useState<{ mode: string; item: any } | null>(null);
  const [recipientKind, setRecipientKind] = useState<RecipientKind>('unknown');
  const [sync, setSync] = useState<any>();
  const [storage, setStorage] = useState<StorageUsage | null>(null);
  const [storageError, setStorageError] = useState(false);
  const [account, setAccount] = useState<any>();
  const [query, setQuery] = useState('');
  const [driveRevision, setDriveRevision] = useState(0);
  const trailId = trail.at(-1)?.id ?? null;
  const parentId = sync?.folderIds?.[trailId] ?? trailId;
  const localFolderPending = parentId?.startsWith('local-sync:') ?? false;
  const trashChanges = useOptimisticRemoval(
    items,
    status?.accountId ?? 'anonymous',
    setError,
    async () => {
      browserSession(appearanceRequest, status?.accountId ?? 'desktop-session').views.clear();
      await load();
    },
  );
  const visibleItems: any[] =
    section === 'My Drive'
      ? mergeSyncItems(items, sync?.driveItems ?? [], parentId)
      : trashChanges.items;
  const statusVersion = useRef(0);
  const latestActivity = useRef<string | undefined>(undefined);
  const [cursor, setCursor] = useState<string>();
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadedView, setLoadedView] = useState('');
  const [loadError, setLoadError] = useState('');
  const view = JSON.stringify([status?.accountId, section, parentId, cursor, sharedTab]);
  const activeView = useRef(view);
  activeView.current = view;
  const requestId = useRef(0);
  const loading = loadedView !== view;
  function goToFolder(nextTrail: any[]) {
    setCursor(undefined);
    setTrail(nextTrail);
    setQuery('');
  }
  // My Drive › a place (Synced Folders, Backups, Archives) › a device: the open folder's trail
  // starts below it.
  const [place, setPlace] = useState<{ place: DrivePlace; key?: string } | null>(null);
  const [placeData, setPlaceData] = useState<{
    devices?: Device[];
    folders?: SyncFolderItem[];
    backups?: BackupRoot[];
    usage?: UsageMap;
    error: boolean;
  }>({ error: false });
  const [placeRevision, setPlaceRevision] = useState(0);
  // My Drive's root shows each place's total too.
  const placesShown = section === 'My Drive' && (!!place || !trail.length);
  useEffect(() => {
    if (section !== 'My Drive') setPlace(null);
  }, [section]);
  useEffect(() => {
    if (!placesShown) return;
    let live = true;
    Promise.all([request('/v1/devices'), request('/v1/sync/folders'), request('/v1/backups')])
      .then(async ([devices, folders, backups]) => {
        if (!live) return;
        setPlaceData((previous) => ({
          ...previous,
          devices: devices.items,
          folders: folders.items,
          backups: backups.items,
          error: false,
        }));
        const ids = drivePlaceOrder.flatMap((target) =>
          placeFolderIds(target, folders.items, backups.items),
        );
        // Sizes fill in afterwards; the folders work without them.
        const usage = ids.length
          ? await loadUsage(appearanceRequest, ids).catch(() => undefined)
          : {};
        if (live && usage) setPlaceData((previous) => ({ ...previous, usage }));
      })
      .catch(() => {
        if (live) setPlaceData((previous) => ({ ...previous, error: true }));
      });
    return () => {
      live = false;
    };
  }, [placesShown, placeRevision]);
  function goToPlace(next: { place: DrivePlace; key?: string } | null) {
    setPlace(next);
    goToFolder([]);
  }
  /** My Drive › a place, from anywhere in the app. */
  function openPlace(target: DrivePlace, key?: string) {
    setSection('My Drive');
    goToPlace({ place: target, key });
  }
  const groups = place
    ? placeGroups(place.place, placeData.devices ?? [], placeData.folders, placeData.backups)
    : [];
  const placeCrumbs = place && (
    <>
      <ChevronRight size={14} />
      <button
        aria-current={!place.key ? 'location' : undefined}
        onClick={() => goToPlace({ place: place.place })}
      >
        {drivePlaces[place.place].name}
      </button>
      {place.key && (
        <>
          <ChevronRight size={14} />
          <button
            aria-current={!trail.length ? 'location' : undefined}
            onClick={() => goToPlace({ ...place })}
          >
            {groups.find((entry) => entry.key === place.key)?.name ?? 'Device'}
          </button>
        </>
      )}
    </>
  );

  async function openDriveItem(item: any) {
    if (item.type !== 'FOLDER') {
      if (item.cloudState && item.cloudState !== 'AVAILABLE') {
        await act(() => bridge.openSyncedItem({ itemId: item.id }));
        return;
      }
      if (!item.localOnly) setModal({ mode: 'preview', item });
      return;
    }
    if (item.localOnly || (!query && item.parentId === parentId)) {
      setSection('My Drive');
      goToFolder([...trail, item]);
      return;
    }
    try {
      const ancestors = [item];
      const visited = new Set([item.id]);
      let id = item.parentId;
      while (id) {
        if (visited.has(id) || visited.size >= 32)
          throw new Error('Could not load the folder path.');
        visited.add(id);
        const result = await request(`/v1/drive/items/${id}`);
        ancestors.unshift(result.item);
        id = result.item.parentId;
      }
      setSection('My Drive');
      goToFolder(ancestors);
    } catch (error) {
      setError((error as Error).message);
    }
  }

  async function load() {
    if (view !== activeView.current) return;
    const id = ++requestId.current;
    const current = () => id === requestId.current && view === activeView.current;
    let hadCachedPage = false;
    try {
      const version = statusVersion.current;
      const s = await bridge.status();
      if (!current()) return;
      setStatus(s);
      if (version === statusVersion.current) {
        setSync(s.sync);
        latestActivity.current = s.sync?.recent?.[0]?.id;
      }
      if (!s.signedIn) return;
      {
        // Storage failure should not block browsing files.
        void request('/v1/users/me')
          .then(({ storage: usage, user }) => {
            if (!current()) return;
            setAccount(user);
            if (!usage) {
              setStorageError(true);
              return;
            }
            setStorage(usage);
            setStorageError(false);
          })
          .catch(() => {
            if (current()) setStorageError(true);
          });
      }
      const endpoint =
        section === 'My Drive'
          ? null
          : section === 'Shared'
            ? `/v1/transfers/${sharedTab.toLowerCase()}`
            : section === 'Devices'
              ? '/v1/devices'
              : section === 'Trash'
                ? '/v1/search?trash=true'
                : null;
      if (endpoint) {
        const path =
          endpoint +
          (cursor
            ? `${endpoint.includes('?') ? '&' : '?'}cursor=${encodeURIComponent(cursor)}`
            : '');
        const pages = browserSession(appearanceRequest, s.accountId ?? 'desktop-session').views;
        const cached = pages.get(`shell:${path}`);
        if (cached && current()) {
          hadCachedPage = true;
          setItems(cached.items);
          setNextCursor(cached.nextCursor ?? null);
          setLoadedView(view);
        }
        const page = await request(path);
        pages.set(`shell:${path}`, page);
        if (!current()) return;
        setItems(page.items);
        setNextCursor(page.nextCursor ?? null);
      }
      if (current()) setLoadError('');
    } catch (error) {
      if (current()) {
        if (loadedView !== view && !hadCachedPage) {
          setItems([]);
          setNextCursor(null);
        }
        setLoadError((error as Error).message);
      }
      throw error;
    } finally {
      if (current()) setLoadedView(view);
    }
  }
  // Account creation and password reset live in the web app, opened in the default browser.
  async function openAccountPage(page: 'signup' | 'forgot') {
    setError('');
    try {
      await bridge.openAccountPage({ page });
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function act(fn: () => Promise<unknown>, message?: string) {
    setBusy(true);
    setError('');
    try {
      await fn();
      await load();
      if (message) setToast(message);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  // The save dialog can be cancelled, so only confirm downloads that were written.
  const download = (input: Parameters<typeof bridge.download>[0]) =>
    act(async () => {
      const result = await bridge.download(input);
      if (result?.saved) setToast(`Saved ${input.name}${input.folder ? '.zip' : ''}.`);
    });
  useEffect(() => {
    setError('');
    setLoadError('');
    // Refresh every 10s, or every minute while live updates push changes as they happen.
    let live = false;
    let loadedAt = Date.now();
    const refresh = () => {
      loadedAt = Date.now();
      void load().catch(() => {});
    };
    refresh();
    void bridge
      .status()
      .then((status: { live?: boolean }) => setLiveConnected((live = !!status.live)))
      .catch(() => {});
    const timer = setInterval(() => {
      if (!live || Date.now() - loadedAt >= 60_000) refresh();
    }, 10000);
    // The main process holds the socket; shared web views listen for the same hints.
    const offLive = bridge.onLive((event) => {
      live = event.connected;
      setLiveConnected(live);
      if (event.type) publishLive({ type: event.type });
      if (event.type === 'changes') refresh();
    });
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const off = bridge.onStatus((next) => {
      statusVersion.current++;
      setSync(next);
      const activity = next.recent?.[0];
      if (activity && activity.id !== latestActivity.current) {
        const previousActivity = next.recent.findIndex(
          (entry: any) => entry.id === latestActivity.current,
        );
        const newActivities =
          previousActivity < 0 ? next.recent : next.recent.slice(0, previousActivity);
        latestActivity.current = activity.id;
        if (section === 'My Drive') {
          // Keep completed uploads visible while the cloud listing refreshes.
          const completed = newActivities.flatMap((entry: any) =>
            entry.item?.parentId === parentId && !entry.item.deletedAt ? [entry.item] : [],
          );
          setItems((previous) => {
            const merged = new Map(previous.map((item) => [item.id, item]));
            for (const item of completed.reverse()) merged.set(item.id, item);
            return [...merged.values()];
          });
        }
        if (!refreshTimer)
          refreshTimer = setTimeout(() => {
            refreshTimer = undefined;
            void load().catch(() => {});
          }, 250);
      }
    });
    const auth = bridge.onAuthenticated(() => {
      setLoadedView('');
      void load().catch(() => {});
    });
    const signedOut = bridge.onSignedOut(() => {
      requestId.current++;
      setStatus((previous: any) => (previous ? { ...previous, signedIn: false } : previous));
      setItems([]);
      setAccount(undefined);
      setQuery('');
      setSync(undefined);
      setStorage(null);
      setStorageError(false);
      setModal(null);
      setConfirmation(null);
      setToast('');
      setIncoming(null);
      setTrail([]);
      setCursor(undefined);
      setNextCursor(null);
      setSection('My Drive');
      setLoadedView('');
      setError('');
      setLoadError('');
    });
    return () => {
      requestId.current++;
      clearInterval(timer);
      offLive();
      clearTimeout(refreshTimer);
      off();
      auth();
      signedOut();
    };
  }, [section, parentId, cursor, sharedTab, status?.accountId, status?.signedIn]);
  if (!status)
    return error || loadError ? (
      <main className="loading-screen">
        <Alert tone="error">{error || loadError}</Alert>
        <Button
          onClick={() => {
            setError('');
            void load().catch(() => {});
          }}
        >
          Try again
        </Button>
      </main>
    ) : (
      <WorkspaceSkeleton />
    );
  if (!status.signedIn)
    return (
      <main className="auth-page desktop-auth">
        <div className="auth-theme">
          <ThemeToggle />
        </div>
        <section className="auth-story">
          <div className="brand">
            <BrandLogo />
          </div>
          <div>
            <h1>File storage and sync</h1>
            <p>
              Back up, sync, and send files across devices.
              <br />
              100 GB of free storage.
            </p>
            <ul className="auth-features">
              <li>
                <span className="auth-feature-icon">
                  <RefreshCw aria-hidden="true" />
                </span>
                <span>Keep your files in sync across devices</span>
              </li>
              <li>
                <span className="auth-feature-icon">
                  <Cloud aria-hidden="true" />
                </span>
                <span>Back up local folders to the cloud</span>
              </li>
              <li>
                <span className="auth-feature-icon">
                  <ShieldCheck aria-hidden="true" />
                </span>
                <span>Files are private unless you share them</span>
              </li>
            </ul>
          </div>
          <span className="auth-foot">
            <ShieldCheck size={17} />
            Protected by your OS keychain
          </span>
        </section>
        <section className="auth-form">
          <div>
            <h2>Sign in to harbor0</h2>
            <p className="muted auth-intro">Sign in to access your files on this computer.</p>
            {!status.configured && (
              <Alert tone="error" role="none">
                {status.configurationError ?? 'harbor0’s server connection is not configured.'} Add
                the connection settings to apps/desktop/.env.local, then fully quit and restart
                harbor0.
              </Alert>
            )}
            {error && <Alert tone="error">{error}</Alert>}
            <form
              className="form"
              onSubmit={(e) => {
                e.preventDefault();
                if (busy || !status.configured) return;
                const form = e.currentTarget;
                const data = new FormData(form);
                const credentials = {
                  email: String(data.get('email') ?? '').trim(),
                  password: String(data.get('password') ?? ''),
                };
                void act(async () => {
                  await bridge.login(credentials);
                  form.reset();
                });
              }}
            >
              <Field label="Email">
                <Input
                  size="lg"
                  name="email"
                  defaultValue={status.development ? 'alice@example.test' : ''}
                  type="email"
                  autoComplete="username"
                  disabled={busy}
                  required
                />
              </Field>
              <Field label="Password">
                <PasswordInput
                  size="lg"
                  name="password"
                  aria-label="Password"
                  autoComplete="current-password"
                  maxLength={256}
                  disabled={busy}
                  required
                />
              </Field>
              {status.accountLinks && (
                <Button
                  variant="link"
                  className="auth-forgot"
                  onClick={() => void openAccountPage('forgot')}
                >
                  Forgot password?
                  <ExternalLink aria-hidden="true" />
                </Button>
              )}
              <Button type="submit" size="lg" block disabled={busy || !status.configured}>
                {busy
                  ? 'Signing in…'
                  : status.development
                    ? 'Sign in to local development'
                    : 'Sign in'}
              </Button>
            </form>
            {status.accountLinks ? (
              <div className="auth-switch">
                New to harbor0?{' '}
                <Button variant="link" onClick={() => void openAccountPage('signup')}>
                  Create an account
                  <ExternalLink aria-hidden="true" />
                </Button>
              </div>
            ) : (
              <p className="auth-session-note">
                New to harbor0 or forgot your password? Create an account or reset your password in
                the harbor0 web app, then sign in here.
              </p>
            )}
            <p className="auth-session-note">
              <ShieldCheck size={16} />
              <span>
                Stay signed in for up to 30 days. Your session is protected by this computer’s
                keychain.
              </span>
            </p>
          </div>
        </section>
      </main>
    );
  const nav = [
    ['My Drive', HardDrive],
    ['Shared', Users],
    ['Trash', Trash2],
    ['Devices', Laptop],
    ['Storage', Cloud],
    ['Settings', Settings],
  ] as const;
  const roots: SyncFolder[] = status.roots;
  const syncRoots = roots.filter((root) => root.mode === 'sync');
  const backupRoots = roots.filter((root) => root.mode === 'backup');
  const jobs = sync?.jobs ?? status.jobs ?? [];
  const backupDesktop: BackupDesktop = {
    roots: backupRoots.map((root) => ({ ...root, progress: sync?.progress?.[root.id] })),
    backup: (id) => bridge.backupNow({ id }),
    disconnect: (id) => bridge.disconnectBackup({ id }),
    archive: (id, archived) => bridge.archiveBackup({ id, archived }),
    setPaused: (root, paused) =>
      bridge.rootSettings({ id: root.id, paused, excluded: root.excluded ?? [] }),
    download: ({ itemId, versionId, name }) =>
      bridge.download({ driveItemId: itemId, versionId, name }),
    options: (root) => setModal({ mode: 'root', item: root }),
    refresh: load,
  };
  // The open folder's own sync or backup, shown above its files.
  const localSync = trailId
    ? syncRoots.find(
        (root) =>
          root.remoteId === trailId || `local-sync:${encodeURIComponent(root.id)}:` === trailId,
      )
    : undefined;
  // Folders synced on other devices can be synced here too; shared ones are linked from invitations.
  const remoteSync =
    trailId && !localSync
      ? placeData.folders?.find(
          (folder) =>
            folder.id === trailId &&
            !folder.syncRemovedAt &&
            (!status.accountId || folder.ownerUserId === status.accountId),
        )
      : undefined;
  const backupFolder =
    !!trailId &&
    (backupRoots.some((root) => root.remoteId === trailId) ||
      !!placeData.backups?.some((root) => root.remoteRootDriveItemId === trailId));
  const folderHeader = !trailId ? null : localSync || remoteSync ? (
    <SyncFolderPanel
      key={trailId}
      root={localSync}
      remote={remoteSync}
      state={sync ?? {}}
      jobs={jobs}
      refresh={async () => {
        await load();
        setPlaceRevision((value) => value + 1);
      }}
      manageStorage={() => setSection('Storage')}
    />
  ) : backupFolder ? (
    <BackupFolderPanel
      key={trailId}
      api={backupApi}
      folderId={trailId}
      desktop={backupDesktop}
      onChanged={() => setPlaceRevision((value) => value + 1)}
    />
  ) : null;
  // One line in the sidebar: problems first, then work under way, then all clear.
  const average = (values: (number | undefined)[]) => {
    const known = values.filter((value): value is number => value !== undefined);
    return known.length
      ? Math.round(known.reduce((sum, value) => sum + value, 0) / known.length)
      : undefined;
  };
  const failingBackups = (placeData.backups ?? []).filter((root) => root.state === 'ERROR');
  const problems = sync ? syncRequirements(syncRoots, sync, jobs).length : 0;
  const syncing = sync
    ? syncRoots.filter((root) => folderState(root, sync, jobs) === 'Syncing')
    : [];
  const backingUp = backupRoots.filter(
    (root) => !root.paused && sync?.progress?.[root.id] !== undefined,
  );
  const folderStatus: { activity: FolderActivity; open: () => void } | null =
    !sync || !roots.length
      ? null
      : problems
        ? {
            activity: {
              tone: 'error',
              label: problems === 1 ? 'Sync needs attention' : `${problems} sync problems`,
            },
            open: () => openPlace('synced', status.deviceId ?? undefined),
          }
        : failingBackups.length
          ? {
              activity: {
                tone: 'error',
                label:
                  failingBackups.length === 1
                    ? `${failingBackups[0].localPathDisplayName} needs attention`
                    : `${failingBackups.length} backups need attention`,
              },
              open: () => openPlace('backups'),
            }
          : sync.paused
            ? {
                activity: { tone: 'paused', label: 'Sync and backups paused' },
                open: () => setSection('Settings'),
              }
            : !sync.online
              ? {
                  activity: { tone: 'paused', label: 'Offline · changes wait' },
                  open: () => openPlace('synced', status.deviceId ?? undefined),
                }
              : syncing.length
                ? {
                    activity: {
                      tone: 'busy',
                      label: 'Syncing…',
                      percent: average(syncing.map((root) => sync.progress?.[root.id])),
                    },
                    open: () => openPlace('synced', status.deviceId ?? undefined),
                  }
                : backingUp.length
                  ? {
                      activity: {
                        tone: 'busy',
                        label:
                          backingUp.length === 1
                            ? `Backing up ${backingUp[0].localPathDisplayName}…`
                            : `Backing up ${backingUp.length} folders…`,
                        percent: average(backingUp.map((root) => sync.progress?.[root.id])),
                      },
                      open: () => openPlace('backups', status.deviceId ?? undefined),
                    }
                  : {
                      activity: {
                        tone: 'ok',
                        label: syncRoots.length ? 'All synced' : 'Backups up to date',
                      },
                      open: () =>
                        openPlace(
                          syncRoots.length ? 'synced' : 'backups',
                          status.deviceId ?? undefined,
                        ),
                    };
  return (
    <div className="app-shell desktop-shell">
      <a className="skip-to-content" href="#workspace-content">
        Skip to content
      </a>
      <aside className="sidebar">
        <div className="brand">
          <BrandLogo />
        </div>
        <Button
          className="upload-button"
          aria-label="Upload files"
          disabled={busy || localFolderPending || (section === 'My Drive' && driveReadOnly)}
          title={localFolderPending ? 'Available after this folder syncs' : undefined}
          onClick={() =>
            void act(async () => {
              await bridge.upload({ parentId });
              setDriveRevision((value) => value + 1);
            })
          }
        >
          <Plus />
          <span className="upload-label">Upload files</span>
        </Button>
        <nav aria-label="Main navigation">
          {nav.map(([name, Icon]) => (
            <button
              key={name}
              aria-label={name}
              title={name}
              aria-current={section === name ? 'page' : undefined}
              className={`nav-item ${section === name ? 'active' : ''} ${name === 'Devices' ? 'nav-separated' : ''}`}
              onClick={() => {
                setSection(name);
                if (name === 'My Drive') setPlace(null);
                if (name === 'Shared') setSharedTab('Received');
                setQuery('');
                goToFolder([]);
                setItems([]);
              }}
            >
              <Icon aria-hidden="true" />
              <span>{name}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <FolderActivityStatus
            activity={folderStatus?.activity ?? null}
            onOpen={() => folderStatus?.open()}
          />
          <StorageIndicator
            storage={storage}
            onManage={() => setSection('Storage')}
            onRetry={() => void load().catch(() => {})}
          />
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <InputGroup className="search-box" icon={<Search aria-hidden="true" />}>
            <Input
              type="search"
              aria-label="Search files"
              placeholder="Search your files"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                if (section !== 'My Drive') {
                  setSection('My Drive');
                  setTrail([]);
                }
              }}
            />
          </InputGroup>
          <div className="topbar-right">
            <ThemeToggle />
            <SyncNotifications
              key={status.accountId ?? 'desktop-session'}
              feed={activity}
              roots={status.roots}
              state={sync ?? {}}
              jobs={sync?.jobs ?? status.jobs}
              refresh={load}
              showBanner={section === 'My Drive' && place?.place === 'synced' && !zipProgress}
              manageFolders={() => openPlace('synced', status.deviceId ?? undefined)}
              manageStorage={() => setSection('Storage')}
            />
            <AccountMenu
              user={account}
              storage={storage}
              onNavigate={setSection}
              onSignOut={() => void act(() => bridge.logout())}
            />
          </div>
        </header>
        <main
          id="workspace-content"
          tabIndex={-1}
          className={`workspace ${section === 'My Drive' ? 'drive-page' : ''}`}
        >
          {zipProgress && <ZipDownloadStatusPanel progress={zipProgress} />}
          <UploadTray
            uploads={uploads}
            onDismiss={() => {
              const finished = finishedKeys(uploads);
              setUploads((old) => old.filter((u) => !finished.has(u.key)));
            }}
          />
          {section !== 'My Drive' && (
            <div className={`page-heading ${section === 'Shared' ? 'shared-heading' : ''}`}>
              <div>
                <h1>{section}</h1>
              </div>
            </div>
          )}
          <div className="page-alerts">
            {(error || loadError) && (
              <Alert
                tone="error"
                dismissLabel="Dismiss error"
                onDismiss={error ? () => setError('') : undefined}
              >
                {error || loadError}
              </Alert>
            )}
          </div>
          {section === 'Storage' && (
            <StoragePanel
              storage={storage}
              error={storageError}
              retry={() => void load().catch(() => {})}
            />
          )}
          {section === 'My Drive' && place && !trail.length && !query && (
            <DevicePlace
              place={place.place}
              groups={groups}
              groupKey={place.key ?? null}
              loading={!placeData.devices && !placeData.error}
              error={placeData.error}
              onRetry={() => setPlaceRevision((value) => value + 1)}
              breadcrumbs={
                <>
                  <button onClick={() => goToPlace(null)}>My Drive</button>
                  {placeCrumbs}
                </>
              }
              usage={placeData.usage}
              actions={
                place.place === 'archives' ||
                (place.key && place.key !== status.deviceId) ? undefined : place.place ===
                  'synced' ? (
                  <Button onClick={() => setAddingSync(true)}>
                    <Plus />
                    Sync a folder
                  </Button>
                ) : (
                  <Button
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        if (!(await bridge.chooseRoot({ mode: 'backup' }))) return;
                        setPlaceRevision((value) => value + 1);
                        setToast(
                          'Folder added. Its first backup starts once files have been unchanged for an hour.',
                        );
                      })
                    }
                  >
                    <Plus />
                    Back up a folder
                  </Button>
                )
              }
              onOpenGroup={(key) => goToPlace({ place: place.place, key })}
              onOpenFolder={(key, folderId) => {
                const folder = groups
                  .find((entry) => entry.key === key)
                  ?.folders.find((entry) => entry.id === folderId);
                setPlace({ place: place.place, key });
                goToFolder([{ id: folderId, name: folder?.name ?? 'Folder' }]);
              }}
            />
          )}
          {section === 'My Drive' && !query && trail.length > 0 && sync && !folderHeader && (
            <OpenFolderProgress
              roots={status.roots}
              trail={trail}
              state={sync}
              jobs={sync.jobs ?? []}
            />
          )}
          {section === 'My Drive' && !(place && !trail.length && !query) && (
            <DriveWorkspace
              onActivity={activity.publish}
              request={appearanceRequest}
              parentId={parentId}
              trail={trail}
              query={query}
              onClearSearch={() => setQuery('')}
              userId={status.accountId}
              storage={storage}
              refreshKey={`${driveRevision}:${sync?.recent?.[0]?.id ?? ''}`}
              pendingItems={sync?.driveItems}
              localSyncDevices={Object.fromEntries(
                status.roots
                  .filter((root: any) => root.mode === 'sync')
                  .flatMap((root: any) =>
                    [root.remoteId, `local-sync:${encodeURIComponent(root.id)}:`]
                      .filter(Boolean)
                      .map((id) => [
                        id,
                        [
                          {
                            id: status.deviceId ?? 'local',
                            name: status.deviceName || 'This device',
                          },
                        ],
                      ]),
                  ),
              )}
              syncedFolderIds={status.roots
                .filter((root: any) => root.mode === 'sync' && root.remoteId)
                .map((root: any) => root.remoteId)}
              pinned={
                place
                  ? undefined
                  : drivePlacePins(
                      (target) => goToPlace({ place: target }),
                      placeSizes(placeData.folders, placeData.backups, placeData.usage),
                    )
              }
              showFolderUsage={!!place}
              header={folderHeader}
              breadcrumbs={
                <>
                  <button onClick={() => goToPlace(null)}>My Drive</button>
                  {placeCrumbs}
                  {trail.map((entry, index) => (
                    <span key={entry.id}>
                      <ChevronRight size={14} />
                      <button
                        aria-current={index === trail.length - 1 ? 'location' : undefined}
                        onClick={() => goToFolder(trail.slice(0, index + 1))}
                      >
                        {entry.name}
                      </button>
                    </span>
                  ))}
                </>
              }
              canOpenDeviceCopy
              onRemoveSync={async (item) => {
                await bridge.removeSyncFolder({ folderId: item.id });
                await load();
              }}
              onSyncRemoved={() => goToFolder([])}
              onRoot={() => goToPlace(null)}
              onReadOnlyChange={setDriveReadOnly}
              onDisconnectBackup={async (item) => {
                const local = status.roots.find(
                  (root: { mode: string; remoteId: string }) =>
                    root.mode === 'backup' && root.remoteId === item.id,
                );
                if (local) await bridge.disconnectBackup({ id: local.id });
                else await request(`/v1/backups/${item.backupRootId}`, 'DELETE');
                await load();
              }}
              onOpen={(item) => void openDriveItem(item)}
              onUpload={() =>
                void act(async () => {
                  await bridge.upload({ parentId });
                  setDriveRevision((value) => value + 1);
                })
              }
              onDropFiles={(entries) => bridge.uploadDropped({ entries, parentId })}
              onDownload={async (item, versionId) => {
                const result = await bridge.download({
                  driveItemId: item.id,
                  name: item.name,
                  folder: item.type === 'FOLDER',
                  ...(versionId ? { versionId } : {}),
                });
                if (result?.saved)
                  setToast(`Saved ${item.name}${item.type === 'FOLDER' ? '.zip' : ''}.`);
              }}
              onChanged={() => {
                setDriveRevision((value) => value + 1);
                void load().catch(() => {});
              }}
              onManageStorage={() => setSection('Storage')}
            />
          )}
          {section === 'Trash' && (
            <>
              <div className="file-toolbar">
                <div className="breadcrumbs">
                  <button onClick={() => goToFolder([])}>{section}</button>
                  {trail.map((t, index) => (
                    <span key={t.id}>
                      <ChevronRight size={14} />
                      <button onClick={() => goToFolder(trail.slice(0, index + 1))}>
                        {t.name}
                      </button>
                    </span>
                  ))}
                  <Badge className="count">
                    {loading
                      ? 'Loading…'
                      : loadError && !visibleItems.length
                        ? 'Unavailable'
                        : `${visibleItems.length} items${cursor || nextCursor ? ' on this page' : ''}`}
                  </Badge>
                </div>
                {section === 'Trash' && (
                  <Button
                    variant="outline"
                    disabled={
                      busy || loading || !!loadError || (!items.length && !cursor && !nextCursor)
                    }
                    onClick={() => setModal({ mode: 'empty-trash', item: null })}
                  >
                    <Trash2 />
                    Empty Trash
                  </Button>
                )}
              </div>
              {loading ? (
                <FileCollectionSkeleton />
              ) : loadError && !visibleItems.length ? (
                <FileLoadError
                  onRetry={() => {
                    setLoadedView('');
                    void load().catch(() => {});
                  }}
                />
              ) : !visibleItems.length ? (
                <FileEmptyState
                  section={section}
                  inFolder={!!parentId}
                  desktop
                  busy={busy}
                  onUpload={() => void act(() => bridge.upload({ parentId }))}
                  onCreateFolder={() => setModal({ mode: 'folder', item: null })}
                  onBrowse={() => {
                    setSection('My Drive');
                    goToFolder([]);
                  }}
                />
              ) : (
                <FileCollection
                  items={visibleItems}
                  userId={status.accountId}
                  trash={section === 'Trash'}
                  canOpen={(item) => !item.localOnly || item.type === 'FOLDER'}
                  onOpen={(item) => void openDriveItem(item)}
                  renderStatus={(item) =>
                    item.syncStatus && (
                      <Badge
                        tone={item.syncStatus === 'Syncing' ? 'accent' : 'neutral'}
                        className={`drive-sync-status ${item.syncStatus === 'Syncing' ? 'is-syncing' : ''}`}
                        title={item.syncDetail}
                      >
                        {item.syncStatus === 'Syncing' && (
                          <RefreshCw className="spin" aria-hidden="true" />
                        )}
                        {item.syncStatus}
                        {item.syncProgress !== undefined ? ` · ${item.syncProgress}%` : ''}
                        <span className="sr-only">{item.syncDetail}</span>
                      </Badge>
                    )
                  }
                  renderActions={(item) =>
                    item.localOnly ? (
                      <span className="muted" title="Available after syncing">
                        —
                      </span>
                    ) : (
                      <ActionsMenu label={`Actions for ${item.name}`}>
                        {section === 'Trash' ? (
                          <>
                            <MenuItem
                              disabled={busy}
                              onClick={() =>
                                void trashChanges.remove([item], () =>
                                  request(`/v1/drive/items/${item.id}/restore`, 'POST', {
                                    ...op(),
                                    baseRevision: item.revision,
                                  }),
                                )
                              }
                            >
                              Restore
                            </MenuItem>
                            <MenuItem
                              tone="danger"
                              disabled={busy}
                              onClick={() => setModal({ mode: 'permanent', item })}
                            >
                              Delete permanently
                            </MenuItem>
                          </>
                        ) : (
                          <>
                            {item.type === 'FILE' && (
                              <MenuItem onClick={() => setModal({ mode: 'preview', item })}>
                                Preview
                              </MenuItem>
                            )}
                            <MenuItem
                              disabled={busy}
                              onClick={() =>
                                void download({
                                  driveItemId: item.id,
                                  name: item.name,
                                  folder: item.type === 'FOLDER',
                                })
                              }
                            >
                              {item.type === 'FOLDER' ? 'Download as ZIP' : 'Download'}
                            </MenuItem>
                            <MenuItem onClick={() => setModal({ mode: 'rename', item })}>
                              Rename
                            </MenuItem>
                            <MenuItem onClick={() => setModal({ mode: 'send', item })}>
                              Send
                            </MenuItem>
                            <MenuSeparator />
                            <MenuItem
                              tone="danger"
                              onClick={() => setModal({ mode: 'trash', item })}
                            >
                              Move to trash
                            </MenuItem>
                          </>
                        )}
                      </ActionsMenu>
                    )
                  }
                />
              )}
              {!loading && (
                <div className="file-pagination">
                  {cursor && (
                    <Button variant="outline" onClick={() => setCursor(undefined)}>
                      First page
                    </Button>
                  )}
                  {nextCursor && (
                    <Button variant="outline" onClick={() => setCursor(nextCursor)}>
                      Next page
                    </Button>
                  )}
                </div>
              )}
            </>
          )}
          {section === 'Shared' && (
            <SharedTabs
              tab={sharedTab}
              onChange={(tab) => {
                setSharedTab(tab);
                setCursor(undefined);
                setError('');
              }}
            >
              <div className="transfer-list">
                {sharedTab === 'Received' && (
                  <SharedSyncInvitations
                    hideWhenEmpty
                    key={invitationRevision}
                    roots={status.roots ?? []}
                    refresh={load}
                  />
                )}
                {sharedTab === 'Received' && status.notificationError && (
                  <Alert tone="error">
                    Desktop notifications could not be shown. Your invitations are listed here. Open
                    Settings to test notifications and check system permissions.
                  </Alert>
                )}
                {loading && <ContentSkeleton label="Loading transfers" />}
                {!loading && loadError && !items.length && (
                  <LoadError
                    onRetry={() => {
                      setLoadedView('');
                      void load().catch(() => {});
                    }}
                  />
                )}
                {!loading && !loadError && !items.length && (
                  <EmptyState
                    icon={sharedTab === 'Received' ? <Inbox /> : <Send />}
                    title={sharedTab === 'Received' ? 'No received transfers' : 'No sent files'}
                    description={
                      sharedTab === 'Received'
                        ? 'Files sent to your username or account email will appear here.'
                        : 'Choose a file in My Drive and select Send from its menu to share it directly with someone.'
                    }
                    actions={
                      <Button
                        variant="outline"
                        onClick={() => {
                          setSection('My Drive');
                          goToFolder([]);
                        }}
                      >
                        Browse My Drive
                      </Button>
                    }
                  />
                )}
                {!loading && items.length > 0 && (
                  <TransferTable
                    transfers={items}
                    direction={sharedTab}
                    busy={busy}
                    onAction={async (t, action) => {
                      // Declining or cancelling cannot be undone, so ask first.
                      if (action === 'decline' || action === 'cancel') {
                        setConfirmation({
                          title:
                            action === 'decline'
                              ? 'Decline this transfer?'
                              : 'Cancel this transfer?',
                          description:
                            action === 'decline'
                              ? 'You won’t be able to download these files unless they are sent again.'
                              : 'The recipient will no longer be able to accept or download these files.',
                          label: action === 'decline' ? 'Decline transfer' : 'Cancel transfer',
                          done: action === 'decline' ? 'Transfer declined.' : 'Transfer cancelled.',
                          run: () => request(`/v1/transfers/${t.id}/${action}`, 'POST', op()),
                        });
                        return;
                      }
                      await act(
                        () =>
                          request(`/v1/transfers/${t.id}/${action}`, 'POST', {
                            ...op(),
                            ...(action === 'save' ? { targetParentId: null } : {}),
                          }),
                        action === 'save'
                          ? 'Saving to My Drive. Large folders finish in the background.'
                          : 'Transfer accepted. You can now download or save the files.',
                      );
                    }}
                    onDownload={(t, entry) =>
                      download({ name: entry.displayName, transferId: t.id, entryId: entry.id })
                    }
                    loadEntries={(id, cursor) =>
                      request(`/v1/transfers/${id}/items?cursor=${encodeURIComponent(cursor)}`)
                    }
                  />
                )}
                {!loading && (cursor || nextCursor) && (
                  <div className="file-pagination">
                    {cursor && (
                      <Button variant="outline" onClick={() => setCursor(undefined)}>
                        First page
                      </Button>
                    )}
                    {nextCursor && (
                      <Button variant="outline" onClick={() => setCursor(nextCursor)}>
                        Next page
                      </Button>
                    )}
                  </div>
                )}
              </div>
            </SharedTabs>
          )}
          {section === 'Devices' && (
            <ConnectedDevices
              devices={loading ? undefined : items}
              currentId={status.deviceId}
              loading={loading}
              error={!!loadError}
              onRetry={() => {
                setLoadedView('');
                void load().catch(() => {});
              }}
              onSignOut={(d) =>
                setConfirmation({
                  title: `Sign out ${d.name}?`,
                  description:
                    d.id === status.deviceId
                      ? 'This is the computer you’re using. You’ll be signed out, and its sync and backups pause until you sign in again. Nothing is deleted.'
                      : `${d.name} is signed out of harbor0. Its sync and backups pause, and resume when you sign in on it again. Nothing is deleted.`,
                  label: 'Sign out',
                  done: `${d.name} is signed out.`,
                  run: () => request(`/v1/devices/${d.id}/sign-out`, 'POST', {}),
                })
              }
              onRevoke={(d) =>
                void act(async () => {
                  // What revoking stops, so the confirmation can list it.
                  const [roots, synced] = await Promise.all([
                    request('/v1/backups'),
                    request('/v1/sync/folders'),
                  ]);
                  setConfirmation({
                    title: `Revoke ${d.name}?`,
                    description:
                      d.id === status.deviceId
                        ? 'This is the computer you’re using. It’s removed from your account and stops everything it does in harbor0.'
                        : 'This removes the device and stops everything it does in harbor0.',
                    details: (
                      <RevokeDetails
                        device={d}
                        backups={(roots.items as BackupRoot[]).filter(
                          (root) =>
                            root.state !== 'REMOVED' &&
                            root.state !== 'ARCHIVED' &&
                            ownsBackup(d, root),
                        )}
                        syncFolders={(synced.items as SyncFolderItem[]).filter((folder) =>
                          folder.syncDevices.some((entry) => entry.id === d.id),
                        )}
                      />
                    ),
                    label: 'Revoke device',
                    done: `${d.name} is revoked.`,
                    run: () => request(`/v1/devices/${d.id}`, 'DELETE'),
                  });
                })
              }
            />
          )}
          {section === 'Settings' && (
            <div className="settings-layout">
              <AppearanceSettings />
              {account && (
                <Card
                  className="panel"
                  title="Your account"
                  description="Change your name, username, or password in the harbor0 web app."
                >
                  <dl className="details">
                    <dt>Name</dt>
                    <dd>{account.displayName}</dd>
                    <dt>Username</dt>
                    <dd>@{account.username}</dd>
                    <dt>Email</dt>
                    <dd>{account.email}</dd>
                    <dt>This computer</dt>
                    <dd>{status.deviceName || 'This device'}</dd>
                  </dl>
                </Card>
              )}
              <Card
                className="panel"
                title="Sync & backups"
                description="Choose folders to sync or back up in My Drive, under Synced Folders and Backups. Open a folder there to see its status, pause it or change its settings."
              >
                <dl className="details">
                  <dt>On this computer</dt>
                  <dd>
                    {sync?.paused
                      ? 'Paused. Changes wait until you resume.'
                      : `${syncRoots.length} synced, ${backupRoots.length} backed up`}
                  </dd>
                  <dt>Backups</dt>
                  <dd>A new version is saved about an hour after you stop editing a file.</dd>
                </dl>
                <div className="settings-actions">
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void act(
                        () => bridge.pause({ paused: !sync?.paused }),
                        sync?.paused ? 'Sync and backups resumed.' : 'Sync and backups paused.',
                      )
                    }
                  >
                    {sync?.paused ? <Play /> : <Pause />}
                    {sync?.paused ? 'Resume sync and backups' : 'Pause sync and backups'}
                  </Button>
                  {(['synced', 'backups'] as const).map((target) => {
                    const Icon = drivePlaces[target].icon;
                    return (
                      <Button
                        key={target}
                        variant="outline"
                        onClick={() => openPlace(target, status.deviceId ?? undefined)}
                      >
                        <Icon />
                        {drivePlaces[target].name}
                      </Button>
                    );
                  })}
                </div>
              </Card>
              <Card
                className="panel"
                title="Desktop settings"
                description={`Background sync continues when you close this window. Allow notifications for harbor0 in system settings.${status.development ? ' Development builds appear as harbor0 Development on macOS.' : ''}`}
              >
                {status.notificationError && (
                  <Alert tone="error">Notifications failed: {status.notificationError}</Alert>
                )}
                <div className="settings-actions">
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        const result = await bridge.testNotification();
                        if (result?.shown) setToast('Test notification sent.');
                      })
                    }
                  >
                    Test notification
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => void act(() => bridge.notificationSettings())}
                  >
                    Notification settings
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => void act(() => bridge.diagnostics())}
                  >
                    Export diagnostics
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => void act(() => bridge.logout())}
                  >
                    Sign out
                  </Button>
                </div>
              </Card>
            </div>
          )}
        </main>
      </div>
      {modal?.mode === 'preview' && (
        <FilePreview
          cacheScope={status.accountId ?? 'desktop-session'}
          item={modal.item}
          load={loadPreview}
          onClose={() => setModal(null)}
          onDownload={() => void download({ driveItemId: modal.item.id, name: modal.item.name })}
        />
      )}
      {addingSync && (
        <AddSyncFolderDialog
          close={() => setAddingSync(false)}
          refresh={async () => {
            await load();
            setPlaceRevision((value) => value + 1);
          }}
        />
      )}
      {incoming && (
        <IncomingDialog
          key={`${incoming.kind}:${incoming.item.id}`}
          content={incoming}
          close={() => setIncoming(null)}
          refresh={async () => {
            setInvitationRevision((value) => value + 1);
            await load().catch((error) => setError((error as Error).message));
          }}
        />
      )}
      <Dialog
        open={!!modal && modal.mode !== 'preview'}
        onOpenChange={(v) => {
          if (!v) setModal(null);
        }}
        title={
          modal?.mode === 'empty-trash'
            ? 'Empty Trash?'
            : modal?.mode === 'permanent'
              ? 'Delete permanently?'
              : modal?.mode === 'send'
                ? 'Send to a person'
                : modal?.mode === 'folder'
                  ? 'Create a folder'
                  : modal?.mode === 'trash'
                    ? 'Move to trash?'
                    : modal?.mode === 'root'
                      ? modal.item.mode === 'backup'
                        ? 'Backup settings'
                        : 'Folder options'
                      : 'Rename item'
        }
        description={
          modal?.mode === 'empty-trash'
            ? 'Permanently delete all items in Trash, including items on other pages and their version history? This cannot be undone. Content needed by sent transfers remains stored until those transfers end.'
            : modal?.mode === 'permanent'
              ? 'Permanently delete this item and its version history? This cannot be undone. Content needed by sent transfers remains stored until those transfers end.'
              : undefined
        }
      >
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            const data = Object.fromEntries(new FormData(e.currentTarget)) as Record<
              string,
              string
            >;
            if (modal?.mode === 'permanent') {
              const item = modal.item;
              setModal(null);
              void trashChanges.remove([item], () =>
                request(`/v1/drive/items/${item.id}/permanent`, 'DELETE', {
                  ...op(),
                  baseRevision: item.revision,
                }),
              );
              return;
            }
            void act(async () => {
              if (modal?.mode === 'send')
                await request('/v1/transfers', 'POST', {
                  ...op(),
                  recipient: {
                    type:
                      data.recipient.includes('@') && !data.recipient.startsWith('@')
                        ? 'EMAIL'
                        : 'USERNAME',
                    value: data.recipient.replace(/^@/, ''),
                  },
                  items: [{ driveItemId: modal.item.id }],
                });
              if (modal?.mode === 'folder')
                await request('/v1/drive/folders', 'POST', { ...op(), parentId, name: data.name });
              if (modal?.mode === 'rename')
                await request(`/v1/drive/items/${modal.item.id}`, 'PATCH', {
                  ...op(),
                  name: data.name,
                  baseRevision: modal.item.revision,
                });
              if (modal?.mode === 'trash')
                await request(`/v1/drive/items/${modal.item.id}`, 'DELETE', {
                  ...op(),
                  baseRevision: modal.item.revision,
                });
              if (modal?.mode === 'permanent')
                await request(`/v1/drive/items/${modal.item.id}/permanent`, 'DELETE', {
                  ...op(),
                  baseRevision: modal.item.revision,
                });
              if (modal?.mode === 'empty-trash') {
                await new ApiClient(appearanceRequest).emptyTrash();
                setCursor(undefined);
              }
              if (modal?.mode === 'root')
                await bridge.rootSettings({
                  id: modal.item.id,
                  paused: data.paused === 'on',
                  excluded: data.excluded
                    .split('\n')
                    .map((s) => s.trim())
                    .filter(Boolean),
                });
              setModal(null);
            });
          }}
        >
          {['rename', 'folder'].includes(modal?.mode ?? '') && (
            <Field label="Name">
              <Input name="name" required defaultValue={modal?.item?.name} />
            </Field>
          )}
          {modal?.mode === 'send' && (
            <RecipientPicker
              autoFocus
              search={(path) => request(path)}
              allowInvite
              onKindChange={setRecipientKind}
            />
          )}
          {modal?.mode === 'root' && (
            <>
              <Field
                inline
                label={
                  modal.item.mode === 'backup'
                    ? 'Pause backups for this folder'
                    : 'Pause this folder'
                }
              >
                <Checkbox name="paused" defaultChecked={modal.item.paused} />
              </Field>
              <Field
                label={
                  modal.item.mode === 'backup'
                    ? 'Don’t back up these subfolders (one per line, e.g. Photos/Raw)'
                    : 'Keep these relative folders cloud-only (one per line)'
                }
                hint={
                  modal.item.mode === 'backup'
                    ? 'Versions already saved from skipped subfolders are kept.'
                    : 'Existing local files remain on your computer when excluded.'
                }
              >
                <Textarea name="excluded" defaultValue={modal.item.excluded.join('\n')} rows={5} />
              </Field>
            </>
          )}
          {error && <Alert tone="error">{error}</Alert>}
          <DialogActions>
            <Button type="button" variant="outline" onClick={() => setModal(null)}>
              Cancel
            </Button>
            <Button
              disabled={busy}
              variant={
                ['empty-trash', 'permanent'].includes(modal?.mode ?? '') ? 'danger' : 'primary'
              }
            >
              {busy
                ? 'Working…'
                : modal?.mode === 'empty-trash'
                  ? 'Empty Trash'
                  : modal?.mode === 'permanent'
                    ? 'Delete permanently'
                    : modal?.mode === 'send'
                      ? recipientKind === 'invite'
                        ? 'Send invite'
                        : 'Send'
                      : 'Save'}
            </Button>
          </DialogActions>
        </form>
      </Dialog>
      <Dialog
        open={!!confirmation}
        onOpenChange={(v) => {
          if (!v && !busy) setConfirmation(null);
        }}
        title={confirmation?.title ?? ''}
        description={confirmation?.description}
      >
        {confirmation?.details}
        {error && <Alert tone="error">{error}</Alert>}
        <DialogActions>
          <Button variant="outline" disabled={busy} onClick={() => setConfirmation(null)}>
            Go back
          </Button>
          <Button
            variant="danger"
            disabled={busy}
            onClick={() =>
              void act(confirmation!.run, confirmation!.done).then((done) => {
                if (done) setConfirmation(null);
              })
            }
          >
            {busy ? 'Working…' : confirmation?.label}
          </Button>
        </DialogActions>
      </Dialog>
      {toast && (
        <div className="toast" role="status">
          <Check aria-hidden="true" />
          {toast}
        </div>
      )}
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
