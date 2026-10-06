'use client';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ArrowUpFromLine,
  Download,
  Send,
  FolderInput,
  Trash2,
  Star,
  Pencil,
  Info,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderPlus,
  FolderUp,
  LayoutGrid,
  List,
  Plus,
  X,
} from 'lucide-react';
import type { DriveItem, StorageUsage, SyncItemStatus } from '@harbor/contracts';
import type { Transport } from '@harbor/api-client';
import type { BackupRoot } from '../../../packages/contracts/src/backups';
import { browserSession, applyOptimisticItems, type OptimisticChange } from '../lib/browser-cache';
import { useDebouncedValue } from '../lib/use-debounced-value';
import { readDroppedFiles, type UploadEntry } from '../lib/dropped-files';
import { LoadMoreFiles } from './load-more-files';
import { RecipientPicker, type RecipientKind } from './recipient-picker';
import { driveLocations, type DriveLocation } from '../lib/drive-locations';
import { operation } from '@harbor/api-client';
import { retryTransient, settleBounded } from '../lib/bulk-requests';
import { defaultDriveFilters, driveView, needsWholeFolder } from '../lib/drive-view';
import { canWriteIn, itemAccess, type ShareAccess } from '../lib/drive-access';
import { isLive, onLive } from '../lib/live-updates';
import { fileDate, fileKind, fileSize } from '../lib/file-metadata';
import { loadUsage, usageLabel, type UsageMap } from '../lib/folder-usage';
import {
  FileCollection,
  FileCollectionSkeleton,
  FileLoadError,
  type PinnedEntry,
} from './file-collection';
import { EmptyState } from './empty-state';
import type { ActivityUpdate } from './activity-notifications';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Dialog, DialogActions, Drawer } from './ui/dialog';
import { Alert } from './ui/alert';
import { Badge } from './ui/badge';
import { Field } from './ui/field';
import {
  ActionsMenu,
  Menu,
  MenuCheckboxItem,
  MenuContent,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from './ui/menu';
import { Segmented } from './ui/segmented';
import { Select } from './ui/select';
import { useSessionEnd } from '../lib/session-guard';

type Item = DriveItem & {
  location?: DriveLocation;
  localOnly?: boolean;
  syncStatus?: string;
  syncDetail?: string;
  syncProgress?: number;
  syncDevices?: { id: string; name: string }[];
};
type Trail = { id: string; name: string }[];
/** An item this tab just created, shown until a listing loaded after it includes it. */
export type AddedItem = DriveItem & { addedAt: number };
// Folder catalogs and item lookups change rarely; listings refetch on every pushed change.
const CATALOG_MS = 60_000;
const catalogPath = (path: string) =>
  path.startsWith('/v1/sync/folders') ||
  path.startsWith('/v1/backups') ||
  path.startsWith('/v1/drive/items/');
type Props = {
  request: Transport;
  onActivity: (update: ActivityUpdate) => void;
  parentId: string | null;
  trail: Trail;
  breadcrumbs: ReactNode;
  query: string;
  onClearSearch: () => void;
  userId?: string;
  storage?: StorageUsage | null;
  refreshKey?: unknown;
  pendingItems?: Item[];
  addedItems?: AddedItem[];
  /** While true, pushed changes are this tab's own work and the parent refreshes afterwards. */
  holdLive?: () => boolean;
  syncedFolderIds?: string[];
  localSyncDevices?: Record<string, { id: string; name: string }[]>;
  canOpenDeviceCopy?: boolean;
  onOpen: (item: DriveItem) => void;
  onUpload: () => void;
  onDropFiles: (entries: UploadEntry[]) => Promise<unknown>;
  onUploadFolder?: () => void;
  onDownload: (item: DriveItem, versionId?: string) => Promise<unknown>;
  /** Choose a file to upload as a new version of `item`. */
  onUploadVersion?: (item: DriveItem) => void;
  onChanged: () => void;
  onManageStorage: () => void;
  onRemoveSync?: (item: DriveItem) => Promise<unknown>;
  onSyncRemoved?: () => void;
  onReadOnlyChange?: (readOnly: boolean) => void;
  onRoot: () => void;
  onDisconnectBackup?: (item: DriveItem) => Promise<unknown>;
  /** Folder-like places listed first at the root, e.g. Synced Folders. */
  pinned?: PinnedEntry[];
  /** Show the storage folders use, e.g. inside Synced Folders, Backups and Archives. */
  showFolderUsage?: boolean;
  /** The page heading, e.g. Sync when a synced folder is open. */
  title?: string;
  /** Shown under the breadcrumbs, e.g. the status and controls of an open backup folder. */
  header?: ReactNode;
};
const noPending: Item[] = [];
const noAdded: AddedItem[] = [];
const notHeld = () => false;
const noPinned: PinnedEntry[] = [];
async function allItems<T extends { id: string } = Item>(
  request: Transport,
  path: string,
  signal: AbortSignal,
): Promise<T[]> {
  const result: T[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  do {
    const page: { items: T[]; nextCursor?: string | null } = await request(
      path +
        (cursor ? `${path.includes('?') ? '&' : '?'}cursor=${encodeURIComponent(cursor)}` : ''),
      { signal },
    );
    signal.throwIfAborted();
    result.push(...page.items);
    cursor = page.nextCursor ?? null;
    if (cursor && seen.has(cursor))
      throw new Error('Could not load the remaining files. Please retry.');
    if (cursor) seen.add(cursor);
  } while (cursor);
  return [...new Map(result.map((item) => [item.id, item])).values()];
}
export function DriveWorkspace({
  request,
  onActivity,
  parentId,
  trail,
  breadcrumbs,
  query: searchQuery,
  onClearSearch,
  userId,
  storage,
  refreshKey,
  pendingItems = noPending,
  addedItems = noAdded,
  holdLive = notHeld,
  syncedFolderIds = [],
  pinned = noPinned,
  showFolderUsage = false,
  onOpen,
  canOpenDeviceCopy = false,
  onUpload,
  onDropFiles,
  onUploadFolder,
  onDownload,
  onUploadVersion,
  onChanged,
  onManageStorage,
  onRemoveSync,
  onSyncRemoved,
  onRoot,
  onReadOnlyChange,
  onDisconnectBackup,
  title = 'My Drive',
  header,
}: Props) {
  const query = useDebouncedValue(searchQuery);
  const lastRefresh = useRef(refreshKey);
  const session = useMemo(() => browserSession(request, userId ?? 'anonymous'), [request, userId]);
  const mutationEpoch = useRef(0);
  const loadedView = useRef('');
  const lastRevision = useRef(0);
  const changesRef = useRef(new Map<string, OptimisticChange<Item>>());
  const [changes, setChanges] = useState(changesRef.current);
  const [pageRequest, setPageRequest] = useState({ key: '', count: 1 });
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const syncRemovedCallback = useRef(onSyncRemoved);
  syncRemovedCallback.current = onSyncRemoved;
  // My Drive lists cloud items; a backup or sync folder opened by link still shows its files.
  const [activeTab, setActiveTab] = useState<DriveLocation>('Cloud');
  useEffect(() => {
    if (!parentId) setActiveTab('Cloud');
  }, [parentId]);
  const [backupFolders, setBackupFolders] = useState<Item[]>([]);
  const [backupRoots, setBackupRoots] = useState<BackupRoot[]>([]);
  const [catalogError, setCatalogError] = useState(false);
  const changingTab = useRef(false);
  const [backupRestore, setBackupRestore] = useState<{
    item: Item;
    versionId: string;
    createdAt: string;
    id: string;
  } | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [syncedFolders, setSyncedFolders] = useState<Item[]>([]);
  const separateFolders = !parentId && !query;
  const [loading, setLoading] = useState(true);
  // The open folder's share access; undefined when the caller owns it.
  const [folderAccess, setFolderAccess] = useState<ShareAccess>();
  // Items read so far while every page loads for a sort or filter.
  const [wholeFolder, setWholeFolder] = useState<number | null>(null);
  const partial = useRef(false);
  const [loadError, setLoadError] = useState('');
  const [syncStatuses, setSyncStatuses] = useState<Record<string, SyncItemStatus>>({});
  // The last successful status read, for the poller; null until one succeeds.
  const settledStatuses = useRef<Record<string, SyncItemStatus> | null>(null);
  const [syncStatusError, setSyncStatusError] = useState(false);
  const [syncFoldersError, setSyncFoldersError] = useState(false);
  const [error, setError] = useState('');
  // Requests fail while the signed-out dialog is up; it explains the failure instead.
  const sessionEnd = useSessionEnd();
  function setNotice(message: string) {
    onActivity({ id: crypto.randomUUID(), message, status: 'info' });
  }
  const held = useRef(holdLive);
  held.current = holdLive;
  // When the listing shown was requested; items added before then are already in it.
  const [loadedAt, setLoadedAt] = useState(0);
  const changedCallback = useRef(onChanged);
  changedCallback.current = onChanged;
  const [revision, setRevision] = useState(0);
  const [grid, setGrid] = useState(false);
  const [filters, setFilters] = useState(defaultDriveFilters);
  const [scope, setScope] = useState('all');
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const focusId = useRef<string | null>(null);
  const modalReturnFocus = useRef<HTMLElement | null>(null);
  const collection = useRef<HTMLDivElement>(null);
  const [modal, setModal] = useState<{ mode: string; items: Item[] } | null>(null);
  const [versions, setVersions] = useState<any[] | null>(null);
  const [metadataError, setMetadataError] = useState('');
  const [detailLocation, setDetailLocation] = useState('Loading…');
  const [sharing, setSharing] = useState('Loading…');
  const [recipientKind, setRecipientKind] = useState<RecipientKind>('unknown');
  const [moveTrail, setMoveTrail] = useState<Trail>([]);
  const [moveFolders, setMoveFolders] = useState<Item[]>([]);
  const [moveLoading, setMoveLoading] = useState(false);
  const [moveError, setMoveError] = useState('');
  const location = [title, ...trail.map((entry) => entry.name)].join(' / ');
  const pendingFolder = parentId?.startsWith('local-sync:') ?? false;
  useEffect(() => {
    try {
      setGrid(localStorage.getItem('harbor-drive-view') === 'grid');
    } catch {}
  }, []);
  function changeView(value: boolean) {
    setGrid(value);
    try {
      localStorage.setItem('harbor-drive-view', value ? 'grid' : 'list');
    } catch {}
  }
  useEffect(() => {
    setSelected([]);
    setCreating(false);
    setModal(null);
    setError('');
    setFilters(defaultDriveFilters);
  }, [parentId, query, scope, activeTab]);
  const viewKey = JSON.stringify([userId, parentId, query, scope]);
  const pages =
    pageRequest.key === viewKey ? pageRequest.count : (session.views.get(viewKey)?.pages ?? 1);
  partial.current = !!nextCursor;
  const loadMore = useCallback(() => {
    // A whole-folder read that failed is retried as a whole.
    if (pages === Infinity) setRevision((value) => value + 1);
    else setPageRequest({ key: viewKey, count: pages + 1 });
  }, [viewKey, pages]);
  // Sorting or filtering part of a folder misleads, so a big folder loads in full first.
  const loadWhole = !!nextCursor && !loading && !loadError && needsWholeFolder(filters);
  useEffect(() => {
    if (loadWhole && pages !== Infinity) setPageRequest({ key: viewKey, count: Infinity });
  }, [loadWhole, pages, viewKey]);
  useEffect(() => {
    const controller = new AbortController();
    if (lastRefresh.current !== refreshKey || lastRevision.current !== revision) {
      session.data.clear();
      lastRefresh.current = refreshKey;
      lastRevision.current = revision;
    }
    const cached = session.views.get(viewKey);
    const sameView = loadedView.current === viewKey;
    setLoading(!cached && !sameView);
    if (cached) loadedView.current = viewKey;
    setLoadError('');
    if (!sameView || cached) {
      setItems(cached?.items ?? []);
      setNextCursor(cached?.nextCursor ?? null);
    }
    if (!sameView) {
      setSyncStatuses({});
      setSyncStatusError(false);
      setWholeFolder(null);
    }
    if (!sameView || cached) {
      setSyncedFolders(cached?.syncedFolders ?? []);
      setBackupFolders(cached?.backupFolders ?? []);
      setBackupRoots(cached?.backupRoots ?? []);
    }
    if (cached?.activeTab && parentId) setActiveTab(cached.activeTab);
    if (!sameView || cached) setFolderAccess(cached?.folderAccess);
    if (!sameView || cached) setLoadedAt(cached?.loadedAt ?? 0);
    setSyncFoldersError(false);
    let knownFolders: Item[] = cached?.syncedFolders ?? (sameView ? syncedFolders : []);
    let haveSyncCatalog = !!cached || sameView;
    const path =
      query && !(scope === 'folder' && parentId)
        ? `/v1/search?q=${encodeURIComponent(query)}`
        : `/v1/drive/folders/${encodeURIComponent(parentId ?? 'root')}/children`;
    const read: Transport = (path, init) =>
      session.data
        .load(path, () => request(path), catalogPath(path) ? CATALOG_MS : undefined)
        .then((data) => {
          init?.signal?.throwIfAborted();
          return data;
        });
    async function readPages() {
      const result: Item[] = [];
      const seen = new Set<string>();
      let next: string | null = null;
      const all = pages === Infinity;
      for (let page = 0; page < pages; page++) {
        const params = [
          // Reading a whole folder takes the largest pages after the first.
          ...(all && next ? ['limit=500'] : []),
          ...(next ? [`cursor=${encodeURIComponent(next)}`] : []),
        ].join('&');
        const data = await read(path + (params ? (path.includes('?') ? '&' : '?') + params : ''), {
          signal: controller.signal,
        });
        result.push(...data.items);
        next = data.nextCursor ?? null;
        // Progress shows only while the list on screen is incomplete, not on background refreshes.
        if (all && partial.current && !controller.signal.aborted)
          setWholeFolder(next ? result.length : null);
        if (!next) break;
        if (seen.has(next)) throw new Error('Could not load the remaining files. Please retry.');
        seen.add(next);
      }
      return {
        items: [...new Map(result.map((item) => [item.id, item])).values()],
        nextCursor: next,
      };
    }
    let fetching = false;
    async function update() {
      if (fetching) return;
      fetching = true;
      setRefreshing(true);
      const epoch = mutationEpoch.current;
      const startedAt = Date.now();
      try {
        const [driveResult, syncResult, backupsResult] = await Promise.allSettled([
          pendingFolder ? { items: [], nextCursor: null } : readPages(),
          allItems(read, '/v1/sync/folders', controller.signal),
          allItems<BackupRoot>(read, '/v1/backups', controller.signal),
        ]);
        if (controller.signal.aborted) return;
        if (syncResult.status === 'fulfilled') {
          knownFolders = syncResult.value;
          haveSyncCatalog = true;
          setSyncedFolders(knownFolders);
          setSyncFoldersError(false);
        } else {
          setSyncFoldersError(true);
          if (!haveSyncCatalog) throw syncResult.reason;
        }
        if (driveResult.status === 'rejected') throw driveResult.reason;
        if (backupsResult.status === 'rejected') {
          setCatalogError(true);
          throw backupsResult.reason;
        }
        const roots = backupsResult.value.filter((root) => root.state !== 'REMOVED');
        const backupMap = new Map(roots.map((root) => [root.remoteRootDriveItemId, root.id]));
        const synced = new Set([...knownFolders.map((folder) => folder.id), ...syncedFolderIds]);
        const ancestors = new Map<string, Item>(
          driveResult.value.items.map((item) => [item.id, item]),
        );
        const classify = driveLocations(backupMap, synced, async (id) => {
          const item = (await read(`/v1/drive/items/${id}`, { signal: controller.signal })).item;
          ancestors.set(id, item);
          return item;
        });
        const data = await Promise.all(
          driveResult.value.items.map(async (item) => {
            const category = await classify(item);
            const syncDevices: NonNullable<Item['syncDevices']> = [];
            let current: Item | undefined = item;
            const seen = new Set<string>();
            while (current && !seen.has(current.id)) {
              seen.add(current.id);
              syncDevices.push(
                ...(knownFolders.find((folder) => folder.id === current!.id)?.syncDevices ?? []),
              );
              current = current.parentId ? ancestors.get(current.parentId) : undefined;
            }
            return { ...item, ...category, syncDevices };
          }),
        );
        const archived = await Promise.all(
          (activeTab === 'Backup' && separateFolders ? roots : []).map(async (root) => {
            const item =
              data.find((item) => item.id === root.remoteRootDriveItemId) ??
              (
                await read(`/v1/drive/items/${root.remoteRootDriveItemId}`, {
                  signal: controller.signal,
                })
              ).item;
            return { ...item, backupRootId: root.id, location: 'Backup' as const };
          }),
        );
        let resolvedTab: DriveLocation | undefined;
        let access: ShareAccess;
        if (parentId && !changingTab.current) {
          const current: Pick<DriveItem, 'id' | 'parentId' | 'access'> = pendingFolder
            ? { id: parentId, parentId: null }
            : (await read(`/v1/drive/items/${parentId}`, { signal: controller.signal })).item;
          const category = await classify(current);
          resolvedTab = pendingFolder ? 'Sync' : category.location;
          access = current.access;
          if (!controller.signal.aborted) setActiveTab(resolvedTab);
        }
        if (
          controller.signal.aborted ||
          epoch !== mutationEpoch.current ||
          [...changesRef.current.values()].some((change) => change.pending)
        )
          return;
        // Only an authoritative read started after the last save can retire optimistic changes.
        changesRef.current = new Map();
        setChanges(changesRef.current);
        session.views.set(viewKey, {
          items: data,
          syncedFolders: knownFolders,
          backupFolders: archived,
          backupRoots: roots,
          nextCursor: driveResult.value.nextCursor,
          activeTab: resolvedTab,
          folderAccess: access,
          pages,
          loadedAt: startedAt,
        });
        setFolderAccess(access);
        setLoadedAt(startedAt);
        loadedView.current = viewKey;
        setNextCursor(driveResult.value.nextCursor);
        if (!parentId) changingTab.current = false;
        setBackupRoots(roots);
        setBackupFolders(archived);
        setCatalogError(false);
        setItems(data);
        setLoadError('');
        setSelected((previous) =>
          previous.filter(
            (id) =>
              data.some((item) => item.id === id) ||
              knownFolders.some((item) => item.id === id) ||
              pendingItems.some((item) => item.id === id),
          ),
        );
      } catch (error) {
        if (!controller.signal.aborted) {
          setWholeFolder(null);
          if ((error as { code?: string }).code === 'SYNC_REMOVED') syncRemovedCallback.current?.();
          else setLoadError((error as Error).message);
        }
      } finally {
        fetching = false;
        if (!controller.signal.aborted) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    }
    let updatedAt = Date.now();
    void update();
    // Keep changes from other devices current without flashing a loading state.
    const refreshOnFocus = () => {
      if (document.visibilityState !== 'hidden') {
        session.data.prune(catalogPath);
        updatedAt = Date.now();
        void update();
      }
    };
    // Pushed changes refresh at once, so polling drops to once a minute while live.
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'hidden' || held.current()) return;
      if (isLive() && Date.now() - updatedAt < 60_000) return;
      updatedAt = Date.now();
      void update();
    }, 15000);
    const offLive = onLive((message) => {
      if (message.type !== 'changes' || held.current()) return;
      session.data.prune(catalogPath);
      updatedAt = Date.now();
      void update();
    });
    window.addEventListener('focus', refreshOnFocus);
    window.addEventListener('online', refreshOnFocus);
    return () => {
      controller.abort();
      offLive();
      window.clearInterval(timer);
      window.removeEventListener('focus', refreshOnFocus);
      window.removeEventListener('online', refreshOnFocus);
    };
  }, [
    request,
    parentId,
    query,
    scope,
    revision,
    refreshKey,
    pendingFolder,
    separateFolders,
    session,
    viewKey,
    pages,
    activeTab,
  ]);
  const statusTargets = [...new Set([...items, ...syncedFolders].map((item) => item.id))]
    .sort()
    .join(',');
  useEffect(() => {
    const controller = new AbortController();
    let fetching = false;
    settledStatuses.current = null;
    setSyncStatuses({});
    setSyncStatusError(false);
    const ids = statusTargets ? statusTargets.split(',') : [];
    async function refreshStatus() {
      if (fetching || !ids.length || controller.signal.aborted) return;
      fetching = true;
      try {
        const statuses: Record<string, SyncItemStatus> = {};
        for (let offset = 0; offset < ids.length; offset += 50) {
          const result = await request(
            '/v1/sync/status?ids=' + ids.slice(offset, offset + 50).join(','),
            {
              signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
            },
          );
          for (const status of result.items) statuses[status.itemId] = status;
        }
        if (controller.signal.aborted) return;
        settledStatuses.current = statuses;
        setSyncStatuses(statuses);
        setSyncStatusError(false);
      } catch {
        if (!controller.signal.aborted) {
          settledStatuses.current = null;
          setSyncStatuses({});
          setSyncStatusError(true);
        }
      } finally {
        fetching = false;
      }
    }
    let checkedAt = Date.now();
    void refreshStatus();
    // Each status walks a folder's whole tree on the server, so poll gently: never while hidden,
    // every 30s, and every 2 minutes once all is synced and pushed changes would refresh it.
    // Device receipts are not pushed, so a SYNCING badge still needs the 30s poll to settle.
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      const settled =
        isLive() &&
        !!settledStatuses.current &&
        Object.values(settledStatuses.current).every((s) => s.state === 'SYNCED');
      if (Date.now() - checkedAt < (settled ? 120_000 : 30_000)) return;
      checkedAt = Date.now();
      void refreshStatus();
    }, 10_000);
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'hidden') return;
      checkedAt = Date.now();
      void refreshStatus();
    };
    const offLive = onLive((message) => {
      if (message.type === 'changes') refreshWhenVisible();
    });
    window.addEventListener('focus', refreshWhenVisible);
    window.addEventListener('online', refreshWhenVisible);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      controller.abort();
      offLive();
      window.clearInterval(timer);
      window.removeEventListener('focus', refreshWhenVisible);
      window.removeEventListener('online', refreshWhenVisible);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [request, statusTargets, parentId, query, revision, refreshKey]);
  const merged = applyOptimisticItems<Item>(
    [
      ...new Map(
        [
          ...items,
          ...(separateFolders
            ? syncedFolders.map((item) => ({ ...item, location: 'Sync' as const }))
            : []),
          ...(separateFolders ? backupFolders : []),
        ].map((item) => [item.id, { ...item }]),
      ).values(),
    ],
    changes,
    parentId,
    !!query,
  );
  for (const item of merged) {
    const status = syncStatuses[item.id];
    if (!status) continue;
    item.cloudState = status.cloudState;
    item.syncStatus = {
      PENDING: 'Pending',
      SYNCING: 'Syncing',
      SYNCED: 'Synced',
      UNKNOWN: 'Status unavailable',
    }[status.state];
    item.syncDetail =
      item.type === 'FOLDER'
        ? status.state === 'SYNCED'
          ? 'All contents confirmed on linked devices.'
          : `${status.pendingItems} items waiting for linked devices.`
        : `${status.confirmedDevices} of ${status.requiredDevices} linked devices confirmed. ${status.cloudState === 'RELEASED' ? 'Stored only on linked devices.' : status.cloudState === 'REQUESTED' ? 'Waiting for a linked device to upload it to the cloud.' : 'Stored in the cloud.'}`;
  }
  if (!query)
    for (const added of addedItems) {
      // A rename, move or deletion made since is already reflected through `changes`.
      if (added.parentId !== parentId || added.addedAt <= loadedAt || changes.has(added.id))
        continue;
      const index = merged.findIndex((item) => item.id === added.id);
      const { addedAt: _, ...item } = added;
      if (index < 0) merged.push({ ...item, location: activeTab });
      else if (added.revision > merged[index].revision)
        merged[index] = { ...merged[index], ...item };
    }
  const syncIds = new Set([...syncedFolders.map((item) => item.id), ...syncedFolderIds]);
  if (!query)
    for (const pending of pendingItems) {
      if (pending.parentId !== parentId) continue;
      const index = merged.findIndex(
        (item) =>
          item.id === pending.id || (item.name === pending.name && item.type === pending.type),
      );
      if (index < 0) merged.push({ ...pending, location: 'Sync' });
      else
        merged[index] = {
          ...merged[index],
          syncStatus: pending.syncStatus,
          syncDetail: pending.syncDetail,
          syncProgress: pending.syncProgress,
        };
    }
  const scoped =
    query && scope === 'folder' && parentId
      ? merged.filter((item) => item.name.toLowerCase().includes(query.toLowerCase()))
      : merged;
  const files = driveView(
    scoped.filter(
      (item) =>
        (item.backupRootId
          ? 'Backup'
          : (item.location ?? (syncIds.has(item.id) ? 'Sync' : 'Cloud'))) === activeTab,
    ),
    filters,
  );
  const pinnedHere =
    !parentId &&
    !query &&
    activeTab === 'Cloud' &&
    filters.type === defaultDriveFilters.type &&
    filters.modified === defaultDriveFilters.modified
      ? pinned
      : noPinned;
  const access = (item: Item) => itemAccess(item, folderAccess);
  const mutable = (item: Item) => !item.backupRootId && !catalogError;
  const canModify = (item: Item) => mutable(item) && access(item).manage;
  const canShare = (item: Item) => mutable(item) && access(item).share;
  const canWriteHere =
    !loading &&
    !loadError &&
    !catalogError &&
    canWriteIn(folderAccess) &&
    activeTab !== 'Backup' &&
    (activeTab === 'Cloud' || !!parentId);
  useEffect(() => {
    onReadOnlyChange?.(!canWriteHere);
  }, [canWriteHere, onReadOnlyChange]);
  function changeTab(tab: DriveLocation) {
    changingTab.current = true;
    setActiveTab(tab);
    setSelected([]);
    setCreating(false);
    onClearSearch();
    onRoot();
  }
  // Sizes fill in after the list shows; the server caches them for a minute.
  const usageIds = showFolderUsage
    ? [
        ...(parentId ? [parentId] : []),
        ...files.filter((item) => item.type === 'FOLDER' && !item.localOnly).map((item) => item.id),
      ]
    : [];
  const usageKey = loading ? '' : usageIds.join(',');
  const [usage, setUsage] = useState<UsageMap>({});
  useEffect(() => {
    if (!usageKey) return;
    const controller = new AbortController();
    loadUsage(request, usageKey.split(','), controller.signal)
      .then((map) => setUsage((previous) => ({ ...previous, ...map })))
      .catch(() => {}); // Sizes are optional; the folders still work without them.
    return () => controller.abort();
  }, [request, usageKey, revision]);
  const folderSizes = Object.fromEntries(
    Object.values(usage).map((entry) => [entry.itemId, usageLabel(entry)!]),
  );
  const folderTotal = parentId && usage[parentId] ? usageLabel(usage[parentId]) : undefined;
  const selection = files.filter((item) => selected.includes(item.id));
  const blocked = busy || selection.some((item) => item.localOnly || changes.get(item.id)?.pending);
  const canTrash = (item: Item) =>
    canModify(item) &&
    !item.localOnly &&
    (item.type !== 'FOLDER' || (!syncIds.has(item.id) && !syncFoldersError));
  const canTrashSelection = selection.length > 0 && selection.every(canTrash);
  const isSyncFolder = (item: Item) => item.type === 'FOLDER' && syncIds.has(item.id);
  const selectionHasSyncFolder = selection.some(isSyncFolder);
  useEffect(() => {
    if (!loading && focusId.current) {
      const target = Array.from(
        collection.current?.querySelectorAll<HTMLButtonElement>('[data-file-id]') ?? [],
      ).find((node) => node.dataset.fileId === focusId.current);
      if (target) {
        target.focus();
        focusId.current = null;
      }
    }
  }, [loading, items]);
  useEffect(() => {
    if (!modal || !['details', 'versions'].includes(modal.mode)) return;
    const controller = new AbortController();
    const item = modal.items[0];
    setMetadataError('');
    setVersions(null);
    setSharing('Loading…');
    setDetailLocation('Loading…');
    if (modal.mode === 'versions') {
      void request(`/v1/drive/items/${item.id}/versions`, { signal: controller.signal })
        .then((data) => {
          if (!controller.signal.aborted) setVersions(data.items);
        })
        .catch((e) => {
          if (!controller.signal.aborted) setMetadataError(e.message);
        });
    } else {
      void (async () => {
        const names: string[] = [];
        const visited = new Set<string>();
        let id = item.parentId;
        while (id) {
          if (visited.has(id)) throw new Error('Folder path is unavailable.');
          visited.add(id);
          const { item: folder } = await request(`/v1/drive/items/${id}`, {
            signal: controller.signal,
          });
          names.unshift(folder.name);
          id = folder.parentId;
        }
        if (!controller.signal.aborted) setDetailLocation(['My Drive', ...names].join(' / '));
      })().catch(() => {
        if (!controller.signal.aborted) setDetailLocation('Location unavailable');
      });
      void allItems(request, '/v1/shares/sent', controller.signal)
        .then((shares) => {
          if (!controller.signal.aborted)
            setSharing(
              shares.some((share: any) => share.driveItemId === item.id && !share.revokedAt)
                ? 'Shared access'
                : 'No direct shares',
            );
        })
        .catch(() => {
          if (!controller.signal.aborted) setSharing('Sharing status unavailable');
        });
    }
    return () => controller.abort();
  }, [modal, request]);
  useEffect(() => {
    if (modal?.mode !== 'move') return;
    const controller = new AbortController();
    setMoveLoading(true);
    setMoveError('');
    void allItems(
      request,
      `/v1/drive/folders/${moveTrail.at(-1)?.id ?? 'root'}/children`,
      controller.signal,
    )
      .then((data) => {
        if (!controller.signal.aborted) {
          setMoveFolders(
            data.filter(
              (item) =>
                item.type === 'FOLDER' &&
                !item.backupRootId &&
                !modal.items.some((selected) => selected.id === item.id),
            ),
          );
          setMoveLoading(false);
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) {
          setMoveError(e.message);
          setMoveLoading(false);
        }
      });
    return () => controller.abort();
  }, [modal, moveTrail, request]);
  async function run(action: () => Promise<unknown>, refresh = true) {
    setBusy(true);
    setError('');
    try {
      await action();
      if (refresh) {
        session.data.clear();
        session.views.clear();
        setRevision((value) => value + 1);
        onChanged();
      }
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  function show(mode: string, targets: Item[]) {
    if (targets.some((item) => changesRef.current.get(item.id)?.pending)) return;
    if (
      !['details', 'versions', 'disconnect-backup'].includes(mode) &&
      !targets.every(['send', 'share'].includes(mode) ? canShare : canModify)
    )
      return;
    if (mode === 'trash' && !targets.every(canTrash)) return;
    if (mode === 'move' && targets.some(isSyncFolder)) return;
    const active = document.activeElement;
    // A menu item unmounts with its menu, so return focus to the trigger that opened it.
    modalReturnFocus.current = active?.closest('[role="menu"]')
      ? document.querySelector<HTMLElement>('[aria-haspopup="menu"][aria-expanded="true"]')
      : active instanceof HTMLElement
        ? active
        : null;
    setError('');
    setMoveTrail([]);
    setModal({ mode, items: targets });
  }
  const restoreModalFocus = () =>
    modalReturnFocus.current?.isConnected ? modalReturnFocus.current : null;
  async function optimistic(
    targets: Item[],
    transform: (item: Item) => Item,
    save: (item: Item) => Promise<{ item?: Item } | unknown>,
    done?: string,
    // What failed, for a subject such as “IMG_0001.jpg” or “12 items”.
    action: (subject: string) => string = (subject) => `save ${subject}`,
  ) {
    if (targets.some((item) => changesRef.current.get(item.id)?.pending)) return;
    setError('');
    mutationEpoch.current++;
    for (const item of targets)
      changesRef.current.set(item.id, { item: transform(item), pending: true });
    setChanges(new Map(changesRef.current));
    session.data.clear();
    session.views.clear();
    const results = await settleBounded(targets, async (item) => {
      try {
        const result = (await retryTransient(() => save(item))) as { item?: Item } | undefined;
        const next = result?.item ? { ...transform(item), ...result.item } : transform(item);
        changesRef.current.set(item.id, { item: next, pending: false });
      } catch (error) {
        // Only this item is rolled back, including in a partially successful batch.
        changesRef.current.delete(item.id);
        throw error;
      } finally {
        mutationEpoch.current++;
        setChanges(new Map(changesRef.current));
      }
    });
    // One sentence per distinct reason, so a bulk action that failed for one cause reads once.
    const failures = new Map<string, Item[]>();
    results.forEach((result, index) => {
      if (result.status !== 'rejected') return;
      const reason = (result.reason as Error).message;
      failures.set(reason, [...(failures.get(reason) ?? []), targets[index]]);
    });
    const errors = [...failures].map(
      ([reason, failed]) =>
        `Could not ${action(failed.length === 1 ? `“${failed[0].name}”` : `${failed.length} items`)}. ${reason}`,
    );
    if (errors.length) setError(errors.join(' '));
    else if (done) setNotice(done);
    session.data.clear();
    session.views.clear();
    // Preserve the currently visible folder while fresh data arrives.
    setRevision((value) => value + 1);
    onChanged();
  }
  async function favorite(targets: Item[]) {
    if (!targets.every(canShare)) return;
    await optimistic(
      targets,
      (item) => ({ ...item, favorite: !item.favorite }),
      (item) =>
        request(`/v1/drive/items/${item.id}/favorite`, {
          method: item.favorite ? 'DELETE' : 'PUT',
          body: { ...operation(), baseRevision: item.revision },
        }),
      undefined,
      (subject) => `update favorites for ${subject}`,
    );
  }
  function openItem(item: Item) {
    if (changesRef.current.get(item.id)?.pending) return;
    if (
      item.type === 'FILE' &&
      item.cloudState &&
      item.cloudState !== 'AVAILABLE' &&
      !canOpenDeviceCopy
    ) {
      setNotice(
        'This file is stored on your linked devices. Open it in the desktop app on a synced device.',
      );
      return;
    }
    onOpen(item);
  }
  async function download(targets: Item[]) {
    await run(async () => {
      for (const item of targets) {
        if (item.type === 'FILE' && item.cloudState && item.cloudState !== 'AVAILABLE')
          throw new Error(
            'This file is stored on linked devices. Open its local copy in the desktop app.',
          );
        await onDownload(item);
      }
    }, false);
  }
  async function submit(values: Record<string, string>) {
    if (!modal) return;
    const { mode, items: targets } = modal;
    if (mode === 'move' && targets.some(isSyncFolder)) {
      setModal(null);
      return;
    }
    if (mode === 'trash' && !targets.every(canTrash)) {
      setModal(null);
      return;
    }
    if (['rename', 'move', 'trash'].includes(mode)) {
      const destination = moveTrail.at(-1)?.id ?? null;
      setModal(null);
      setSelected([]);
      await optimistic(
        targets,
        (item) => ({
          ...item,
          ...(mode === 'rename' ? { name: values.name } : {}),
          ...(mode === 'move' ? { parentId: destination } : {}),
          ...(mode === 'trash' ? { deletedAt: new Date().toISOString() } : {}),
        }),
        (item) =>
          request(`/v1/drive/items/${item.id}${mode === 'move' ? '/move' : ''}`, {
            method: mode === 'rename' ? 'PATCH' : mode === 'move' ? 'POST' : 'DELETE',
            body: {
              ...operation(),
              baseRevision: item.revision,
              ...(mode === 'rename' ? { name: values.name } : {}),
              ...(mode === 'move' ? { parentId: destination } : {}),
            },
          }),
        mode === 'trash'
          ? `Moved ${targets.length === 1 ? `“${targets[0].name}”` : `${targets.length} items`} to trash.`
          : mode === 'move'
            ? `Moved ${targets.length === 1 ? `“${targets[0].name}”` : `${targets.length} items`} to ${moveTrail.at(-1)?.name ?? 'My Drive'}.`
            : undefined,
        (subject) =>
          mode === 'trash'
            ? `move ${subject} to trash`
            : mode === 'move'
              ? `move ${subject}`
              : `rename ${subject}`,
      );
      return;
    }
    const recipient = {
      type:
        values.recipient?.includes('@') && !values.recipient.startsWith('@') ? 'EMAIL' : 'USERNAME',
      value: values.recipient?.replace(/^@/, ''),
    };
    const completed = await run(async () => {
      if (mode === 'send')
        await request('/v1/transfers', {
          method: 'POST',
          body: {
            ...operation(),
            recipient,
            items: targets.map((item) => ({ driveItemId: item.id })),
          },
        });
      else
        for (const item of targets) {
          const base = { ...operation(), baseRevision: item.revision };
          if (mode === 'share')
            await request('/v1/shares', {
              method: 'POST',
              body: {
                ...operation(),
                recipient,
                driveItemId: item.id,
                permission: values.permission || 'VIEWER',
              },
            });
          if (mode === 'rename')
            await request(`/v1/drive/items/${item.id}`, {
              method: 'PATCH',
              body: { ...base, name: values.name },
            });
          if (mode === 'move')
            await request(`/v1/drive/items/${item.id}/move`, {
              method: 'POST',
              body: { ...base, parentId: moveTrail.at(-1)?.id ?? null },
            });
          if (mode === 'disconnect-backup') {
            if (onDisconnectBackup) await onDisconnectBackup(item);
            else await request(`/v1/backups/${item.backupRootId}`, { method: 'DELETE' });
          }
          if (mode === 'remove-sync') {
            if (onRemoveSync) await onRemoveSync(item);
            else await request(`/v1/sync/folders/${item.id}`, { method: 'DELETE' });
          }
          if (mode === 'trash')
            await request(`/v1/drive/items/${item.id}`, { method: 'DELETE', body: base });
        }
    });
    if (completed) {
      setModal(null);
      setSelected([]);
      if (mode === 'disconnect-backup') {
        changeTab('Cloud');
        setNotice('Backup disconnected. Its folder and versions are now in My Drive.');
      } else if (mode === 'remove-sync') {
        const removed = new Set(targets.map((item) => item.id));
        setItems((previous) => previous.filter((item) => !removed.has(item.id)));
        setSyncedFolders((previous) => previous.filter((item) => !removed.has(item.id)));
        setNotice('Folder removed from sync. Local files are preserved on every device.');
      } else
        setNotice(
          mode === 'send'
            ? recipient.type === 'EMAIL' && recipientKind === 'invite'
              ? `Invitation sent to ${recipient.value}. Track it in Shared → Sent.`
              : `Sent ${targets.length === 1 ? `“${targets[0].name}”` : `${targets.length} items`}. Track it in Shared → Sent.`
            : mode === 'share'
              ? 'Access shared.'
              : 'Changes saved.',
        );
    } else setRevision((value) => value + 1); // Reconcile successful items if a later operation failed.
  }
  function menu(item: Item) {
    return (
      <ActionsMenu
        label={`Actions for ${item.name}`}
        disabled={item.localOnly || changes.get(item.id)?.pending}
      >
        <MenuItem onClick={() => openItem(item)}>Open</MenuItem>
        <MenuSeparator />
        {(!item.backupRootId || !canOpenDeviceCopy) && (
          <MenuItem disabled={busy} onClick={() => void download([item])}>
            {item.type === 'FOLDER' ? 'Download as ZIP' : 'Download'}
          </MenuItem>
        )}
        {canShare(item) && (
          <>
            <MenuItem onClick={() => show('send', [item])}>Send</MenuItem>
            {!isSyncFolder(item) && (
              <MenuItem onClick={() => show('share', [item])}>Share access</MenuItem>
            )}
          </>
        )}
        {mutable(item) && access(item).edit && item.type === 'FILE' && onUploadVersion && (
          <MenuItem onClick={() => onUploadVersion(item)}>Upload new version</MenuItem>
        )}
        {(canModify(item) || canShare(item)) && (
          <>
            <MenuSeparator />
            {canModify(item) && <MenuItem onClick={() => show('rename', [item])}>Rename</MenuItem>}
            {canModify(item) && !isSyncFolder(item) && (
              <MenuItem onClick={() => show('move', [item])}>Move</MenuItem>
            )}
            {canShare(item) && !isSyncFolder(item) && (
              <MenuItem onClick={() => void favorite([item])}>
                {item.favorite ? 'Remove favorite' : 'Add to favorites'}
              </MenuItem>
            )}
            <MenuSeparator />
          </>
        )}
        <MenuItem onClick={() => show('details', [item])}>View details</MenuItem>
        {item.type === 'FILE' && (
          <MenuItem onClick={() => show('versions', [item])}>Version history</MenuItem>
        )}
        <MenuSeparator />
        {backupRoots.some((root) => root.remoteRootDriveItemId === item.id) && (
          <MenuItem onClick={() => show('disconnect-backup', [item])}>Disconnect backup</MenuItem>
        )}
        {canModify(item) && item.type === 'FOLDER' && syncIds.has(item.id) && (
          <MenuItem tone="danger" onClick={() => show('remove-sync', [item])}>
            Remove from sync
          </MenuItem>
        )}
        {canTrash(item) && (
          <MenuItem tone="danger" onClick={() => show('trash', [item])}>
            Move to trash
          </MenuItem>
        )}
      </ActionsMenu>
    );
  }
  function renderFiles(entries: Item[], label = 'Drive files') {
    return (
      <>
        {syncStatusError && (
          <p className="muted drive-feedback" role="status">
            Sync status is temporarily unavailable.
          </p>
        )}
        <FileCollection
          label={label}
          compact
          items={entries}
          pinned={pinnedHere}
          folderSizes={showFolderUsage ? folderSizes : undefined}
          grid={grid}
          userId={userId}
          selected={selected}
          onSelectionChange={setSelected}
          onOpen={openItem}
          canOpen={(item) =>
            !changes.get(item.id)?.pending && (!item.localOnly || item.type === 'FOLDER')
          }
          renderActions={menu}
          statusColumn={
            label.startsWith('Synced folders') || entries.some((item) => !!item.syncStatus)
          }
          renderStatus={(item) =>
            changes.get(item.id)?.pending ? (
              <Badge className="drive-sync-status" role="status">
                Saving…
              </Badge>
            ) : (
              item.syncStatus && (
                <Badge
                  tone={
                    item.syncStatus === 'Synced'
                      ? 'success'
                      : item.syncStatus === 'Syncing'
                        ? 'accent'
                        : 'neutral'
                  }
                  className={`drive-sync-status ${item.syncStatus === 'Synced' ? 'is-synced' : item.syncStatus === 'Syncing' ? 'is-syncing' : ''}`}
                  title={item.syncDetail}
                  aria-label={item.syncStatus + ' — ' + (item.syncDetail ?? '')}
                >
                  {item.syncStatus}
                  {item.syncProgress !== undefined ? ` · ${item.syncProgress}%` : ''}
                </Badge>
              )
            )
          }
        />
      </>
    );
  }
  function renderSections() {
    const title =
      activeTab === 'Backup'
        ? 'Backup folders'
        : activeTab === 'Sync'
          ? 'Synced folders'
          : 'Cloud files';
    return (
      <section className="drive-section" aria-label={title}>
        <div className="sr-only">
          <h2>{title}</h2>
          <span>{files.length} items</span>
        </div>
        {activeTab === 'Sync' && syncFoldersError && (
          <Alert
            tone="warning"
            action={
              <Button
                variant="link"
                aria-label="Retry sync folder status"
                onClick={() => setRevision((value) => value + 1)}
              >
                Retry
              </Button>
            }
          >
            Sync folders could not be loaded.
          </Alert>
        )}
        {renderFiles(files, `${title} table`)}
      </section>
    );
  }
  return (
    <section
      className="drive-workspace"
      aria-label="My Drive file browser"
      onKeyDown={(event) => {
        if (
          (event.target as HTMLElement).closest(
            'input, textarea, select, [role="dialog"], [role="menu"]',
          )
        )
          return;
        if (event.key === 'Escape') setSelected([]);
        if (
          event.key === 'F2' &&
          selection.length === 1 &&
          !blocked &&
          selection.every(canModify)
        ) {
          event.preventDefault();
          show('rename', selection);
        }
        if (event.key === 'Delete' && canTrashSelection && !blocked) {
          event.preventDefault();
          show('trash', selection);
        }
      }}
      onDragEnter={(event) => {
        if (event.dataTransfer.types.includes('Files')) {
          event.preventDefault();
          dragDepth.current++;
          setDragging(true);
        }
      }}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('Files')) event.preventDefault();
      }}
      onDragLeave={() => {
        if (--dragDepth.current <= 0) {
          dragDepth.current = 0;
          setDragging(false);
        }
      }}
      onDrop={(event) => {
        event.preventDefault();
        event.stopPropagation();
        dragDepth.current = 0;
        setDragging(false);
        if (canWriteHere && !pendingFolder && event.dataTransfer.files.length) {
          // Read the drop synchronously; the DataTransfer is emptied once this handler returns.
          const dropped = readDroppedFiles(event.dataTransfer);
          void run(async () => onDropFiles(await dropped));
        }
      }}
    >
      <div className="drive-tabs">
        <div className="page-heading drive-heading">
          <div className="drive-title">
            <h1>{query ? 'Search results' : (trail.at(-1)?.name ?? title)}</h1>
          </div>
          <div className="heading-actions">
            <Button
              variant="outline"
              disabled={busy || pendingFolder || !canWriteHere}
              onClick={() => setCreating(true)}
            >
              <Plus />
              New folder
            </Button>
            <Button disabled={busy || pendingFolder || !canWriteHere} onClick={onUpload}>
              <ArrowUpFromLine />
              Upload files
            </Button>
            {/* Phones replace the two buttons above with one floating “New” button. */}
            <Menu>
              <MenuTrigger
                render={<Button className="drive-fab" />}
                disabled={busy || pendingFolder || !canWriteHere}
                aria-label="New"
              >
                <Plus aria-hidden="true" />
              </MenuTrigger>
              <MenuContent side="top" className="drive-fab-menu">
                <MenuItem onClick={onUpload}>
                  <ArrowUpFromLine aria-hidden="true" /> Upload files
                </MenuItem>
                {onUploadFolder && (
                  <MenuItem onClick={onUploadFolder}>
                    <FolderUp aria-hidden="true" /> Upload a folder
                  </MenuItem>
                )}
                <MenuSeparator />
                <MenuItem onClick={() => setCreating(true)}>
                  <FolderPlus aria-hidden="true" /> New folder
                </MenuItem>
              </MenuContent>
            </Menu>
          </div>
        </div>
        {parentId && (
          <nav className="breadcrumbs drive-breadcrumbs" aria-label="Drive location">
            {breadcrumbs}
          </nav>
        )}
        {!query && header}
        {query && (
          <div className="drive-search-scope">
            <span>Results for “{query}”</span>
            {parentId && (
              <Select
                aria-label="Search scope"
                value={scope}
                onChange={(e) => setScope(e.target.value)}
              >
                <option value="all">Search all files</option>
                <option value="folder">Search this folder</option>
              </Select>
            )}
            <Button variant="ghost" size="icon" onClick={onClearSearch} aria-label="Clear search">
              <X />
            </Button>
          </div>
        )}
        {storage &&
          storage.quotaBytes > 0 &&
          (storage.usedBytes + storage.reservedBytes) / storage.quotaBytes >= 0.9 && (
            <Alert
              tone="warning"
              className="drive-capacity"
              action={
                <Button variant="link" onClick={onManageStorage}>
                  Manage storage
                </Button>
              }
            >
              {fileSize(storage.usedBytes)} of {fileSize(storage.quotaBytes)} used. You’re running
              low on storage.
            </Alert>
          )}
        {loadError && !sessionEnd && <Alert tone="error">{loadError}</Alert>}
        {error && !sessionEnd && <Alert tone="error">{error}</Alert>}
        <div className="drive-toolbar">
          {selection.length ? (
            <>
              <strong aria-live="polite">{selection.length} selected</strong>
              <div className="drive-selection-actions">
                {[
                  ...(!canOpenDeviceCopy || selection.every(mutable) ? ['Download'] : []),
                  ...(selection.every(canShare) ? ['Send'] : []),
                  ...(selection.every(canModify) && !selectionHasSyncFolder ? ['Move'] : []),
                ].map((label) => (
                  <Button
                    key={label}
                    variant="ghost"
                    aria-label={label}
                    disabled={blocked}
                    onClick={() =>
                      label === 'Download'
                        ? void download(selection)
                        : show(label.toLowerCase(), selection)
                    }
                  >
                    {label === 'Download' ? (
                      <Download aria-hidden="true" />
                    ) : label === 'Send' ? (
                      <Send aria-hidden="true" />
                    ) : (
                      <FolderInput aria-hidden="true" />
                    )}
                    <span>{label}</span>
                  </Button>
                ))}
                {canTrashSelection && (
                  <Button
                    variant="ghost"
                    disabled={blocked}
                    onClick={() => show('trash', selection)}
                  >
                    <Trash2 aria-hidden="true" />
                    <span>Move to trash</span>
                  </Button>
                )}
                <ActionsMenu label="More selection actions" className="drive-selection-menu">
                  {!selectionHasSyncFolder && (
                    <MenuItem
                      disabled={blocked || !selection.every(canShare)}
                      onClick={() => void favorite(selection)}
                    >
                      <Star aria-hidden="true" /> Toggle favorites
                    </MenuItem>
                  )}
                  {selection.length === 1 && (
                    <>
                      <MenuItem
                        disabled={blocked || !selection.every(canModify)}
                        onClick={() => show('rename', selection)}
                      >
                        <Pencil aria-hidden="true" /> Rename
                      </MenuItem>
                      <MenuItem disabled={blocked} onClick={() => show('details', selection)}>
                        <Info aria-hidden="true" /> View details
                      </MenuItem>
                    </>
                  )}
                </ActionsMenu>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="drive-clear-selection"
                onClick={() => setSelected([])}
                aria-label="Clear selection"
              >
                <X />
              </Button>
            </>
          ) : (
            <>
              <span className="drive-item-count">
                {loading
                  ? 'Loading…'
                  : wholeFolder !== null
                    ? `Loading every item to sort and filter… ${wholeFolder.toLocaleString()} so far`
                    : `${files.length}${nextCursor ? '+' : ''} ${files.length === 1 ? 'item' : 'items'}${folderTotal ? ` · ${folderTotal} in total` : ''}`}
              </span>
              <div className="drive-filters">
                <Select
                  aria-label="Filter by type"
                  active={filters.type !== 'all'}
                  value={filters.type}
                  onChange={(e) => {
                    setSelected([]);
                    setFilters({ ...filters, type: e.target.value });
                  }}
                >
                  <option value="all">Type: All items</option>
                  <option value="folders">Type: Folders</option>
                  <option value="files">Type: Files</option>
                  <option value="image">Type: Images</option>
                  <option value="video">Type: Videos</option>
                  <option value="audio">Type: Audio</option>
                </Select>
                <Select
                  aria-label="Filter by modified date"
                  active={filters.modified !== 'all'}
                  value={filters.modified}
                  onChange={(e) => {
                    setSelected([]);
                    setFilters({ ...filters, modified: e.target.value });
                  }}
                >
                  <option value="all">Modified: Any time</option>
                  <option value="1">Modified: Last 24 hours</option>
                  <option value="7">Modified: Last 7 days</option>
                  <option value="30">Modified: Last 30 days</option>
                </Select>
                <Menu>
                  <MenuTrigger
                    render={<Button variant="outline" className="drive-sort" />}
                    aria-label="Sort"
                  >
                    Sort:{' '}
                    {
                      {
                        'name-asc': 'Name, A–Z',
                        'name-desc': 'Name, Z–A',
                        'size-asc': 'Size, smallest first',
                        'size-desc': 'Size, largest first',
                        'created-asc': 'Created, oldest first',
                        'created-desc': 'Created, newest first',
                        'modified-asc': 'Modified, oldest first',
                        'modified-desc': 'Modified, newest first',
                      }[filters.sort]
                    }
                    <ChevronDown className="drive-sort-chevron" />
                  </MenuTrigger>
                  <MenuContent align="start">
                    <MenuRadioGroup
                      value={filters.sort}
                      onValueChange={(sort) => setFilters({ ...filters, sort })}
                    >
                      {[
                        ['modified-desc', 'Modified, newest first'],
                        ['modified-asc', 'Modified, oldest first'],
                        ['name-asc', 'Name, A–Z'],
                        ['name-desc', 'Name, Z–A'],
                        ['size-desc', 'Size, largest first'],
                        ['size-asc', 'Size, smallest first'],
                        ['created-desc', 'Created, newest first'],
                        ['created-asc', 'Created, oldest first'],
                      ].map(([value, label]) => (
                        <MenuRadioItem key={value} value={value}>
                          {label}
                        </MenuRadioItem>
                      ))}
                    </MenuRadioGroup>
                    <MenuSeparator />
                    <MenuCheckboxItem
                      checked={filters.foldersFirst}
                      onCheckedChange={(foldersFirst) => setFilters({ ...filters, foldersFirst })}
                    >
                      Folders first
                    </MenuCheckboxItem>
                    <MenuCheckboxItem
                      checked={filters.showSystem}
                      onCheckedChange={(showSystem) => setFilters({ ...filters, showSystem })}
                    >
                      Show system files
                    </MenuCheckboxItem>
                  </MenuContent>
                </Menu>
                {(filters.type !== 'all' || filters.modified !== 'all') && (
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setSelected([]);
                      setFilters({ ...filters, type: 'all', modified: 'all' });
                    }}
                  >
                    Clear filters
                  </Button>
                )}
              </div>
              <Segmented
                label="View"
                className="view-switch"
                value={grid ? 'grid' : 'list'}
                onValueChange={(view) => changeView(view === 'grid')}
                options={[
                  { value: 'list', label: 'List view', icon: <List />, iconOnly: true },
                  { value: 'grid', label: 'Grid view', icon: <LayoutGrid />, iconOnly: true },
                ]}
              />
            </>
          )}
        </div>
        {creating && canWriteHere && (
          <form
            className="drive-new-folder"
            onSubmit={(event) => {
              event.preventDefault();
              const name = String(new FormData(event.currentTarget).get('name'));
              const now = new Date().toISOString();
              const temporary: Item = {
                id: `pending:${crypto.randomUUID()}`,
                parentId,
                name,
                normalizedName: name.toLowerCase(),
                ownerUserId: userId ?? '',
                type: 'FOLDER',
                mimeType: null,
                sizeBytes: 0,
                currentVersionId: null,
                revision: 0,
                favorite: false,
                createdAt: now,
                updatedAt: now,
                deletedAt: null,
                location: activeTab,
                localOnly: true,
              };
              setCreating(false);
              setFilters(defaultDriveFilters);
              if (query) onClearSearch();
              // Retries reuse the operation, so a lost response can't create a second folder.
              const create = operation();
              void optimistic(
                [temporary],
                (item) => item,
                async () => {
                  const { item } = await request('/v1/drive/folders', {
                    method: 'POST',
                    body: { ...create, parentId, name },
                  });
                  focusId.current = item.id;
                  setSelected([item.id]);
                  return { item: { ...item, localOnly: false, location: activeTab } };
                },
                undefined,
                (subject) => `create ${subject}`,
              );
            }}
          >
            <span className="file-entry-icon" data-kind="folder">
              <Folder aria-hidden="true" />
            </span>
            <Input
              name="name"
              aria-label="Folder name"
              autoFocus
              required
              maxLength={240}
              placeholder="Folder name"
              onKeyDown={(event) => {
                if (event.key === 'Escape') setCreating(false);
              }}
            />
            <Button disabled={busy}>Create</Button>
            <Button type="button" variant="ghost" onClick={() => setCreating(false)}>
              Cancel
            </Button>
          </form>
        )}
        <div ref={collection} className="drive-content tab-panel" id="drive-files">
          {loading ? (
            <div className="drive-collection">
              <FileCollectionSkeleton compact grid={grid} />
            </div>
          ) : (loadError || (activeTab === 'Sync' && syncFoldersError)) && !files.length ? (
            <FileLoadError onRetry={() => setRevision((value) => value + 1)} />
          ) : files.length === 0 && !pinnedHere.length ? (
            <EmptyState
              icon={<Folder />}
              title={
                query || filters.type !== 'all' || filters.modified !== 'all'
                  ? 'No matching files'
                  : activeTab === 'Backup' && !parentId
                    ? 'No backup folders'
                    : activeTab === 'Sync' && !parentId
                      ? 'No synced folders'
                      : parentId
                        ? 'This folder is empty'
                        : 'No files yet'
              }
              description={
                query || filters.type !== 'all' || filters.modified !== 'all'
                  ? 'Try a different search or reset your filters.'
                  : activeTab === 'Backup'
                    ? parentId
                      ? 'Files appear here after their first backup.'
                      : 'Your backed-up folders will appear here.'
                    : activeTab === 'Sync'
                      ? parentId
                        ? 'Files will appear here when this folder syncs.'
                        : 'Your synced folders will appear here.'
                      : 'Upload files or create a folder to get started.'
              }
              actions={
                query || filters.type !== 'all' || filters.modified !== 'all' ? (
                  <Button
                    variant="outline"
                    onClick={() => {
                      setFilters(defaultDriveFilters);
                      onClearSearch();
                    }}
                  >
                    Clear search and filters
                  </Button>
                ) : canWriteHere ? (
                  <>
                    <Button disabled={busy || pendingFolder || !canWriteHere} onClick={onUpload}>
                      Upload files
                    </Button>
                    <Button
                      variant="outline"
                      disabled={busy || pendingFolder || !canWriteHere}
                      onClick={() => setCreating(true)}
                    >
                      New folder
                    </Button>
                  </>
                ) : undefined
              }
            />
          ) : (
            <>
              {separateFolders ? renderSections() : renderFiles(files)}
              {grid && (
                <Button
                  variant="link"
                  className="drive-select-all"
                  onClick={() => setSelected(files.map((item) => item.id))}
                >
                  Select all files
                </Button>
              )}
            </>
          )}
          {nextCursor && !loading && (pages !== Infinity || !!loadError) && (
            <LoadMoreFiles loading={refreshing} error={!!loadError} onLoad={loadMore} />
          )}
        </div>
        {onUploadFolder && canWriteHere && (
          <Button variant="link" className="drive-folder-upload" onClick={onUploadFolder}>
            Upload a folder
          </Button>
        )}
        {dragging && (
          <div className="drive-drop-target" role="status">
            <ArrowUpFromLine size={32} />
            <strong>
              {!canWriteIn(folderAccess)
                ? 'You can view this shared folder but not add to it'
                : !canWriteHere
                  ? 'Uploads are unavailable in this location'
                  : pendingFolder
                    ? 'This folder is still syncing'
                    : `Drop files or folders to upload to ${location}`}
            </strong>
          </div>
        )}
        <Drawer
          open={modal?.mode === 'details'}
          onOpenChange={(open) => {
            if (!open) setModal(null);
          }}
          className="drive-details-panel"
          finalFocus={restoreModalFocus}
          title="File details"
          description="Information about this item."
          footer={
            modal?.mode === 'details' && (
              <Button
                variant="outline"
                onClick={() => {
                  const item = modal.items[0];
                  setModal(null);
                  onOpen(item);
                }}
              >
                Open
              </Button>
            )
          }
        >
          {modal?.mode === 'details' &&
            (() => {
              const item = modal.items[0];
              return (
                <>
                  <h3 className="drive-details-name">{item.name}</h3>
                  <dl className="details">
                    {[
                      ['Type', fileKind(item)],
                      ['Size', item.type === 'FOLDER' ? '—' : fileSize(item.sizeBytes)],
                      ['Location', detailLocation],
                      ['Created', fileDate(item.createdAt).full],
                      ['Modified', fileDate(item.updatedAt).full],
                      ['Owner', item.ownerUserId === userId ? 'You' : 'Shared with you'],
                      ['Sharing', sharing],
                    ].map(([label, value]) => (
                      <div key={label}>
                        <dt>{label}</dt>
                        <dd>{value}</dd>
                      </div>
                    ))}
                  </dl>
                </>
              );
            })()}
        </Drawer>
        <Dialog
          open={!!modal && modal.mode !== 'details'}
          finalFocus={restoreModalFocus}
          onOpenChange={(open) => {
            if (!open && !busy) setModal(null);
          }}
          title={
            modal?.mode === 'disconnect-backup'
              ? 'Disconnect backup?'
              : modal?.mode === 'remove-sync'
                ? `Remove “${modal.items[0].name}” from sync?`
                : modal?.mode === 'trash'
                  ? `Move ${modal.items.length === 1 ? modal.items[0].name : `${modal.items.length} items`} to trash?`
                  : modal?.mode === 'versions'
                    ? 'Version history'
                    : `${modal?.mode ? modal.mode[0].toUpperCase() + modal.mode.slice(1) : ''} ${modal?.items.length === 1 ? modal.items[0].name : `${modal?.items.length ?? 0} items`}`
          }
          description={
            modal?.mode === 'disconnect-backup'
              ? 'Stop backing up this folder. All archived files and versions will remain in Cloud and become editable. Local files stay where they are.'
              : modal?.mode === 'remove-sync'
                ? 'Stop syncing on all linked devices and remove this folder from the app. Local folders and files will stay where they are. Offline devices will stop syncing when they reconnect.'
                : modal?.mode === 'trash'
                  ? `You can restore ${modal.items.length === 1 ? 'this item' : 'these items'} from Trash.`
                  : modal?.mode === 'send'
                    ? 'Send a copy to a person. They sign in to harbor0 to receive it.'
                    : modal?.mode === 'share'
                      ? 'Give a registered person access to the original files.'
                      : undefined
          }
        >
          {modal?.mode === 'versions' ? (
            <>
              {error && <Alert tone="error">{error}</Alert>}
              {metadataError ? (
                <Alert tone="error">{metadataError}</Alert>
              ) : versions === null ? (
                <p role="status">Loading versions…</p>
              ) : !versions.length ? (
                <EmptyState
                  compact
                  icon={<Folder />}
                  title="No versions to show"
                  description="Saved versions will appear here when available."
                />
              ) : (
                versions.map((version) => (
                  <div className="list-row drive-version" key={version.id}>
                    <span className="list-row-text">
                      <strong>Version {version.versionNumber}</strong>
                      <small>
                        {fileDate(version.createdAt).full} · {fileSize(version.sizeBytes)}
                        {version.cloudState === 'RELEASED' ? ' · Not stored in the cloud' : ''}
                      </small>
                    </span>
                    {(!modal.items[0].backupRootId || !canOpenDeviceCopy) && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy || version.cloudState === 'RELEASED'}
                        onClick={() =>
                          void run(() => onDownload(modal.items[0], version.id), false)
                        }
                      >
                        Download
                      </Button>
                    )}
                    {modal.items[0].backupRootId && canOpenDeviceCopy && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => {
                          setBackupRestore({
                            item: modal.items[0],
                            versionId: version.id,
                            createdAt: version.createdAt,
                            id: crypto.randomUUID(),
                          });
                          setModal(null);
                        }}
                      >
                        Restore locally
                      </Button>
                    )}
                    {!modal.items[0].backupRootId &&
                      access(modal.items[0]).edit &&
                      version.id !== modal.items[0].currentVersionId && (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy || version.cloudState === 'RELEASED'}
                          onClick={() =>
                            void run(async () => {
                              await request(
                                `/v1/drive/items/${modal.items[0].id}/versions/${version.id}/restore`,
                                {
                                  method: 'POST',
                                  body: { ...operation(), baseRevision: modal.items[0].revision },
                                },
                              );
                              setModal(null);
                              setNotice(
                                `Restored version ${version.versionNumber} of ${modal.items[0].name}.`,
                              );
                            })
                          }
                        >
                          Restore
                        </Button>
                      )}
                  </div>
                ))
              )}
            </>
          ) : (
            <form
              className="form"
              onSubmit={(event) => {
                event.preventDefault();
                void submit(
                  Object.fromEntries(new FormData(event.currentTarget)) as Record<string, string>,
                );
              }}
            >
              {modal?.mode === 'rename' && (
                <Field label="Name">
                  <Input
                    name="name"
                    required
                    maxLength={240}
                    defaultValue={modal.items[0].name}
                    onFocus={(event) => {
                      // Select the name without its extension so typing replaces only the name.
                      const input = event.currentTarget;
                      const dot =
                        modal.items[0].type === 'FILE' ? input.value.lastIndexOf('.') : -1;
                      input.setSelectionRange(0, dot > 0 ? dot : input.value.length);
                    }}
                  />
                </Field>
              )}
              {['send', 'share'].includes(modal?.mode ?? '') && (
                <RecipientPicker
                  search={(path) => request(path)}
                  allowInvite={modal?.mode === 'send'}
                  onKindChange={setRecipientKind}
                />
              )}
              {modal?.mode === 'share' && (
                <Field label="Permission">
                  <Select name="permission" block>
                    <option value="VIEWER">Can view</option>
                    <option value="EDITOR">Can edit</option>
                  </Select>
                </Field>
              )}
              {modal?.mode === 'move' && (
                <div className="drive-move-picker">
                  <nav className="breadcrumbs" aria-label="Destination">
                    <button type="button" onClick={() => setMoveTrail([])}>
                      My Drive
                    </button>
                    {moveTrail.map((entry, index) => (
                      <span key={entry.id}>
                        <ChevronRight size={13} />
                        <button
                          type="button"
                          onClick={() => setMoveTrail(moveTrail.slice(0, index + 1))}
                        >
                          {entry.name}
                        </button>
                      </span>
                    ))}
                  </nav>
                  {moveLoading ? (
                    <p>Loading folders…</p>
                  ) : moveError ? (
                    <Alert tone="error">{moveError}</Alert>
                  ) : moveFolders.length ? (
                    moveFolders.map((folder) => (
                      <button
                        type="button"
                        className="picker-row drive-destination"
                        key={folder.id}
                        onClick={() => setMoveTrail([...moveTrail, folder])}
                      >
                        <Folder size={16} />
                        <span>{folder.name}</span>
                        <ChevronRight size={14} />
                      </button>
                    ))
                  ) : (
                    <p className="muted">No subfolders</p>
                  )}
                </div>
              )}
              {error && <Alert tone="error">{error}</Alert>}
              <DialogActions>
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => setModal(null)}
                >
                  Cancel
                </Button>
                <Button
                  disabled={busy || (modal?.mode === 'move' && (moveLoading || !!moveError))}
                  variant={modal?.mode === 'trash' ? 'danger' : 'primary'}
                >
                  {busy
                    ? 'Working…'
                    : modal?.mode === 'disconnect-backup'
                      ? 'Disconnect backup'
                      : modal?.mode === 'remove-sync'
                        ? 'Remove from sync'
                        : modal?.mode === 'trash'
                          ? 'Move to trash'
                          : modal?.mode === 'move'
                            ? 'Move here'
                            : modal?.mode === 'send'
                              ? recipientKind === 'invite'
                                ? 'Send invite'
                                : 'Send'
                              : modal?.mode === 'share'
                                ? 'Share'
                                : 'Save'}
                </Button>
              </DialogActions>
            </form>
          )}
        </Dialog>
        <Dialog
          open={!!backupRestore}
          onOpenChange={(open) => {
            if (!open && !busy) setBackupRestore(null);
          }}
          title="Restore this local file?"
          description={`Replace the current local copy of ${backupRestore?.item.name ?? 'this file'} with the version saved ${backupRestore ? fileDate(backupRestore.createdAt).full : ''}. The archive will stay unchanged. The source computer must be online with backups running.`}
        >
          <DialogActions>
            <Button variant="outline" disabled={busy} onClick={() => setBackupRestore(null)}>
              Cancel
            </Button>
            <Button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  if (!backupRestore) return;
                  await request(`/v1/backups/${backupRestore.item.backupRootId}/restores`, {
                    method: 'POST',
                    body: {
                      id: backupRestore.id,
                      itemId: backupRestore.item.id,
                      versionId: backupRestore.versionId,
                    },
                  });
                  setBackupRestore(null);
                  setNotice('Local restore requested. Track progress in Backups → History.');
                })
              }
            >
              Restore locally
            </Button>
          </DialogActions>
        </Dialog>
      </div>
    </section>
  );
}
