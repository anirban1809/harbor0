import { BrandLogo } from '../../web/components/brand-logo';
import { FilePreview } from '../../web/components/file-preview';
import {
  ZipDownloadStatusPanel,
  type ZipDownloadStatus,
} from '../../web/components/zip-download-status';
import { previewKind, type PreviewLoader } from '../../web/lib/file-preview';
import { Input } from '../../web/components/ui/input';
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  HardDrive,
  Inbox,
  Send,
  Cloud,
  Laptop,
  RefreshCw,
  Settings,
  Plus,
  ShieldCheck,
  Star,
  Trash2,
  ChevronRight,
  MoreHorizontal,
  Search,
} from 'lucide-react';
import * as Menu from '@radix-ui/react-dropdown-menu';
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
import { TransferTable } from '../../web/components/transfer-table';
import { DriveWorkspace } from '../../web/components/drive-workspace';
import { AccountMenu, StorageIndicator } from '../../web/components/drive-account';
import { SyncPage } from './sync-page';
import { mergeSyncItems } from './sync-drive';
import { Button } from '../../web/components/ui/button';
import { Dialog } from '../../web/components/ui/dialog';
import '../../web/app/globals.css';
import './desktop.css';
import '../../web/app/workspace-layout.css';
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
function App() {
  const [status, setStatus] = useState<any>();
  useAccountAppearance(
    status?.signedIn ? (status.accountId ?? 'desktop-session') : undefined,
    appearanceRequest,
  );
  const [section, setSection] = useState('My Drive');
  const [items, setItems] = useState<any[]>([]);
  const [trail, setTrail] = useState<any[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
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
  const visibleItems: any[] =
    section === 'My Drive' ? mergeSyncItems(items, sync?.driveItems ?? [], parentId) : items;
  const statusVersion = useRef(0);
  const latestActivity = useRef<string | undefined>(undefined);
  const [cursor, setCursor] = useState<string>();
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadedView, setLoadedView] = useState('');
  const [loadError, setLoadError] = useState('');
  const view = JSON.stringify([section, parentId, cursor]);
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
    const id = ++requestId.current;
    const current = () => id === requestId.current && view === activeView.current;
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
          : section === 'Received'
            ? '/v1/transfers/received'
            : section === 'Sent'
              ? '/v1/transfers/sent'
              : section === 'Devices'
                ? '/v1/devices'
                : section === 'Favorites'
                  ? '/v1/search?favorite=true'
                  : section === 'Trash'
                    ? '/v1/search?trash=true'
                    : null;
      if (endpoint) {
        const page =
          section === 'My Drive' && parentId?.startsWith('local-sync:')
            ? { items: [], nextCursor: null }
            : await request(
                endpoint +
                  (cursor
                    ? `${endpoint.includes('?') ? '&' : '?'}cursor=${encodeURIComponent(cursor)}`
                    : ''),
              );
        if (!current()) return;
        setItems(page.items);
        setNextCursor(page.nextCursor ?? null);
      }
      if (current()) setLoadError('');
    } catch (error) {
      if (current()) {
        if (loadedView !== view) {
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
  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await fn();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
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
  }, [section, parentId, cursor]);
  if (!status)
    return error || loadError ? (
      <main className="loading-screen">
        <p role="alert">{error || loadError}</p>
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
              <p className="error">
                {status.configurationError ?? 'harbor0’s server connection is not configured.'} Add
                the connection settings to apps/desktop/.env.local, then fully quit and restart
                harbor0.
              </p>
            )}
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <form
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
              <label>
                Email
                <Input
                  name="email"
                  defaultValue={status.development ? 'alice@example.test' : ''}
                  type="email"
                  autoComplete="username"
                  disabled={busy}
                  required
                />
              </label>
              <label>
                Password
                <Input
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  maxLength={256}
                  disabled={busy}
                  required
                />
              </label>
              <Button type="submit" disabled={busy || !status.configured}>
                {busy
                  ? 'Signing in…'
                  : status.development
                    ? 'Sign in to local development'
                    : 'Sign in'}
              </Button>
            </form>
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
    ['Received', Inbox],
    ['Sent', Send],
    ['Favorites', Star],
    ['Trash', Trash2],
    ['Backups', Cloud],
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
          disabled={busy || localFolderPending}
          title={localFolderPending ? 'Available after this folder syncs' : undefined}
          onClick={() =>
            void act(async () => {
              await bridge.upload({ parentId });
              setDriveRevision((value) => value + 1);
            })
          }
        >
          <Plus size={17} />
          <span className="upload-label">Upload files</span>
        </Button>
        <nav aria-label="Main navigation">
          {nav.map(([name, Icon]) => (
            <button
              key={name}
              aria-label={name}
              title={name}
              aria-current={section === name ? 'page' : undefined}
              className={`nav-item ${section === name ? 'active' : ''}`}
              onClick={() => {
                setSection(name);
                setQuery('');
                goToFolder([]);
                setItems([]);
              }}
            >
              <Icon size={17} />
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
          <AccountMenu
            footer
            user={account}
            storage={storage}
            onNavigate={setSection}
            onSignOut={() => void act(() => bridge.logout())}
          />
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="search-box">
            <Search size={18} />
            <Input
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
          </div>
          <div className="topbar-right">
            <ThemeToggle />
            <span
              className="private-badge"
              aria-label="Private workspace"
              title="Private workspace"
            >
              <ShieldCheck size={15} />
              Private workspace
            </span>
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
            <div className="page-heading">
              <div>
                <h1>{section}</h1>
              </div>
            </div>
          )}
          {(error || loadError) && (
            <p className="error" role="alert">
              {error || loadError}
            </p>
          )}
          {section === 'Storage' && (
            <StoragePanel
              storage={storage}
              error={storageError}
              retry={() => void load().catch(() => {})}
            />
          )}
          {section === 'My Drive' && (
            <DriveWorkspace
              request={appearanceRequest}
              parentId={parentId}
              trail={trail}
              query={query}
              onClearSearch={() => setQuery('')}
              userId={status.accountId}
              storage={storage}
              refreshKey={`${driveRevision}:${sync?.recent?.[0]?.id ?? ''}`}
              pendingItems={sync?.driveItems}
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
              onOpen={(item) => void openDriveItem(item)}
              onUpload={() =>
                void act(async () => {
                  await bridge.upload({ parentId });
                  setDriveRevision((value) => value + 1);
                })
              }
              onDropFiles={(files) => bridge.uploadDropped({ files, parentId })}
              onDownload={(item, versionId) =>
                bridge.download({
                  driveItemId: item.id,
                  name: item.name,
                  folder: item.type === 'FOLDER',
                  ...(versionId ? { versionId } : {}),
                })
              }
              onChanged={() => {
                setDriveRevision((value) => value + 1);
                void load().catch(() => {});
              }}
              onManageStorage={() => setSection('Storage')}
            />
          )}
          {['Favorites', 'Trash'].includes(section) && (
            <>
              <div className="file-toolbar">
                <div className="breadcrumbs">
                  <button onClick={() => goToFolder([])}>
                    {section === 'My Drive' ? 'All files' : section}
                  </button>
                  {trail.map((t, index) => (
                    <span key={t.id}>
                      <ChevronRight size={14} />
                      <button onClick={() => goToFolder(trail.slice(0, index + 1))}>
                        {t.name}
                      </button>
                    </span>
                  ))}
                  <span className="count">
                    {loading
                      ? 'Loading…'
                      : loadError && !visibleItems.length
                        ? 'Unavailable'
                        : `${visibleItems.length} items${cursor || nextCursor ? ' on this page' : ''}`}
                  </span>
                </div>
                {section === 'Trash' && (
                  <Button
                    variant="destructive"
                    disabled={
                      busy || loading || !!loadError || (!items.length && !cursor && !nextCursor)
                    }
                    onClick={() => setModal({ mode: 'empty-trash', item: null })}
                  >
                    <Trash2 size={16} />
                    Empty Trash
                  </Button>
                )}
                {section === 'My Drive' && (
                  <Button
                    variant="outline"
                    disabled={localFolderPending}
                    title={localFolderPending ? 'Available after this folder syncs' : undefined}
                    onClick={() => setModal({ mode: 'folder', item: null })}
                  >
                    <Plus size={16} />
                    New folder
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
                      <span
                        className={`drive-sync-status ${item.syncStatus === 'Syncing' ? 'is-syncing' : ''}`}
                        title={item.syncDetail}
                      >
                        {item.syncStatus === 'Syncing' && (
                          <RefreshCw size={12} aria-hidden="true" />
                        )}
                        {item.syncStatus}
                        {item.syncProgress !== undefined ? ` · ${item.syncProgress}%` : ''}
                        <span className="sr-only">{item.syncDetail}</span>
                      </span>
                    )
                  }
                  renderActions={(item) =>
                    item.localOnly ? (
                      <span className="muted" title="Available after syncing">
                        —
                      </span>
                    ) : (
                      <Menu.Root>
                        <Menu.Trigger
                          className="icon-button"
                          aria-label={`Actions for ${item.name}`}
                        >
                          <MoreHorizontal size={18} />
                        </Menu.Trigger>
                        <Menu.Portal>
                          <Menu.Content className="dropdown" align="end" sideOffset={5}>
                            {section === 'Trash' ? (
                              <>
                                <Menu.Item
                                  disabled={busy}
                                  onSelect={() =>
                                    void act(() =>
                                      request(`/v1/drive/items/${item.id}/restore`, 'POST', {
                                        ...op(),
                                        baseRevision: item.revision,
                                      }),
                                    )
                                  }
                                >
                                  Restore
                                </Menu.Item>
                                <Menu.Item
                                  className="danger-text"
                                  disabled={busy}
                                  onSelect={() => setModal({ mode: 'permanent', item })}
                                >
                                  Delete permanently
                                </Menu.Item>
                              </>
                            ) : (
                              <>
                                {item.type === 'FILE' && (
                                  <Menu.Item onSelect={() => setModal({ mode: 'preview', item })}>
                                    Preview
                                  </Menu.Item>
                                )}
                                <Menu.Item
                                  disabled={busy}
                                  onSelect={() =>
                                    void act(() =>
                                      bridge.download({
                                        driveItemId: item.id,
                                        name: item.name,
                                        folder: item.type === 'FOLDER',
                                      }),
                                    )
                                  }
                                >
                                  {item.type === 'FOLDER' ? 'Download as ZIP' : 'Download'}
                                </Menu.Item>
                                <Menu.Item onSelect={() => setModal({ mode: 'rename', item })}>
                                  Rename
                                </Menu.Item>
                                <Menu.Item onSelect={() => setModal({ mode: 'send', item })}>
                                  Send
                                </Menu.Item>
                                <Menu.Separator />
                                <Menu.Item
                                  className="danger-text"
                                  onSelect={() => setModal({ mode: 'trash', item })}
                                >
                                  Move to trash
                                </Menu.Item>
                              </>
                            )}
                          </Menu.Content>
                        </Menu.Portal>
                      </Menu.Root>
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
          {['Received', 'Sent'].includes(section) && (
            <div className="transfer-list">
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
                  icon={section === 'Received' ? <Inbox /> : <Send />}
                  title={section === 'Received' ? 'No received files' : 'No sent files'}
                  description={
                    section === 'Received'
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
                  direction={section as 'Received' | 'Sent'}
                  busy={busy}
                  onAction={(t, action) =>
                    act(() =>
                      request(`/v1/transfers/${t.id}/${action}`, 'POST', {
                        ...op(),
                        ...(action === 'save' ? { targetParentId: null } : {}),
                      }),
                    )
                  }
                  onDownload={(t, entry) =>
                    act(() =>
                      bridge.download({
                        name: entry.displayName,
                        transferId: t.id,
                        entryId: entry.id,
                      }),
                    )
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
          )}
          {section === 'Sync' && (
            <SyncPage
              roots={status.roots}
              jobs={sync?.jobs ?? status.jobs}
              state={sync ?? {}}
              deviceName={status.deviceName}
              refresh={load}
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
              manageStorage={() => {
                setSection('My Drive');
                goToFolder([]);
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
                options: (root) => setModal({ mode: 'root', item: root }),
                refresh: load,
              }}
            />
          )}
          {section === 'Devices' && (
            <div className="panel">
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
                  <div className="simple-row" key={d.id}>
                    <Laptop />
                    <div>
                      <strong>{d.name}</strong>
                      <small>
                        {d.platform} · {d.revokedAt ? 'Revoked' : 'Active'}
                      </small>
                    </div>
                    <Button
                      disabled={!!d.revokedAt}
                      variant="outline"
                      onClick={() => void act(() => request(`/v1/devices/${d.id}`, 'DELETE'))}
                    >
                      Revoke
                    </Button>
                  </div>
                ))}
            </div>
          )}
          {section === 'Settings' && (
            <div className="settings-layout">
              <AppearanceSettings />
              <div className="panel">
                <h2>Desktop settings</h2>
                <p className="muted">Background sync continues when you close this window.</p>
                <div className="dialog-actions">
                  <Button variant="outline" onClick={() => void act(() => bridge.diagnostics())}>
                    Export diagnostics
                  </Button>
                  <Button variant="outline" onClick={() => void act(() => bridge.logout())}>
                    Sign out
                  </Button>
                </div>
              </div>
            </div>
          )}
        </main>
      </div>
      {modal?.mode === 'preview' && (
        <FilePreview
          item={modal.item}
          load={loadPreview}
          onClose={() => setModal(null)}
          onDownload={() =>
            void act(() => bridge.download({ driveItemId: modal.item.id, name: modal.item.name }))
          }
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
                      ? 'Folder options'
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
          onSubmit={(e) => {
            e.preventDefault();
            const data = Object.fromEntries(new FormData(e.currentTarget)) as Record<
              string,
              string
            >;
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
            <label>
              Name
              <Input name="name" required defaultValue={modal?.item?.name} />
            </label>
          )}
          {modal?.mode === 'send' && (
            <label>
              To
              <Input name="recipient" placeholder="@username or email" required />
            </label>
          )}
          {modal?.mode === 'root' && (
            <>
              <label>
                Pause this folder
                <input type="checkbox" name="paused" defaultChecked={modal.item.paused} />
              </label>
              <label>
                Keep these relative folders cloud-only (one per line)
                <textarea name="excluded" defaultValue={modal.item.excluded.join('\n')} rows={5} />
              </label>
              <small>Existing local files remain on your computer when excluded.</small>
            </>
          )}
          {error && <p className="error">{error}</p>}
          <div className="dialog-actions">
            <Button type="button" variant="outline" onClick={() => setModal(null)}>
              Cancel
            </Button>
            <Button
              disabled={busy}
              variant={
                ['empty-trash', 'permanent'].includes(modal?.mode ?? '') ? 'destructive' : 'default'
              }
            >
              {busy
                ? 'Saving…'
                : modal?.mode === 'empty-trash'
                  ? 'Empty Trash'
                  : modal?.mode === 'permanent'
                    ? 'Delete permanently'
                    : 'Save'}
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
