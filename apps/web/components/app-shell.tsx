'use client';
import { useOptimisticRemoval } from '../lib/use-optimistic-removal';
import { browserSession, clearBrowserCaches } from '../lib/browser-cache';
import { ActivityNotifications, useActivityFeed } from './activity-notifications';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  authRoutes,
  workspaceRoutes,
  type AuthMode,
  type WorkspaceSection,
  loginDestination,
  driveHref,
  sharedHref,
  placeHref,
} from '../lib/routes';
import type { BackupRoot } from '../../../packages/contracts/src/backups';
import type { SyncFolderItem } from '@harbor/contracts';
import { ownsBackup } from '../lib/devices';
import {
  ConnectedDevices,
  DevicePlace,
  drivePlaceOrder,
  drivePlacePins,
  drivePlaces,
  isDrivePlace,
  placeFolderIds,
  placeGroups,
  placeSizes,
  type DrivePlace,
  RevokeDetails,
} from './device-folders';
import { loadFolderTrail } from '../lib/folder-navigation';
import { useDebouncedValue } from '../lib/use-debounced-value';
import { downloadFolderZip } from '../lib/folder-download';
import { ZipDownloadStatusPanel, type ZipDownloadStatus } from './zip-download-status';
import { BrandLogo } from '../components/brand-logo';
import { AuthPage } from './auth-page';
import { FilePreview } from '../components/lazy-file-preview';
import { previewKind, type PreviewLoader } from '../lib/file-preview';
import { fetchTextPreview } from '../../../packages/api-client/src/preview';
import { Input, InputGroup } from '../components/ui/input';
import { Suspense, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowDownToLine,
  Bell,
  Check,
  ChevronRight,
  Cloud,
  File as FileIcon,
  FileImage,
  FileText,
  Folder,
  HardDrive,
  Inbox,
  LayoutGrid,
  List,
  Plus,
  Search,
  Send,
  Settings,
  Trash2,
  Users,
  Laptop,
  Clock,
  RotateCcw,
  X,
} from 'lucide-react';
import { ApiClient, ApiError, createTransport, operation } from '@harbor/api-client';
import type { DriveItem, Device, Transfer } from '@harbor/contracts';
import { EmptyState, FileEmptyState, LoadError } from '../components/empty-state';
import { AppearanceSettings } from '../components/appearance-settings';
import { DeleteAccount } from '../components/delete-account';
import { useAccountAppearance } from '../lib/appearance';
import {
  FileCollection,
  FileCollectionSkeleton,
  FileLoadError,
} from '../components/file-collection';
import { ContentSkeleton, WorkspaceSkeleton } from '../components/loading-states';
import { ThemeToggle } from '../components/theme-toggle';
import { SharedTabs, type SharedTab } from './shared-tabs';
import { RecipientPicker, type RecipientKind } from './recipient-picker';
import { TransferTable, type TransferView } from './transfer-table';
import { BackupFolderPanel } from './backup-folder-panel';
import { SyncedFolderPanel, SyncInvitations } from './sync-sharing';
import { DriveWorkspace } from './lazy-drive-workspace';
import type { AddedItem } from './drive-workspace';
import { loadUsage, type UsageMap } from '../lib/folder-usage';
import {
  AccountMenu,
  FolderActivityStatus,
  StorageIndicator,
  type FolderActivity,
} from './drive-account';
import { MobileTabBar } from './mobile-nav';
import { StorageAudit } from './storage-audit';
import { Button } from '../components/ui/button';
import { Dialog, DialogActions } from '../components/ui/dialog';
import { Alert } from '../components/ui/alert';
import { Badge } from '../components/ui/badge';
import { Card } from '../components/ui/card';
import { Field } from '../components/ui/field';
import { ActionsMenu, MenuItem, MenuSeparator } from '../components/ui/menu';
import { Progress } from '../components/ui/progress';
import { Segmented } from '../components/ui/segmented';
import { Select } from '../components/ui/select';
import {
  BrowserUpload,
  isNameConflict,
  uploadErrorMessage,
  type UploadTarget,
} from '../lib/upload';
import { itemAccess } from '../lib/drive-access';
import { describeNotification, newestFirst, type ServerNotification } from '../lib/notifications';
import { finishedKeys, type FileUpload } from '../lib/upload-activity';
import { UploadTray } from './upload-tray';
import { readDroppedFiles, type UploadEntry } from '../lib/dropped-files';
import { onLive, useLiveUpdates } from '../lib/live-updates';
import { registerBrowser } from '../lib/device-key';
import {
  guardTransport,
  setSignedIn,
  useSessionEnd,
  useUpdateAvailable,
} from '../lib/session-guard';
const api = new ApiClient(guardTransport(createTransport('/api')));
const loadPreview: PreviewLoader = async (item, signal) => {
  const result = await api.download({ driveItemId: item.id });
  signal.throwIfAborted();
  return previewKind(item) === 'text'
    ? fetchTextPreview(result.downloadUrl, result.sizeBytes, signal)
    : { url: result.downloadUrl };
};
const createQueryClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: {
        retry: (count, e) => !(e instanceof ApiError && [401, 403].includes(e.status)) && count < 2,
        refetchOnWindowFocus: true,
        staleTime: 10000,
      },
    },
  });
const bytes = (n: number) =>
  n < 1000
    ? `${n} B`
    : n < 1e6
      ? `${(n / 1e3).toFixed(1)} KB`
      : n < 1e9
        ? `${(n / 1e6).toFixed(1)} MB`
        : `${(n / 1e9).toFixed(1)} GB`;
type UploadJob = {
  file: File;
  /** Folders to create under `base`, from a dropped or chosen folder. */
  folders: string[];
  batch: string;
  base: string | null;
  parent?: string | null;
  upload?: BrowserUpload;
  /** A new file, a new version of an existing one, or a copy beside a same-named item. */
  target?: UploadTarget;
  running?: boolean;
  stopped?: boolean;
  /** Waiting for a free upload slot. */
  queued?: boolean;
};
/** Files uploaded at once; each file also sends a few parts in parallel. */
const UPLOAD_SLOTS = 4;
const date = (s: string) =>
  new Date(s).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
// Select the name without its extension so typing replaces only the name.
const selectBaseName = (input: HTMLInputElement) => {
  const dot = input.value.lastIndexOf('.');
  input.setSelectionRange(0, dot > 0 ? dot : input.value.length);
};
type Confirmation = {
  title: string;
  description: string;
  /** More about what happens, shown below the description. */
  details?: ReactNode;
  label: string;
  done?: string;
  run: () => Promise<unknown>;
};
const navigation = [
  { name: 'My Drive', icon: HardDrive },
  { name: 'Shared', icon: Users },
  { name: 'Trash', icon: Trash2 },
  { name: 'Devices', icon: Laptop },
  { name: 'Storage', icon: Cloud },
  { name: 'Settings', icon: Settings },
];
function FileGlyph({ item }: { item: Pick<DriveItem, 'type' | 'mimeType'> }) {
  const Icon =
    item.type === 'FOLDER'
      ? Folder
      : item.mimeType?.startsWith('image/')
        ? FileImage
        : item.mimeType?.includes('pdf') || item.mimeType?.startsWith('text/')
          ? FileText
          : FileIcon;
  return (
    <span
      className="file-entry-icon"
      data-kind={
        item.type === 'FOLDER'
          ? 'folder'
          : item.mimeType?.startsWith('image/')
            ? 'image'
            : 'document'
      }
    >
      <Icon aria-hidden="true" />
    </span>
  );
}
function Workspace() {
  const cache = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const section =
    (Object.keys(workspaceRoutes) as WorkspaceSection[]).find(
      (name) => workspaceRoutes[name] === pathname,
    ) ?? (['/received', '/sent'].includes(pathname) ? 'Shared' : 'My Drive');
  // Synced Folders (/sync), Backups and Archives (/drive?place=) are places inside My Drive.
  const placeParam = searchParams.get('place');
  const place: DrivePlace | null =
    section === 'Sync'
      ? 'synced'
      : section === 'My Drive' && isDrivePlace(placeParam)
        ? placeParam
        : null;
  const navSection = place ? 'My Drive' : section;
  // Places list devices first; `device` picks one, `folder` opens one of its folders.
  const deviceParam = place ? searchParams.get('device') : null;
  const sharedTab: SharedTab =
    pathname === '/sent' || searchParams.get('tab') === 'sent' ? 'Sent' : 'Received';
  const [transferPage, setTransferPage] = useState<{ tab: SharedTab; cursor?: string }>({
    tab: 'Received',
  });
  const transferCursor = transferPage.tab === sharedTab ? transferPage.cursor : undefined;
  const setTransferCursor = (cursor?: string) => setTransferPage({ tab: sharedTab, cursor });
  useEffect(() => {
    if (pathname === '/received' || pathname === '/sent')
      router.replace(sharedHref(pathname === '/sent' ? 'Sent' : 'Received'));
  }, [pathname, router]);
  // Backups moved into My Drive; old links open the same device there.
  const oldBackupsDevice = section === 'Backups' ? searchParams.get('device') : null;
  useEffect(() => {
    if (section === 'Backups')
      router.replace(
        placeHref(
          'backups',
          oldBackupsDevice && oldBackupsDevice !== 'all' ? oldBackupsDevice : null,
        ),
      );
  }, [section, oldBackupsDevice, router]);
  const authMode = (Object.keys(authRoutes) as AuthMode[]).find(
    (mode) => authRoutes[mode] === pathname,
  );
  const next = loginDestination(searchParams.get('next'));
  const parentId =
    (pathname === '/drive' && !place) || (place && deviceParam)
      ? searchParams.get('folder') || null
      : null;
  // Pages that browse folders with the drive file browser.
  const drivePage = (section === 'My Drive' && !place) || (!!place && !!parentId);
  const [query, setQuery] = useState('');
  const [driveReadOnly, setDriveReadOnly] = useState(true);
  const [grid, setGrid] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [modal, setModal] = useState<{
    mode: string;
    item?: DriveItem;
    items?: DriveItem[];
  } | null>(null);
  const [recipientKind, setRecipientKind] = useState<RecipientKind>('unknown');
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [mac, setMac] = useState(true);
  useEffect(() => setMac(/Mac|iPhone|iPad/.test(navigator.platform)), []);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [busy, setBusy] = useState(false);
  const [zipProgress, setZipProgress] = useState<ZipDownloadStatus | null>(null);
  const zipJob = useRef<AbortController | null>(null);
  useEffect(() => () => zipJob.current?.abort(), []);
  const [cursor, setCursor] = useState<string>();
  const [progress, setProgress] = useState<FileUpload[]>([]);
  const [online, setOnline] = useState(true);
  const jobs = useRef(new Map<string, UploadJob>());
  // Items this tab just uploaded, shown at once instead of refetching the folder per file.
  const [addedItems, setAddedItems] = useState<AddedItem[]>([]);
  const uploading = useRef(false);
  // Folders created for each batch of uploads, by path, so files in a folder share it.
  const batchFolders = useRef(new Map<string, Map<string, Promise<string>>>());
  const input = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  // Picks the file uploaded as a new version of `versionOf`.
  const versionInput = useRef<HTMLInputElement>(null);
  const versionOf = useRef<DriveItem | null>(null);
  const search = useRef<HTMLInputElement>(null);
  // While signed out, a focus refetch would flip the query back to pending and unmount the
  // sign-in form mid-entry (e.g. on returning from the email app with a code).
  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => api.me(),
    refetchOnWindowFocus: (query) => query.state.data !== undefined,
    refetchOnReconnect: (query) => query.state.data !== undefined,
  });
  const user = me.data?.user;
  const sessionEnd = useSessionEnd();
  useEffect(() => setSignedIn(!!user), [user?.id]);
  const updateAvailable = useUpdateAvailable(!!user);
  const [updateDismissed, setUpdateDismissed] = useState(false);
  const live = useLiveUpdates(api, user?.id);
  // Link this sign-in to the browser's key so the browser is listed once among devices.
  useEffect(() => {
    if (user) void registerBrowser(api.request, user.id).catch(() => {});
  }, [user?.id]);
  const activity = useActivityFeed(user?.id);
  useEffect(() => {
    if (!user) clearBrowserCaches();
  }, [user?.id]);
  // An ended session waits for the user to acknowledge the dialog before leaving the page.
  const needsLogin =
    !sessionEnd && me.error instanceof ApiError && [401, 403].includes(me.error.status);
  useAccountAppearance(needsLogin ? undefined : user?.id, api.request);
  useEffect(() => {
    if (user && (pathname === '/' || authMode)) router.replace(authMode ? next : '/drive');
    else if (needsLogin && !authMode) {
      const destination =
        pathname === '/drive'
          ? driveHref(parentId)
          : pathname === '/sync' || pathname === '/backups'
            ? `${pathname}${searchParams.size ? `?${searchParams}` : ''}`
            : section === 'Shared'
              ? sharedHref(sharedTab)
              : pathname === '/'
                ? '/drive'
                : pathname;
      router.replace(`/login?next=${encodeURIComponent(destination)}`);
    }
  }, [
    user,
    needsLogin,
    pathname,
    parentId,
    authMode,
    next,
    router,
    section,
    sharedTab,
    searchParams,
  ]);
  useEffect(() => {
    setQuery('');
    setSelected([]);
    setCursor(undefined);
    setError('');
    setModal(null);
    setTransferPage({ tab: sharedTab });
  }, [pathname, parentId, sharedTab]);
  const folderTrail = useQuery({
    queryKey: ['folder-trail', parentId],
    enabled: !!user && !!parentId,
    queryFn: ({ signal }) => loadFolderTrail(api, parentId!, signal),
  });
  const trail = parentId ? (folderTrail.data ?? [{ id: parentId, name: 'Folder' }]) : [];
  const fileSection = drivePage || section === 'Trash' || !!query;
  // Search results replace the page they were started from until the search is cleared.
  const searching = !!query && !drivePage && section !== 'Trash';
  const listingQuery = useDebouncedValue(query);
  const listing = useQuery<{ items: DriveItem[]; nextCursor: string | null }>({
    queryKey: ['files', section, parentId, listingQuery, cursor],
    enabled: !!user && (section === 'Trash' || (searching && !!listingQuery)),
    queryFn: () => {
      if (section === 'My Drive' && !listingQuery) return api.list(parentId, cursor);
      const params = new URLSearchParams({
        ...(listingQuery ? { q: listingQuery } : {}),
        ...(section === 'Trash' ? { trash: 'true' } : {}),
        ...(cursor ? { cursor } : {}),
      });
      return api.request('/v1/search?' + params);
    },
  });
  const transfers = useQuery<{ items: TransferView[]; nextCursor: string | null }>({
    queryKey: ['transfers', sharedTab, transferCursor],
    enabled: !!user && section === 'Shared',
    queryFn: () =>
      api.request(
        `/v1/transfers/${sharedTab.toLowerCase()}${transferCursor ? '?cursor=' + encodeURIComponent(transferCursor) : ''}`,
      ),
    // Pushed notifications refresh transfers at once; polling is only the fallback.
    refetchInterval: live ? false : 15000,
  });
  const shares = useQuery<{ items: any[] }>({
    queryKey: ['shares', sharedTab],
    enabled: !!user && section === 'Shared',
    queryFn: () => api.request(`/v1/shares/${sharedTab.toLowerCase()}`),
  });
  const devicePage = section === 'Devices' || !!place;
  // My Drive's root shows each place's total, so it needs the folders they hold.
  const placesShown = !!place || (section === 'My Drive' && !parentId);
  const devices = useQuery<{ items: Device[] }>({
    queryKey: ['devices'],
    enabled: !!user && devicePage,
    queryFn: () => api.request('/v1/devices'),
  });
  // Always loaded: the sidebar reports backups that need attention.
  const backups = useQuery<{ items: BackupRoot[] }>({
    queryKey: ['backups'],
    enabled: !!user,
    queryFn: () => api.request('/v1/backups'),
  });
  const syncFolders = useQuery<{ items: SyncFolderItem[] }>({
    queryKey: ['sync-folders'],
    enabled: !!user && (placesShown || section === 'My Drive' || section === 'Devices'),
    queryFn: () => api.request('/v1/sync/folders'),
  });
  // The open folder is a backup's top folder: show its status and controls above the files.
  const backupFolder =
    !!parentId && !!backups.data?.items.some((root) => root.remoteRootDriveItemId === parentId);
  const syncedFolder = parentId
    ? syncFolders.data?.items.find((folder) => folder.id === parentId)
    : undefined;
  const failing = (backups.data?.items ?? []).filter((root) => root.state === 'ERROR');
  const folderActivity: FolderActivity | null = failing.length
    ? {
        tone: 'error',
        label:
          failing.length === 1
            ? `${failing[0].localPathDisplayName} needs attention`
            : `${failing.length} backups need attention`,
      }
    : null;
  const openActivity = () => router.push(placeHref('backups'));
  const groups = place
    ? placeGroups(place, devices.data?.items ?? [], syncFolders.data?.items, backups.data?.items)
    : [];
  const usageIds = placesShown
    ? drivePlaceOrder.flatMap((target) =>
        placeFolderIds(target, syncFolders.data?.items, backups.data?.items),
      )
    : [];
  const folderUsage = useQuery<UsageMap>({
    queryKey: ['folder-usage', [...new Set(usageIds)].sort().join(',')],
    enabled: !!user && usageIds.length > 0,
    staleTime: 60_000,
    placeholderData: (previous) => previous,
    queryFn: ({ signal }) => loadUsage(api.request, usageIds, signal),
  });
  const placeGroup = groups.find((entry) => entry.key === deviceParam);
  // My Drive › place › device, ahead of the open folder's own path.
  const placeCrumbs = place && (
    <>
      <ChevronRight size={14} />
      <Link
        href={placeHref(place)}
        onNavigate={resetPage}
        aria-current={!deviceParam ? 'location' : undefined}
      >
        {drivePlaces[place].name}
      </Link>
      {deviceParam && (
        <>
          <ChevronRight size={14} />
          <Link
            href={placeHref(place, deviceParam)}
            onNavigate={resetPage}
            aria-current={!parentId ? 'location' : undefined}
          >
            {placeGroup?.name ?? 'Device'}
          </Link>
        </>
      )}
    </>
  );
  // Always loaded so the bell can show unread notifications; pushed hints refresh it.
  const notices = useQuery<{ items: ServerNotification[] }>({
    queryKey: ['notifications'],
    enabled: !!user,
    refetchInterval: live ? false : 60_000,
    queryFn: () => api.request('/v1/notifications'),
  });
  const notifications = newestFirst(notices.data?.items ?? []);
  const unreadNotices = notifications.filter((n) => !n.readAt);
  async function readNotices(ids: string[]) {
    await Promise.all(
      ids.map((id) => api.request(`/v1/notifications/${id}/read`, { method: 'POST' })),
    );
    await cache.invalidateQueries({ queryKey: ['notifications'] });
  }
  function openNotice(n: ServerNotification) {
    if (!n.readAt) void readNotices([n.id]).catch((e: Error) => setError(e.message));
    const { href } = describeNotification(n);
    if (href) {
      resetPage();
      router.push(href);
    }
  }
  const markAllRead = () =>
    void readNotices(unreadNotices.map((n) => n.id)).catch((e: Error) => setError(e.message));
  const versions = useQuery<{ items: any[] }>({
    queryKey: ['versions', modal?.item?.id],
    enabled: modal?.mode === 'versions',
    queryFn: () => api.request(`/v1/drive/items/${modal!.item!.id}/versions`),
  });
  const trashChanges = useOptimisticRemoval(
    listing.data?.items ?? [],
    user?.id ?? 'anonymous',
    setError,
    async () => {
      await refresh();
    },
  );
  const files = trashChanges.items;
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(''), 4500);
    return () => clearTimeout(id);
  }, [toast]);
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        search.current?.focus();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'u') {
        e.preventDefault();
        if (!drivePage || !driveReadOnly) input.current?.click();
      }
      // The drive file browser handles its own selection shortcuts.
      if (drivePage) return;
      if (
        (e.target as HTMLElement).closest?.(
          'input, textarea, select, [contenteditable], [role="dialog"], [role="menu"]',
        )
      )
        return;
      if (e.key === 'Escape') setSelected([]);
      const chosen = files.filter((f) => selected.includes(f.id));
      const manage = chosen.every((f) => itemAccess(f).manage);
      if (e.key === 'F2' && chosen.length === 1 && section !== 'Trash' && manage)
        setModal({ mode: 'rename', item: chosen[0] });
      if (e.key === 'Delete' && chosen.length) {
        if (section === 'Trash') setModal({ mode: 'permanent', items: chosen });
        else if (chosen.length === 1 && manage) setModal({ mode: 'trash', item: chosen[0] });
      }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [selected, files, section, driveReadOnly, drivePage]);
  // The Drive view reloads when this changes; it follows live hints itself, so those skip it.
  const [driveRefresh, setDriveRefresh] = useState(0);
  const refresh = async (reloadDrive = true) => {
    if (reloadDrive) setDriveRefresh((value) => value + 1);
    const browser = browserSession(api.request, user?.id ?? 'anonymous');
    browser.data.clear();
    browser.views.clear();
    await Promise.all(
      [
        'files',
        'folder-trail',
        'me',
        'transfers',
        'shares',
        'devices',
        'backups',
        'sync-folders',
        'notifications',
      ].map((k) => cache.invalidateQueries({ queryKey: [k] })),
    );
  };
  // A pushed hint only refreshes what can change often; folder catalogs refresh lazily.
  const refreshLive = () =>
    Promise.all(
      ['files', 'folder-trail', 'me', 'transfers', 'shares', 'notifications'].map((k) =>
        cache.invalidateQueries({ queryKey: [k] }),
      ),
    );
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const refreshLiveRef = useRef(refreshLive);
  refreshLiveRef.current = refreshLive;
  useEffect(
    () =>
      onLive((message) => {
        // This tab's own uploads cause most hints while they run; one refresh follows them.
        if (message.type === 'changes') {
          if (!uploading.current) void refreshLiveRef.current();
        } else
          for (const key of ['notifications', 'transfers', 'shares'])
            void cache.invalidateQueries({ queryKey: [key] });
      }),
    [cache],
  );
  async function act(fn: () => Promise<unknown>, message?: string) {
    setError('');
    setBusy(true);
    try {
      await fn();
      await refresh();
      if (message) setToast(message);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  function resetPage() {
    setTransferPage({ tab: 'Received' });
    setQuery('');
    setSelected([]);
    setCursor(undefined);
    setError('');
    setModal(null);
    setConfirmation(null);
  }
  function navigate(name: WorkspaceSection) {
    resetPage();
    router.push(workspaceRoutes[name]);
  }
  function open(item: DriveItem) {
    if (item.type === 'FOLDER') {
      resetPage();
      router.push(place ? placeHref(place, deviceParam, item.id) : driveHref(item.id));
    } else setModal({ mode: 'preview', item });
  }
  async function download(data: {
    driveItemId?: string;
    versionId?: string;
    transferId?: string;
    entryId?: string;
  }) {
    await act(async () => {
      const r = await api.download(data);
      const a = document.createElement('a');
      a.href = r.downloadUrl;
      a.rel = 'noreferrer';
      a.download = '';
      document.body.append(a);
      a.click();
      a.remove();
    });
  }
  async function downloadFolder(item: DriveItem) {
    if (zipJob.current) return;
    const controller = new AbortController();
    zipJob.current = controller;
    setError('');
    setZipProgress({
      name: item.name,
      phase: 'queued',
      files: 0,
      bytes: 0,
      currentFile: null,
      fileBytes: 0,
      fileSize: null,
    });
    try {
      const saved = await downloadFolderZip(api, item, controller.signal, (progress) =>
        setZipProgress({ name: item.name, ...progress }),
      );
      if (saved) setToast(`${item.name}.zip download started. Check your browser’s downloads.`);
    } catch (error) {
      if (!controller.signal.aborted) setError((error as Error).message);
    } finally {
      zipJob.current = null;
      setZipProgress(null);
    }
  }
  function setUpload(key: string, change: Partial<FileUpload>) {
    setProgress((old) => old.map((u) => (u.key === key ? { ...u, ...change } : u)));
  }
  async function uploadParent(job: UploadJob) {
    const created = batchFolders.current.get(job.batch) ?? new Map<string, Promise<string>>();
    batchFolders.current.set(job.batch, created);
    let parent = job.base;
    let path = '';
    for (const name of job.folders) {
      path += '/' + name;
      if (!created.has(path)) {
        const pending = api.createFolder(name, parent).then(({ item }) => {
          addItem(item);
          return item.id;
        });
        created.set(path, pending);
        pending.catch(() => created.delete(path));
      }
      parent = await created.get(path)!;
    }
    return parent;
  }
  async function startUpload(key: string) {
    const job = jobs.current.get(key);
    if (!user || !job || job.stopped || job.running) return;
    job.running = true;
    try {
      job.parent ??= await uploadParent(job);
      const upload = new BrowserUpload(api, user.id);
      job.upload = upload;
      const item = await upload.run(
        job.file,
        job.parent,
        ({ loaded, phase, error }) => setUpload(key, { loaded, phase, error }),
        job.target,
      );
      jobs.current.delete(key);
      addItem(item);
    } catch (e) {
      if ((e as Error).name === 'AbortError') setUpload(key, { phase: 'paused' });
      else {
        // A taken name, or a file that changed under a replace, offers Replace or Keep both.
        const conflict =
          job.target?.kind === 'replace'
            ? e instanceof ApiError && e.code === 'REVISION_CONFLICT'
              ? 'file'
              : undefined
            : isNameConflict(e) && job.parent !== undefined
              ? (await findByName(job.parent ?? null, job.file.name).catch(() => undefined))
                  ?.type === 'FOLDER'
                ? 'folder'
                : 'file'
              : undefined;
        setUpload(key, { phase: 'failed', error: uploadErrorMessage(e), conflict });
      }
    } finally {
      job.running = false;
      pumpUploads();
    }
  }
  /** The item in `parent` whose name matches, the way the server compares names. */
  async function findByName(parent: string | null, name: string) {
    const wanted = name.normalize('NFC').toLowerCase();
    let cursor: string | undefined;
    do {
      const page = await api.list(parent, cursor);
      const found = page.items.find((item) => item.name.normalize('NFC').toLowerCase() === wanted);
      if (found) return found;
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
  }
  async function replaceUploads(keys: string[]) {
    await Promise.all(
      keys.map(async (key) => {
        const job = jobs.current.get(key);
        if (!job) return;
        // Always the latest revision, so a replace that lost a race can simply be tried again.
        const existing: DriveItem | undefined = await (
          job.target?.kind === 'replace'
            ? api.request(`/v1/drive/items/${job.target.item.id}`).then((r) => r.item)
            : findByName(job.parent ?? null, job.file.name)
        ).catch(() => undefined);
        if (existing?.type !== 'FILE') {
          setUpload(key, {
            conflict: existing ? 'folder' : undefined,
            error: existing
              ? 'A folder has this name, so it can’t be replaced. Keep both instead.'
              : 'The file to replace is gone. Retry to upload it.',
          });
          if (!existing) job.target = undefined;
          return;
        }
        job.target = { kind: 'replace', item: existing };
        setUpload(key, { conflict: undefined });
        resumeUploads([key]);
      }),
    );
  }
  function keepBothUploads(keys: string[]) {
    for (const key of keys) {
      const job = jobs.current.get(key);
      if (job) job.target = { kind: 'keep-both' };
      setUpload(key, { conflict: undefined });
    }
    resumeUploads(keys);
  }
  function addItem(item: DriveItem) {
    setAddedItems((old) => [
      ...old.filter((entry) => entry.id !== item.id).slice(-499),
      { ...item, addedAt: Date.now() },
    ]);
  }
  // Starts queued files, oldest first, until UPLOAD_SLOTS are busy.
  function pumpUploads() {
    let free = UPLOAD_SLOTS - [...jobs.current.values()].filter((j) => j.running).length;
    for (const [key, job] of jobs.current) {
      if (free <= 0) break;
      if (!job.queued || job.stopped || job.running) continue;
      job.queued = false;
      free--;
      void startUpload(key);
    }
    // Refresh once when the queue empties: storage use, sync status and other devices' changes.
    const active = [...jobs.current.values()].some((j) => j.running || j.queued);
    if (uploading.current && !active) void refreshRef.current();
    uploading.current = active;
  }
  async function uploadFiles(files: FileList | File[] | null, folder = false) {
    if (!files) return;
    await uploadEntries(
      Array.from(files, (file) => ({
        file,
        folders:
          folder && file.webkitRelativePath ? file.webkitRelativePath.split('/').slice(0, -1) : [],
      })),
    );
  }
  async function uploadEntries(
    entries: UploadEntry[],
    target?: UploadTarget,
    base: string | null = parentId,
  ) {
    const batch = crypto.randomUUID();
    const queued = entries.map(({ file, folders }, i): FileUpload => {
      const key = `${batch}/${i}`;
      jobs.current.set(key, { file, folders, batch, base, target, queued: true });
      return {
        key,
        name: file.name,
        size: file.size,
        loaded: 0,
        phase: 'queued',
        ...(folders.length ? { group: { key: `${batch}/${folders[0]}`, name: folders[0] } } : {}),
      };
    });
    setProgress((old) => [...old, ...queued]);
    pumpUploads();
  }
  function pauseUploads(keys: string[]) {
    for (const key of keys) {
      const job = jobs.current.get(key);
      if (!job) continue;
      job.stopped = true;
      if (job.running) job.upload?.pause();
      else setUpload(key, { phase: 'paused' });
    }
  }
  function resumeUploads(keys: string[]) {
    const waiting = keys.filter((key) => jobs.current.has(key));
    for (const key of waiting) {
      const job = jobs.current.get(key)!;
      // A file still winding down from a pause is picked up again when its slot frees.
      job.stopped = false;
      job.queued = true;
      setUpload(key, { phase: 'queued', error: undefined });
    }
    pumpUploads();
  }
  function cancelUploads(keys: string[]) {
    const cancelled = new Set(keys);
    const pending = keys.map((key) => {
      const job = jobs.current.get(key);
      jobs.current.delete(key);
      if (!job) return;
      job.stopped = true;
      return job.upload?.cancel();
    });
    setProgress((old) => old.filter((u) => !cancelled.has(u.key)));
    void Promise.all(pending).catch((e: Error) => setError(e.message));
  }
  function dismissUploads() {
    const finished = finishedKeys(progress);
    // Failed uploads still hold reserved storage until they're cancelled on the server.
    const pending = [...finished].map((key) => {
      const job = jobs.current.get(key);
      jobs.current.delete(key);
      return job?.upload?.cancel();
    });
    setProgress((old) => old.filter((u) => !finished.has(u.key)));
    void Promise.all(pending).catch((e: Error) => setError(e.message));
  }
  const uploadsRunning = progress.some((u) => ['queued', 'hashing', 'uploading'].includes(u.phase));
  useEffect(() => {
    if (!uploadsRunning) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [uploadsRunning]);
  useEffect(() => {
    // Leaving the page abandons unfinished uploads; release their storage instead of holding it a day.
    const release = (e: PageTransitionEvent) => {
      if (e.persisted) return;
      for (const job of jobs.current.values()) {
        const upload = job.upload;
        if (!upload?.uploadId) continue;
        upload.pause();
        if (upload.resumeKey) localStorage.removeItem(upload.resumeKey);
        void fetch(`/api/v1/uploads/${upload.uploadId}`, {
          method: 'DELETE',
          keepalive: true,
        }).catch(() => {});
      }
    };
    window.addEventListener('pagehide', release);
    return () => window.removeEventListener('pagehide', release);
  }, []);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const values = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    const item = modal?.item;
    const targets = modal?.items ?? (item ? [item] : []);
    if (modal?.mode === 'permanent' && targets.length) {
      setModal(null);
      setSelected([]);
      await Promise.all(
        targets.map((target) =>
          trashChanges.remove([target], () =>
            api.request(`/v1/drive/items/${target.id}/permanent`, {
              method: 'DELETE',
              body: { ...operation(), baseRevision: target.revision },
            }),
          ),
        ),
      );
      return;
    }
    const mode = modal?.mode;
    const result = await act(
      async () => {
        switch (modal?.mode) {
          case 'folder':
            await api.createFolder(values.name, parentId);
            break;
          case 'rename':
            await api.request(`/v1/drive/items/${item!.id}`, {
              method: 'PATCH',
              body: { ...operation(), baseRevision: item!.revision, name: values.name },
            });
            break;
          case 'move':
            await api.request(`/v1/drive/items/${item!.id}/move`, {
              method: 'POST',
              body: {
                ...operation(),
                baseRevision: item!.revision,
                parentId: values.parentId || null,
              },
            });
            break;
          case 'send':
          case 'share': {
            const recipient = {
              type:
                values.recipient.includes('@') && !values.recipient.startsWith('@')
                  ? 'EMAIL'
                  : 'USERNAME',
              value: values.recipient.replace(/^@/, ''),
            };
            await api.request(modal.mode === 'send' ? '/v1/transfers' : '/v1/shares', {
              method: 'POST',
              body: {
                ...operation(),
                recipient,
                ...(modal.mode === 'send'
                  ? {
                      items: (selected.length ? selected : [item!.id]).map((driveItemId) => ({
                        driveItemId,
                      })),
                    }
                  : { driveItemId: item!.id, permission: values.permission ?? 'VIEWER' }),
              },
            });
            break;
          }
          case 'trash':
            await api.request(`/v1/drive/items/${item!.id}`, {
              method: 'DELETE',
              body: { ...operation(), baseRevision: item!.revision },
            });
            break;
          case 'empty-trash':
            await api.emptyTrash();
            setCursor(undefined);
            break;
          case 'permanent':
            await api.request(`/v1/drive/items/${item!.id}/permanent`, {
              method: 'DELETE',
              body: { ...operation(), baseRevision: item!.revision },
            });
            break;
        }
      },
      mode === 'send'
        ? recipientKind === 'invite'
          ? 'Invitation sent. They’ll see your files after signing up.'
          : 'Sent. Your recipient will see it after signing in.'
        : mode === 'share'
          ? 'Access shared.'
          : mode === 'folder'
            ? 'Folder created.'
            : mode === 'rename'
              ? 'Renamed.'
              : mode === 'move'
                ? 'Moved.'
                : mode === 'trash'
                  ? 'Moved to trash.'
                  : mode === 'empty-trash'
                    ? 'Trash emptied.'
                    : 'Changes saved.',
    );
    if (result) {
      setModal(null);
      setSelected([]);
    }
  }
  async function toggleFavorite(item: DriveItem) {
    await act(() =>
      api.request(`/v1/drive/items/${item.id}/favorite`, {
        method: item.favorite ? 'DELETE' : 'PUT',
        body: { ...operation(), baseRevision: item.revision },
      }),
    );
  }
  function restore(targets: DriveItem[]) {
    setSelected([]);
    return Promise.all(
      targets.map((item) =>
        trashChanges.remove([item], async () => {
          try {
            const { item: restored } = await api.request(`/v1/drive/items/${item.id}/restore`, {
              method: 'POST',
              body: { ...operation(), baseRevision: item.revision },
            });
            // The server puts an item whose folder is gone back at the top of My Drive.
            if (item.parentId && !restored?.parentId)
              setToast(`Restored “${item.name}” to My Drive because its folder is gone.`);
          } catch (e) {
            if (isNameConflict(e))
              throw new Error(
                `“${item.name}” can’t be restored because its folder already has an item with that name. Rename or move that item, then restore again.`,
              );
            throw e;
          }
        }),
      ),
    );
  }
  async function transferAction(t: Transfer, action: string) {
    // Declining or cancelling cannot be undone, so ask first.
    if (action === 'decline' || action === 'cancel') {
      setConfirmation({
        title: action === 'decline' ? 'Decline this transfer?' : 'Cancel this transfer?',
        description:
          action === 'decline'
            ? 'You won’t be able to download these files unless they are sent again.'
            : 'The recipient will no longer be able to accept or download these files.',
        label: action === 'decline' ? 'Decline transfer' : 'Cancel transfer',
        done: action === 'decline' ? 'Transfer declined.' : 'Transfer cancelled.',
        run: () =>
          api.request(`/v1/transfers/${t.id}/${action}`, { method: 'POST', body: operation() }),
      });
      return;
    }
    await act(
      () =>
        api.request(`/v1/transfers/${t.id}/${action}`, {
          method: 'POST',
          body: { ...operation(), ...(action === 'save' ? { targetParentId: null } : {}) },
        }),
      action === 'save'
        ? 'Saving to My Drive. Large folders finish in the background.'
        : 'Transfer accepted. You can now download or save the files.',
    );
  }
  if (me.isPending) return <WorkspaceSkeleton />;
  if (!user) {
    if (me.isError && !needsLogin)
      return (
        <main className="loading-screen">
          <Cloud size={36} />
          <h2>We couldn’t reach your drive.</h2>
          <p>{me.error.message}</p>
          <Button onClick={() => void me.refetch()}>Try again</Button>
        </main>
      );
    if (!authMode) return <WorkspaceSkeleton />;
    return (
      <AuthPage
        api={api}
        mode={authMode}
        onDone={() => {
          cache.clear();
          clearBrowserCaches();
          void me.refetch();
        }}
      />
    );
  }
  if (authMode || pathname === '/') return <WorkspaceSkeleton />;
  const usage = me.data!.storage;
  const pageError =
    error ||
    (listing.error as Error)?.message ||
    (transfers.error as Error)?.message ||
    (shares.error as Error)?.message ||
    (devices.error as Error)?.message;
  return (
    <div className="app-shell">
      <a className="skip-to-content" href="#workspace-content">
        Skip to content
      </a>
      <aside className="sidebar">
        <Link className="brand" href="/drive" onNavigate={resetPage} aria-label="harbor0 home">
          <BrandLogo />
        </Link>
        <Button
          onClick={() => input.current?.click()}
          disabled={drivePage && driveReadOnly}
          className="upload-button"
          aria-label="Upload files"
        >
          <Plus />
          <span className="upload-label">Upload files</span>
        </Button>
        <nav aria-label="Main navigation">
          {navigation.map(({ name, icon: Icon }) => (
            <Link
              href={workspaceRoutes[name as WorkspaceSection]}
              onNavigate={resetPage}
              key={name}
              aria-label={name}
              title={name}
              className={`nav-item ${navSection === name ? 'active' : ''} ${name === 'Devices' ? 'nav-separated' : ''}`}
              aria-current={navSection === name ? 'page' : undefined}
            >
              <Icon aria-hidden="true" />
              <span>{name}</span>
            </Link>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <FolderActivityStatus activity={folderActivity} onOpen={openActivity} />
          <StorageIndicator storage={usage} onManage={() => navigate('Storage')} />
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <Link
            className="brand topbar-brand"
            href="/drive"
            onNavigate={resetPage}
            aria-label="harbor0 home"
          >
            <BrandLogo />
          </Link>
          <InputGroup className="search-box" icon={<Search aria-hidden="true" />}>
            <Input
              ref={search}
              type="search"
              aria-label="Search files"
              placeholder={section === 'Trash' ? 'Search Trash' : 'Search your files'}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setCursor(undefined);
                setSelected([]);
              }}
            />
            {!query && <kbd>{mac ? '⌘ K' : 'Ctrl K'}</kbd>}
          </InputGroup>
          <div className="topbar-right">
            <span className="topbar-theme">
              <ThemeToggle />
            </span>
            <ActivityNotifications
              feed={activity}
              onAllNotifications={() => navigate('Notifications')}
              notices={unreadNotices.map((n) => ({
                id: n.id,
                title: describeNotification(n).title,
                time: n.createdAt,
              }))}
              onOpenNotice={(id) => {
                const n = unreadNotices.find((entry) => entry.id === id);
                if (n) openNotice(n);
              }}
              onMarkAllRead={markAllRead}
            />
            <AccountMenu
              user={user}
              storage={usage}
              onNavigate={navigate}
              onSignOut={() =>
                void act(async () => {
                  setSignedIn(false);
                  await api.request('/v1/auth/logout', { method: 'POST', body: {} });
                  cache.clear();
                  clearBrowserCaches();
                  window.location.reload();
                })
              }
            />
          </div>
        </header>
        <main
          id="workspace-content"
          tabIndex={-1}
          className={`workspace ${drivePage ? 'drive-page' : ''}`}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            // Files dropped outside a writable folder are ignored instead of landing in the root.
            e.preventDefault();
            if (drivePage && !driveReadOnly)
              void readDroppedFiles(e.dataTransfer).then(uploadEntries);
          }}
        >
          <div className="page-alerts">
            {!online && (
              <Alert tone="warning">
                You’re offline. Changes will sync when your connection returns.
              </Alert>
            )}
            {updateAvailable && !updateDismissed && (
              <Alert
                tone="info"
                className="banner"
                action={
                  <Button variant="link" onClick={() => window.location.reload()}>
                    Reload
                  </Button>
                }
                dismissLabel="Dismiss update notice"
                onDismiss={() => setUpdateDismissed(true)}
              >
                A new version of harbor0 is available.
              </Alert>
            )}
            {pageError && !sessionEnd && (
              <Alert
                tone="error"
                className="banner"
                dismissLabel="Dismiss error"
                onDismiss={() => setError('')}
              >
                {pageError}
              </Alert>
            )}
          </div>
          {zipProgress && (
            <ZipDownloadStatusPanel
              progress={zipProgress}
              onCancel={() => zipJob.current?.abort()}
            />
          )}
          {!drivePage && !(place && !searching) && (
            <div className={`page-heading ${section === 'Shared' ? 'shared-heading' : ''}`}>
              <div>
                <h1>{searching ? 'Search results' : section}</h1>
                {query && (
                  <p className="muted">
                    {section === 'Trash' ? 'Items in Trash' : 'Files'} matching “{query}”
                  </p>
                )}
              </div>
              {query && (
                <div className="heading-actions">
                  <Button
                    variant="outline"
                    onClick={() => {
                      setQuery('');
                      setCursor(undefined);
                      setSelected([]);
                    }}
                  >
                    <X />
                    Clear search
                  </Button>
                </div>
              )}
            </div>
          )}
          {drivePage && (
            <DriveWorkspace
              key={place ?? section}
              title="My Drive"
              pinned={
                place
                  ? undefined
                  : drivePlacePins(
                      (target) => router.push(placeHref(target)),
                      placeSizes(syncFolders.data?.items, backups.data?.items, folderUsage.data),
                    )
              }
              showFolderUsage={!!place}
              header={
                backupFolder ? (
                  <BackupFolderPanel
                    key={parentId}
                    api={api}
                    folderId={parentId!}
                    onChanged={() => void backups.refetch()}
                  />
                ) : (
                  syncedFolder && (
                    <SyncedFolderPanel
                      key={parentId}
                      request={api.request}
                      folder={syncedFolder}
                      userId={user.id}
                    />
                  )
                )
              }
              onActivity={activity.publish}
              request={api.request}
              parentId={parentId}
              trail={trail}
              query={query}
              onClearSearch={() => setQuery('')}
              userId={user.id}
              storage={usage}
              refreshKey={driveRefresh}
              addedItems={addedItems}
              holdLive={() => uploading.current}
              breadcrumbs={
                <>
                  <Link href="/drive" onNavigate={resetPage}>
                    My Drive
                  </Link>
                  {placeCrumbs}
                  {trail.map((t) => (
                    <span key={t.id}>
                      <ChevronRight size={14} />
                      <Link
                        href={place ? placeHref(place, deviceParam, t.id) : driveHref(t.id)}
                        onNavigate={resetPage}
                        aria-current={t.id === parentId ? 'location' : undefined}
                      >
                        {t.name}
                      </Link>
                    </span>
                  ))}
                  {parentId && folderTrail.isError && (
                    <Button variant="link" onClick={() => void folderTrail.refetch()}>
                      Retry folder path
                    </Button>
                  )}
                </>
              }
              onOpen={open}
              onSyncRemoved={() =>
                place ? router.push(placeHref(place, deviceParam)) : navigate('My Drive')
              }
              onRoot={() =>
                place ? router.push(placeHref(place, deviceParam)) : navigate('My Drive')
              }
              onReadOnlyChange={setDriveReadOnly}
              onUpload={() => input.current?.click()}
              onUploadFolder={() => folderInput.current?.click()}
              onUploadVersion={(item) => {
                versionOf.current = item;
                versionInput.current?.click();
              }}
              onDropFiles={(entries) => uploadEntries(entries)}
              onDownload={async (item, versionId) => {
                if (item.type === 'FOLDER') await downloadFolder(item);
                else await download({ driveItemId: item.id, ...(versionId ? { versionId } : {}) });
              }}
              onChanged={() => void refresh(false)}
              onManageStorage={() => navigate('Storage')}
            />
          )}
          {fileSection && !drivePage && (
            <>
              <div className="file-toolbar">
                <div className="breadcrumbs">
                  <Badge className="count">
                    {listing.isPending
                      ? 'Loading…'
                      : listing.isError && !files.length
                        ? 'Unavailable'
                        : `${files.length} ${files.length === 1 ? 'item' : 'items'}${cursor || listing.data?.nextCursor ? ' on this page' : ''}`}
                  </Badge>
                </div>
                <div className="file-toolbar-actions">
                  {section === 'Trash' && (
                    <Button
                      variant="outline"
                      disabled={
                        busy ||
                        listing.isPending ||
                        listing.isError ||
                        (!files.length && !cursor && !listing.data?.nextCursor && !query)
                      }
                      onClick={() => setModal({ mode: 'empty-trash' })}
                    >
                      <Trash2 />
                      Empty Trash
                    </Button>
                  )}
                  <Segmented
                    label="View"
                    className="view-switch"
                    value={grid ? 'grid' : 'list'}
                    onValueChange={(view) => setGrid(view === 'grid')}
                    options={[
                      { value: 'list', label: 'List view', icon: <List />, iconOnly: true },
                      { value: 'grid', label: 'Grid view', icon: <LayoutGrid />, iconOnly: true },
                    ]}
                  />
                </div>
              </div>
              {selected.length > 0 && (
                <div className="selection-bar">
                  <span aria-live="polite">{selected.length} selected</span>
                  {section === 'Trash' ? (
                    <>
                      <Button
                        size="sm"
                        onClick={() => void restore(files.filter((f) => selected.includes(f.id)))}
                      >
                        <RotateCcw />
                        Restore
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          setModal({
                            mode: 'permanent',
                            items: files.filter((f) => selected.includes(f.id)),
                          })
                        }
                      >
                        <Trash2 />
                        Delete permanently
                      </Button>
                    </>
                  ) : (
                    files.every((f) => !selected.includes(f.id) || itemAccess(f).share) && (
                      <Button
                        size="sm"
                        onClick={() =>
                          setModal({ mode: 'send', item: files.find((f) => f.id === selected[0]) })
                        }
                      >
                        <Send />
                        Send
                      </Button>
                    )
                  )}
                  <Button variant="ghost" size="sm" onClick={() => setSelected([])}>
                    Clear
                  </Button>
                </div>
              )}
              {listing.isPending ? (
                <FileCollectionSkeleton grid={grid} />
              ) : listing.isError && !files.length ? (
                <FileLoadError onRetry={() => void listing.refetch()} />
              ) : files.length === 0 ? (
                <FileEmptyState
                  section={section}
                  search={!!query}
                  inFolder={!!parentId}
                  busy={busy}
                  onUpload={() => input.current?.click()}
                  onCreateFolder={() => setModal({ mode: 'folder' })}
                  onBrowse={() => navigate('My Drive')}
                  onClearSearch={() => {
                    setQuery('');
                    setCursor(undefined);
                    setSelected([]);
                  }}
                />
              ) : (
                <FileCollection
                  items={files}
                  userId={user.id}
                  grid={grid}
                  trash={section === 'Trash'}
                  selected={selected}
                  onSelectionChange={setSelected}
                  onOpen={open}
                  refreshing={listing.isFetching}
                  renderActions={(item) => (
                    <ActionsMenu label={`Actions for ${item.name}`}>
                      {section === 'Trash' ? (
                        <>
                          <MenuItem onClick={() => void restore([item])}>Restore</MenuItem>
                          <MenuItem
                            tone="danger"
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
                            disabled={busy || !!zipProgress}
                            onClick={() =>
                              void (item.type === 'FOLDER'
                                ? downloadFolder(item)
                                : download({ driveItemId: item.id }))
                            }
                          >
                            {item.type === 'FOLDER' ? 'Download as ZIP' : 'Download'}
                          </MenuItem>
                          {itemAccess(item).share && (
                            <>
                              <MenuItem onClick={() => setModal({ mode: 'send', item })}>
                                Send to someone
                              </MenuItem>
                              {!item.backupRootId && (
                                <MenuItem onClick={() => setModal({ mode: 'share', item })}>
                                  Share access
                                </MenuItem>
                              )}
                            </>
                          )}
                          {item.type === 'FILE' && itemAccess(item).edit && (
                            <MenuItem
                              onClick={() => {
                                versionOf.current = item;
                                versionInput.current?.click();
                              }}
                            >
                              Upload new version
                            </MenuItem>
                          )}
                          <MenuSeparator />
                          <MenuItem onClick={() => setModal({ mode: 'details', item })}>
                            File details
                          </MenuItem>
                          {itemAccess(item).manage && (
                            <>
                              <MenuItem onClick={() => setModal({ mode: 'rename', item })}>
                                Rename
                              </MenuItem>
                              <MenuItem onClick={() => setModal({ mode: 'move', item })}>
                                Move
                              </MenuItem>
                            </>
                          )}
                          {itemAccess(item).share && (
                            <MenuItem onClick={() => void toggleFavorite(item)}>
                              {item.favorite ? 'Remove favorite' : 'Add to favorites'}
                            </MenuItem>
                          )}
                          {item.type === 'FILE' && (
                            <MenuItem onClick={() => setModal({ mode: 'versions', item })}>
                              Version history
                            </MenuItem>
                          )}
                          {itemAccess(item).manage && (
                            <>
                              <MenuSeparator />
                              <MenuItem
                                tone="danger"
                                onClick={() => setModal({ mode: 'trash', item })}
                              >
                                Move to trash
                              </MenuItem>
                            </>
                          )}
                        </>
                      )}
                    </ActionsMenu>
                  )}
                />
              )}

              {(cursor || listing.data?.nextCursor) && (
                <div className="file-pagination">
                  {cursor && (
                    <Button
                      variant="outline"
                      onClick={() => {
                        setSelected([]);
                        setCursor(undefined);
                      }}
                    >
                      First page
                    </Button>
                  )}
                  {listing.data?.nextCursor && (
                    <Button
                      variant="outline"
                      onClick={() => {
                        setSelected([]);
                        setCursor(listing.data!.nextCursor!);
                      }}
                    >
                      Next page
                    </Button>
                  )}
                </div>
              )}
            </>
          )}
          {section === 'Shared' && !searching && (
            <SharedTabs
              tab={sharedTab}
              onChange={(tab) => {
                setTransferPage({ tab });
                router.push(sharedHref(tab), { scroll: false });
              }}
            >
              <div className="transfer-list">
                {sharedTab === 'Received' && <SyncInvitations request={api.request} />}
                {transfers.isPending ? (
                  <ContentSkeleton label="Loading transfers" />
                ) : transfers.isError && !transfers.data?.items.length ? (
                  <LoadError onRetry={() => void transfers.refetch()} />
                ) : !transfers.data?.items.length ? (
                  <EmptyState
                    icon={sharedTab === 'Received' ? <Inbox /> : <Send />}
                    title={sharedTab === 'Received' ? 'No received files' : 'No sent files'}
                    description={
                      sharedTab === 'Received'
                        ? `People can send files directly to @${user.username}.`
                        : 'Choose a file in My Drive and select Send from its menu to share it directly with someone.'
                    }
                    actions={
                      <Button variant="outline" onClick={() => navigate('My Drive')}>
                        Browse My Drive
                      </Button>
                    }
                  />
                ) : (
                  <TransferTable
                    transfers={transfers.data.items}
                    direction={sharedTab}
                    busy={busy}
                    onAction={transferAction}
                    onDownload={(t, entry) => download({ transferId: t.id, entryId: entry.id })}
                    loadEntries={(id, cursor) =>
                      api.request(`/v1/transfers/${id}/items?cursor=${encodeURIComponent(cursor)}`)
                    }
                  />
                )}
                {(transferCursor || transfers.data?.nextCursor) && (
                  <div className="file-pagination">
                    {transferCursor && (
                      <Button variant="outline" onClick={() => setTransferCursor(undefined)}>
                        First page
                      </Button>
                    )}
                    {transfers.data?.nextCursor && (
                      <Button
                        variant="outline"
                        onClick={() => setTransferCursor(transfers.data!.nextCursor!)}
                      >
                        Next page
                      </Button>
                    )}
                  </div>
                )}
              </div>
              {(shares.isPending || shares.isError || !!shares.data?.items.length) && (
                <Card title="Shared access">
                  {shares.isPending ? (
                    <ContentSkeleton label="Loading shared files" />
                  ) : shares.isError && !shares.data?.items.length ? (
                    <LoadError onRetry={() => void shares.refetch()} />
                  ) : (
                    shares.data?.items.map((s) => (
                      <article className="list-row simple-row" key={s.id}>
                        <FileGlyph item={s.item} />
                        <button className="list-row-text" onClick={() => open(s.item)}>
                          <strong>{s.item.name}</strong>
                          <small>
                            {s.ownerUserId === user.id
                              ? `Shared with ${s.recipient ? `${s.recipient.displayName} (@${s.recipient.username})` : 'one person'}`
                              : `Shared with you${s.owner ? ` by ${s.owner.displayName}` : ''}`}
                            {(s.ownerUserId !== user.id || !s.recipient?.username) &&
                              ` · ${s.permission === 'EDITOR' ? 'Can edit' : 'Can view'}`}
                          </small>
                        </button>
                        {s.ownerUserId === user.id && s.recipient?.username && (
                          <Select
                            aria-label={`Access for ${s.recipient.displayName}`}
                            value={s.permission}
                            disabled={busy}
                            onChange={(e) =>
                              void act(
                                () =>
                                  api.request('/v1/shares', {
                                    method: 'POST',
                                    body: {
                                      ...operation(),
                                      driveItemId: s.driveItemId,
                                      recipient: { type: 'USERNAME', value: s.recipient.username },
                                      permission: e.target.value,
                                    },
                                  }),
                                'Access updated.',
                              )
                            }
                          >
                            <option value="VIEWER">Can view</option>
                            <option value="EDITOR">Can edit</option>
                          </Select>
                        )}
                        {s.ownerUserId === user.id && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              setConfirmation({
                                title: `Remove access to ${s.item.name}?`,
                                description:
                                  'The person you shared this with will no longer be able to open it.',
                                label: 'Remove access',
                                done: 'Access removed.',
                                run: () =>
                                  api.request(`/v1/shares/${s.id}`, {
                                    method: 'DELETE',
                                    body: operation(),
                                  }),
                              })
                            }
                          >
                            Remove access
                          </Button>
                        )}
                      </article>
                    ))
                  )}
                </Card>
              )}
            </SharedTabs>
          )}
          {place && !searching && !drivePage && (
            <DevicePlace
              place={place}
              groups={groups}
              groupKey={deviceParam}
              loading={
                devices.isPending ||
                (place === 'synced' ? syncFolders.isPending : backups.isPending)
              }
              error={
                devices.isError || (place === 'synced' ? syncFolders.isError : backups.isError)
              }
              onRetry={() =>
                void Promise.all([devices.refetch(), syncFolders.refetch(), backups.refetch()])
              }
              breadcrumbs={
                <>
                  <Link href="/drive" onNavigate={resetPage}>
                    My Drive
                  </Link>
                  {placeCrumbs}
                </>
              }
              usage={folderUsage.data}
              onOpenGroup={(key) => router.push(placeHref(place, key))}
              onOpenFolder={(key, folderId) => router.push(placeHref(place, key, folderId))}
            />
          )}
          {section === 'Devices' && !searching && (
            <ConnectedDevices
              devices={devices.data?.items}
              loading={devices.isPending}
              error={devices.isError}
              onRetry={() => void devices.refetch()}
              onSignOut={(d) =>
                setConfirmation({
                  title: `Sign out ${d.name}?`,
                  description: `${d.name} is signed out of harbor0. Its sync and backups pause, and resume when you sign in on it again. Nothing is deleted.${d.platform === 'WEB' ? ' If it’s the browser you’re using now, you’ll need to sign in again.' : ''}`,
                  label: 'Sign out',
                  done: `${d.name} is signed out.`,
                  run: () =>
                    api.request(`/v1/devices/${d.id}/sign-out`, { method: 'POST', body: {} }),
                })
              }
              onRevoke={(d) =>
                setConfirmation({
                  title: `Revoke ${d.name}?`,
                  description: 'This removes the device and stops everything it does in harbor0.',
                  details: (
                    <RevokeDetails
                      device={d}
                      backups={(backups.data?.items ?? []).filter(
                        (root) =>
                          root.state !== 'REMOVED' &&
                          root.state !== 'ARCHIVED' &&
                          ownsBackup(d, root),
                      )}
                      syncFolders={(syncFolders.data?.items ?? []).filter((folder) =>
                        folder.syncDevices.some((entry) => entry.id === d.id),
                      )}
                    />
                  ),
                  label: 'Revoke device',
                  done: `${d.name} is revoked.`,
                  run: () => api.request(`/v1/devices/${d.id}`, { method: 'DELETE' }),
                })
              }
            />
          )}
          {section === 'Storage' && !searching && (
            <div className="storage-page">
              <Card className="panel capacity">
                <Badge tone="accent">Free plan</Badge>
                <p className="storage-amount">
                  <strong>{bytes(usage.usedBytes)}</strong>
                  <span>of {bytes(usage.quotaBytes)} used</span>
                </p>
                <Progress
                  value={usage.usedBytes + usage.reservedBytes}
                  max={usage.quotaBytes}
                  aria-label="Storage used"
                />
                <div className="storage-breakdown">
                  <span>{bytes(usage.usedBytes)} stored</span>
                  <span>{bytes(usage.reservedBytes)} uploading</span>
                  <span>{bytes(usage.availableBytes)} available</span>
                </div>
                <p className="muted">
                  Storage includes current files, version history, backups, trash, and content
                  retained for sent transfers. Permanently deleting unused files frees up space.
                </p>
              </Card>
              <StorageAudit api={api} />
              <Card
                className="panel"
                title="Plan features"
                description="Backup, sync, file sharing, and transfers are included in the free plan."
              >
                <Alert role="none">Additional storage purchases are not available yet.</Alert>
              </Card>
            </div>
          )}
          {section === 'Notifications' && !searching && (
            <Card className="panel">
              {notices.isPending ? (
                <ContentSkeleton label="Loading notifications" />
              ) : notices.isError && !notices.data?.items.length ? (
                <LoadError compact onRetry={() => void notices.refetch()} />
              ) : !notices.data?.items.length ? (
                <EmptyState
                  compact
                  icon={<Bell />}
                  title="No notifications"
                  description="Updates about your files and transfers will appear here."
                  actions={
                    <Button variant="outline" onClick={() => navigate('My Drive')}>
                      Back to My Drive
                    </Button>
                  }
                />
              ) : (
                <>
                  {unreadNotices.length > 0 && (
                    <div className="notifications-head">
                      <span className="muted">{unreadNotices.length} unread</span>
                      <Button size="sm" variant="outline" onClick={markAllRead}>
                        <Check />
                        Mark all as read
                      </Button>
                    </div>
                  )}
                  {notifications.map((n) => {
                    const { title, href } = describeNotification(n);
                    return (
                      <article
                        className="list-row simple-row"
                        data-unread={!n.readAt || undefined}
                        key={n.id}
                      >
                        <Bell aria-hidden="true" />
                        {href ? (
                          <button className="list-row-text" onClick={() => openNotice(n)}>
                            <strong>{title}</strong>
                            <small>{date(n.createdAt)}</small>
                          </button>
                        ) : (
                          <div className="list-row-text">
                            <strong>{title}</strong>
                            <small>{date(n.createdAt)}</small>
                          </div>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={!!n.readAt}
                          onClick={() =>
                            void readNotices([n.id]).catch((e: Error) => setError(e.message))
                          }
                        >
                          {n.readAt ? 'Read' : 'Mark read'}
                        </Button>
                      </article>
                    );
                  })}
                </>
              )}
            </Card>
          )}
          {section === 'Settings' && !searching && (
            <div className="settings-layout">
              <AppearanceSettings />
              <Card
                className="panel"
                title="Your account"
                description="Manage active sessions in Devices. Use “Forgot password” on the sign-in screen to reset your password."
              >
                <dl className="details">
                  <dt>Email</dt>
                  <dd className="account-email">
                    {user.email} <Badge tone="success">Verified</Badge>
                  </dd>
                </dl>
                <ProfileForm
                  key={`${user.displayName}:${user.username}`}
                  user={user}
                  save={(values) =>
                    act(
                      () =>
                        api.request('/v1/users/me', {
                          method: 'PATCH',
                          body: { ...operation(), ...values },
                        }),
                      'Profile updated.',
                    )
                  }
                />
                <Button variant="outline" onClick={() => navigate('Devices')}>
                  <Settings />
                  Manage devices
                </Button>
              </Card>
              <Card
                className="panel"
                title="Sync & backups"
                description="Folders are synced and backed up by the harbor0 desktop and mobile apps. Open one in My Drive to see its status, backup history and saved versions. Backup, pause and archive controls are in the app on the device that backs the folder up."
              >
                <div className="settings-actions">
                  {drivePlaceOrder.map((target) => {
                    const Icon = drivePlaces[target].icon;
                    return (
                      <Button
                        key={target}
                        variant="outline"
                        onClick={() => router.push(placeHref(target))}
                      >
                        <Icon />
                        {drivePlaces[target].name}
                      </Button>
                    );
                  })}
                </div>
              </Card>
              <DeleteAccount
                email={user.email}
                onDelete={async (email) => {
                  await api.request('/v1/users/me/delete', {
                    method: 'POST',
                    body: { ...operation(), email },
                  });
                  setSignedIn(false);
                  cache.clear();
                  clearBrowserCaches();
                  window.location.reload();
                }}
              />
            </div>
          )}
        </main>
      </div>
      <MobileTabBar
        section={navSection}
        storage={usage}
        onNavigate={resetPage}
        onManageStorage={() => navigate('Storage')}
        activity={folderActivity}
        onOpenActivity={openActivity}
      />
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          void uploadFiles(e.target.files);
          e.target.value = '';
        }}
      />
      <input
        ref={folderInput}
        type="file"
        multiple
        hidden
        {...{ webkitdirectory: '' }}
        onChange={(e) => {
          void uploadFiles(e.target.files, true);
          e.target.value = '';
        }}
      />
      <input
        ref={versionInput}
        type="file"
        hidden
        aria-label="Choose the new version"
        onChange={(e) => {
          const file = e.target.files?.[0];
          const item = versionOf.current;
          if (file && item)
            void uploadEntries([{ file, folders: [] }], { kind: 'replace', item }, item.parentId);
          versionOf.current = null;
          e.target.value = '';
        }}
      />
      <UploadTray
        uploads={progress}
        onDismiss={dismissUploads}
        onPause={pauseUploads}
        onResume={resumeUploads}
        onCancel={cancelUploads}
        onReplace={(keys) => void replaceUploads(keys)}
        onKeepBoth={keepBothUploads}
      />
      {modal?.mode === 'preview' && modal.item && (
        <FilePreview
          cacheScope={user?.id ?? 'anonymous'}
          item={modal.item}
          load={loadPreview}
          onClose={() => setModal(null)}
          onDownload={() => void download({ driveItemId: modal.item!.id })}
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
            : modal?.mode === 'details'
              ? 'File details'
              : modal?.mode === 'folder'
                ? 'Create a folder'
                : modal?.mode === 'versions'
                  ? 'Version history'
                  : modal?.mode === 'send'
                    ? `Send ${modal.item?.name ?? 'selected files'}`
                    : modal?.mode === 'share'
                      ? `Share ${modal.item?.name}`
                      : modal?.mode === 'permanent'
                        ? (modal.items?.length ?? 1) > 1
                          ? `Delete ${modal.items!.length} items permanently?`
                          : `Delete ${(modal.items?.[0] ?? modal.item)?.name ?? 'this item'} permanently?`
                        : modal?.mode === 'trash'
                          ? `Move ${modal.item?.name ?? 'this item'} to trash?`
                          : modal?.mode === 'move'
                            ? 'Move to folder'
                            : `Rename ${modal?.item?.name ?? 'item'}`
        }
        description={
          modal?.mode === 'empty-trash'
            ? 'Permanently delete all items in Trash, including items on other pages and their version history? This cannot be undone. Content needed by sent transfers remains stored until those transfers end.'
            : modal?.mode === 'send'
              ? 'Send a copy to a person. They sign in to harbor0 to receive it.'
              : modal?.mode === 'share'
                ? 'Give a registered person access to the original item.'
                : modal?.mode === 'permanent'
                  ? 'This removes the selected items and their version history, and cannot be undone. Content needed by your sent transfers remains stored and counted until those transfers are cancelled or expire.'
                  : modal?.mode === 'trash'
                    ? 'You can restore this item from Trash.'
                    : undefined
        }
      >
        {modal?.mode === 'details' ? (
          <FileDetails
            item={modal.item!}
            onPreview={() => setModal({ mode: 'preview', item: modal.item })}
            onDownload={() => void download({ driveItemId: modal.item!.id })}
          />
        ) : modal?.mode === 'versions' ? (
          <div className="version-list">
            {error && <Alert tone="error">{error}</Alert>}
            {versions.isPending ? (
              <ContentSkeleton label="Loading version history" />
            ) : versions.isError && !versions.data?.items.length ? (
              <LoadError compact onRetry={() => void versions.refetch()} />
            ) : !versions.data?.items.length ? (
              <EmptyState
                compact
                icon={<Clock />}
                title="No versions to show"
                description="Saved versions of this file will appear here when they’re available."
              />
            ) : null}
            {versions.data?.items.map((v) => (
              <div className="list-row simple-row" key={v.id}>
                <div className="list-row-text">
                  <strong>Version {v.versionNumber}</strong>
                  <small>
                    {date(v.createdAt)} · {bytes(v.sizeBytes)}
                  </small>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void download({ driveItemId: modal.item!.id, versionId: v.id })}
                >
                  Download
                </Button>
                {v.id !== modal.item?.currentVersionId && itemAccess(modal.item!).edit && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        await api.request(
                          `/v1/drive/items/${modal.item!.id}/versions/${v.id}/restore`,
                          {
                            method: 'POST',
                            body: { ...operation(), baseRevision: modal.item!.revision },
                          },
                        );
                        setModal(null);
                      }, `Restored version ${v.versionNumber}.`)
                    }
                  >
                    Restore
                  </Button>
                )}
              </div>
            ))}
          </div>
        ) : (
          <form className="form" onSubmit={submit}>
            {['folder', 'rename'].includes(modal?.mode ?? '') && (
              <Field label="Name">
                <Input
                  autoFocus
                  name="name"
                  defaultValue={modal?.item?.name ?? ''}
                  onFocus={(e) => modal?.mode === 'rename' && selectBaseName(e.currentTarget)}
                  required
                  maxLength={240}
                />
              </Field>
            )}
            {modal?.mode === 'move' && <FolderPicker />}
            {['send', 'share'].includes(modal?.mode ?? '') && (
              <RecipientPicker
                autoFocus
                search={(path) => api.request(path)}
                allowInvite={modal?.mode === 'send'}
                onKindChange={setRecipientKind}
              />
            )}
            {modal?.mode === 'share' && (
              <Field label="Permission">
                <Select name="permission" block>
                  <option value="VIEWER">Viewer — browse and download</option>
                  <option value="EDITOR">Editor — also rename, move, and trash</option>
                </Select>
              </Field>
            )}
            {error && <Alert tone="error">{error}</Alert>}
            <DialogActions>
              <Button type="button" variant="outline" onClick={() => setModal(null)}>
                Cancel
              </Button>
              <Button
                disabled={busy}
                type="submit"
                variant={
                  ['permanent', 'empty-trash'].includes(modal?.mode ?? '') ? 'danger' : 'primary'
                }
              >
                {busy
                  ? 'Working…'
                  : modal?.mode === 'empty-trash'
                    ? 'Empty Trash'
                    : modal?.mode === 'send'
                      ? recipientKind === 'invite'
                        ? 'Send invite'
                        : 'Send files'
                      : modal?.mode === 'share'
                        ? 'Share access'
                        : modal?.mode === 'permanent'
                          ? 'Delete permanently'
                          : modal?.mode === 'trash'
                            ? 'Move to trash'
                            : 'Save'}
              </Button>
            </DialogActions>
          </form>
        )}
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
function FileDetails({
  item,
  onDownload,
  onPreview,
}: {
  item: DriveItem;
  onDownload: () => void;
  onPreview: () => void;
}) {
  return (
    <>
      <p>
        <strong>{item.name}</strong>
      </p>
      <dl className="details">
        <dt>Size</dt>
        <dd>{bytes(item.sizeBytes)}</dd>
        <dt>Created</dt>
        <dd>{date(item.createdAt)}</dd>
        <dt>Modified</dt>
        <dd>{date(item.updatedAt)}</dd>
        <dt>Revision</dt>
        <dd>{item.revision}</dd>
      </dl>
      {item.type === 'FILE' && (
        <DialogActions>
          <Button variant="outline" onClick={onPreview}>
            Preview
          </Button>
          <Button onClick={onDownload}>
            <ArrowDownToLine />
            Download
          </Button>
        </DialogActions>
      )}
    </>
  );
}
function ProfileForm({
  user,
  save,
}: {
  user: { username: string; displayName: string };
  save: (values: Record<string, string>) => Promise<boolean>;
}) {
  const [displayName, setDisplayName] = useState(user.displayName);
  const [username, setUsername] = useState(user.username);
  const [saving, setSaving] = useState(false);
  const changed = displayName.trim() !== user.displayName || username !== user.username;
  return (
    <form
      className="form profile-form"
      onSubmit={(e) => {
        e.preventDefault();
        setSaving(true);
        // Only changed fields are sent, so an unchanged username never counts as a rename.
        void save({
          ...(displayName.trim() !== user.displayName ? { displayName: displayName.trim() } : {}),
          ...(username !== user.username ? { username } : {}),
        }).finally(() => setSaving(false));
      }}
    >
      <Field label="Display name">
        <Input
          name="displayName"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          required
          maxLength={100}
        />
      </Field>
      <Field
        label="Username"
        hint="3–32 lowercase letters, numbers, dots, or underscores. Usernames can be changed once every 30 days."
      >
        <InputGroup prefix="@">
          <Input
            name="username"
            aria-label="Username"
            value={username}
            onChange={(e) => setUsername(e.target.value.toLowerCase())}
            required
            pattern="[a-z0-9_.]{3,32}"
            maxLength={32}
          />
        </InputGroup>
      </Field>
      <div>
        <Button type="submit" disabled={!changed || saving}>
          {saving ? 'Saving…' : 'Save profile'}
        </Button>
      </div>
    </form>
  );
}
function FolderPicker() {
  const [trail, setTrail] = useState<{ id: string; name: string }[]>([]);
  const id = trail.at(-1)?.id ?? null;
  const list = useQuery({ queryKey: ['folder-picker', id], queryFn: () => api.list(id) });
  return (
    <div className="folder-picker">
      <input type="hidden" name="parentId" value={id ?? ''} />
      <p>
        Destination: <strong>{trail.map((t) => t.name).join(' / ') || 'My Drive'}</strong>
      </p>
      {id && (
        <div>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setTrail(trail.slice(0, -1))}
          >
            ↑ Parent folder
          </Button>
        </div>
      )}
      {list.isPending ? (
        <ContentSkeleton label="Loading folders" />
      ) : list.isError ? (
        <LoadError compact onRetry={() => void list.refetch()} />
      ) : !list.data?.items.some((item) => item.type === 'FOLDER') ? (
        <EmptyState
          compact
          icon={<Folder />}
          title="No subfolders here"
          description="You can use this folder as the destination, or choose a parent folder."
        />
      ) : null}
      {list.data?.items
        .filter((i) => i.type === 'FOLDER')
        .map((i) => (
          <button
            type="button"
            className="picker-row"
            key={i.id}
            onClick={() => setTrail([...trail, { id: i.id, name: i.name }])}
          >
            <Folder size={16} />
            <span>{i.name}</span>
            <ChevronRight size={14} />
          </button>
        ))}
    </div>
  );
}
function SessionEndedDialog() {
  // An expired session's cookies were cleared when its renewal was refused. Signing out here
  // would use whatever cookies the browser holds now, which may be a newer sign-in from another
  // tab, so this only sends the user to the sign-in page.
  const reason = useSessionEnd();
  const leave = () => {
    clearBrowserCaches();
    const here = window.location.pathname + window.location.search;
    window.location.assign(`/login?next=${encodeURIComponent(loginDestination(here))}`);
  };
  return (
    <Dialog
      open={!!reason}
      onOpenChange={(open) => {
        if (!open) leave();
      }}
      title="You’ve been signed out"
      description="Your session has expired. Sign in again to continue."
    >
      <DialogActions>
        <Button onClick={leave}>OK</Button>
      </DialogActions>
    </Dialog>
  );
}
export default function AppShell({ children }: { children: ReactNode }) {
  const [client] = useState(createQueryClient);
  return (
    <QueryClientProvider client={client}>
      <Suspense fallback={<WorkspaceSkeleton />}>
        <Workspace />
      </Suspense>
      <SessionEndedDialog />
      {children}
    </QueryClientProvider>
  );
}
