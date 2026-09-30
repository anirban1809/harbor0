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
import { Input, InputGroup, Textarea } from '../../web/components/ui/input';
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Archive,
  HardDrive,
  Inbox,
  Users,
  Send,
  Cloud,
  Laptop,
  RefreshCw,
  Settings,
  Plus,
  ShieldCheck,
  Trash2,
  ChevronRight,
  Search,
  Check,
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
import type { StorageUsage } from '@harbor/contracts';
import { StoragePanel } from './overview';
import { BackupsPage } from '../../web/components/backups-page';
import { SharedTabs, type SharedTab } from '../../web/components/shared-tabs';
import { TransferTable } from '../../web/components/transfer-table';
import { DriveWorkspace } from '../../web/components/lazy-drive-workspace';
import { AccountMenu, StorageIndicator } from '../../web/components/drive-account';
import { SyncPage } from './sync-page';
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
const platforms: Record<string, string> = {
  WEB: 'Web browser',
  MACOS: 'Mac',
  WINDOWS: 'Windows PC',
  LINUX: 'Linux computer',
  IOS: 'iPhone or iPad',
  ANDROID: 'Android device',
};
type Confirmation = {
  title: string;
  description: string;
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
  const [syncViewRevision, setSyncViewRevision] = useState(0);
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
  const [modal, setModal] = useState<{ mode: string; item: any } | null>(null);
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
    void load().catch(() => {});
    const timer = setInterval(() => void load().catch(() => {}), 10000);
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
                <RefreshCw size={18} />
                <span>Keep your files in sync across devices</span>
              </li>
              <li>
                <Cloud size={18} />
                <span>Back up local folders to the cloud</span>
              </li>
              <li>
                <ShieldCheck size={18} />
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
                <Input
                  size="lg"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  maxLength={256}
                  disabled={busy}
                  required
                />
              </Field>
              <Button type="submit" size="lg" block disabled={busy || !status.configured}>
                {busy
                  ? 'Signing in…'
                  : status.development
                    ? 'Sign in to local development'
                    : 'Sign in'}
              </Button>
            </form>
            <p className="auth-session-note">
              New to harbor0 or forgot your password? Create an account or reset your password in
              the harbor0 web app, then sign in here.
            </p>
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
    ['Backups', Archive],
    ['Devices', Laptop],
    ['Sync', RefreshCw],
    ['Storage', Cloud],
    ['Settings', Settings],
  ] as const;
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
              showBanner={section === 'Sync' && !zipProgress}
              manageFolders={() => {
                setSection('Sync');
                setSyncViewRevision((value) => value + 1);
              }}
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
          {section !== 'Sync' && section !== 'My Drive' && (
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
          {section === 'My Drive' && (
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
              breadcrumbs={
                <>
                  <button onClick={() => goToFolder([])}>My Drive</button>
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
              onRoot={() => goToFolder([])}
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
              onDropFiles={(files) => bridge.uploadDropped({ files, parentId })}
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
          {section === 'Sync' && (
            <SyncPage
              key={syncViewRevision}
              roots={status.roots}
              jobs={sync?.jobs ?? status.jobs}
              state={sync ?? {}}
              deviceName={status.deviceName}
              refresh={load}
              manageStorage={() => setSection('Storage')}
              openCloud={(root) => {
                setSection('My Drive');
                goToFolder(
                  root.remoteId
                    ? [
                        {
                          id: root.remoteId,
                          name: root.cloudPath?.split(' / ').at(-1) ?? root.localPathDisplayName,
                        },
                      ]
                    : [],
                );
              }}
            />
          )}
          {section === 'Backups' && (
            <BackupsPage
              api={backupApi}
              desktop={{
                roots: status.roots.filter((root: { mode: string }) => root.mode === 'backup'),
                add: () => bridge.chooseRoot({ mode: 'backup' }),
                backup: (id) => bridge.backupNow({ id }),
                disconnect: (id) => bridge.disconnectBackup({ id }),
                setPaused: (root, paused) =>
                  bridge.rootSettings({ id: root.id, paused, excluded: root.excluded ?? [] }),
                download: ({ itemId, versionId, name }) =>
                  bridge.download({ driveItemId: itemId, versionId, name }),
                options: (root) => setModal({ mode: 'root', item: root }),
                refresh: load,
              }}
            />
          )}
          {section === 'Devices' && (
            <Card
              className="panel"
              title="Connected devices"
              description="Use harbor0 on all your devices. Remove access whenever you need to."
            >
              {loading && <ContentSkeleton label="Loading devices" />}
              {!loading && loadError && !items.length && (
                <LoadError
                  compact
                  onRetry={() => {
                    setLoadedView('');
                    void load().catch(() => {});
                  }}
                />
              )}
              {!loading && !loadError && !items.length && (
                <EmptyState
                  compact
                  icon={<Laptop />}
                  title="No connected devices"
                  description="Computers signed in to harbor0 will appear here. Refresh to check for newly connected devices."
                  actions={
                    <Button
                      variant="outline"
                      onClick={() => {
                        setLoadedView('');
                        void load().catch(() => {});
                      }}
                    >
                      Refresh devices
                    </Button>
                  }
                />
              )}

              {!loading &&
                items.map((d) => (
                  <div className="list-row simple-row" key={d.id}>
                    <span className="icon-tile">
                      <Laptop aria-hidden="true" />
                    </span>
                    <div className="list-row-text">
                      <strong>
                        {d.name} {d.id === status.deviceId && <Badge>This computer</Badge>}
                      </strong>
                      <small>
                        {platforms[d.platform] ?? d.platform} ·{' '}
                        {d.revokedAt
                          ? 'Revoked'
                          : d.lastSeenAt
                            ? `Active · Last seen ${new Date(d.lastSeenAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`
                            : 'Active'}
                      </small>
                    </div>
                    {!d.revokedAt && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() =>
                          setConfirmation({
                            title: `Revoke access for ${d.name}?`,
                            description:
                              d.id === status.deviceId
                                ? 'This is the computer you are using. You will be signed out and syncing and backups will stop until you sign in again.'
                                : 'This device will be signed out and will stop syncing and backing up.',
                            label: 'Revoke access',
                            done: 'Device access removed.',
                            run: () => request(`/v1/devices/${d.id}`, 'DELETE'),
                          })
                        }
                      >
                        Revoke
                      </Button>
                    )}
                  </div>
                ))}
            </Card>
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
            <Field label="To">
              <Input name="recipient" placeholder="@username or email" required />
            </Field>
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
