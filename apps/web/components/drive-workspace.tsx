'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import * as Menu from '@radix-ui/react-dropdown-menu';
import {
  ArrowUpFromLine,
  ChevronDown,
  ChevronRight,
  Folder,
  LayoutGrid,
  List,
  MoreHorizontal,
  Plus,
  X,
} from 'lucide-react';
import type { CloudCopy, DriveItem, StorageUsage, SyncItemStatus } from '@harbor/contracts';
import type { Transport } from '@harbor/api-client';
import { operation } from '@harbor/api-client';
import { defaultDriveFilters, driveView } from '../lib/drive-view';
import { fileDate, fileKind, fileSize } from '../lib/file-metadata';
import { FileCollection, FileCollectionSkeleton, FileLoadError } from './file-collection';
import { EmptyState } from './empty-state';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Dialog } from './ui/dialog';
import {
  Dialog as Panel,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from './ui/dialog-primitives';

type Item = DriveItem & {
  localOnly?: boolean;
  syncStatus?: string;
  syncDetail?: string;
  syncProgress?: number;
};
type Trail = { id: string; name: string }[];
type Props = {
  request: Transport;
  parentId: string | null;
  trail: Trail;
  breadcrumbs: ReactNode;
  query: string;
  onClearSearch: () => void;
  userId?: string;
  storage?: StorageUsage | null;
  refreshKey?: unknown;
  pendingItems?: Item[];
  syncedFolderIds?: string[];
  canOpenDeviceCopy?: boolean;
  onOpen: (item: DriveItem) => void;
  onUpload: () => void;
  onDropFiles: (files: File[]) => Promise<unknown>;
  onUploadFolder?: () => void;
  onDownload: (item: DriveItem, versionId?: string) => Promise<unknown>;
  onChanged: () => void;
  onManageStorage: () => void;
  onRemoveSync?: (item: DriveItem) => Promise<unknown>;
  onSyncRemoved?: () => void;
};
const noPending: Item[] = [];
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
  parentId,
  trail,
  breadcrumbs,
  query,
  onClearSearch,
  userId,
  storage,
  refreshKey,
  pendingItems = noPending,
  syncedFolderIds = [],
  onOpen,
  canOpenDeviceCopy = false,
  onUpload,
  onDropFiles,
  onUploadFolder,
  onDownload,
  onChanged,
  onManageStorage,
  onRemoveSync,
  onSyncRemoved,
}: Props) {
  const syncRemovedCallback = useRef(onSyncRemoved);
  syncRemovedCallback.current = onSyncRemoved;
  const [items, setItems] = useState<Item[]>([]);
  const [syncedFolders, setSyncedFolders] = useState<Item[]>([]);
  const separateFolders = !parentId && !query;
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [syncStatuses, setSyncStatuses] = useState<Record<string, SyncItemStatus>>({});
  const [syncStatusError, setSyncStatusError] = useState(false);
  const [syncFoldersError, setSyncFoldersError] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [cloudCopies, setCloudCopies] = useState<CloudCopy[]>([]);
  const [copyStatusError, setCopyStatusError] = useState(false);
  const copyStates = useRef(new Map<string, CloudCopy['state']>());
  const copyOperations = useRef(new Map<string, string>());
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
  const [moveTrail, setMoveTrail] = useState<Trail>([]);
  const [moveFolders, setMoveFolders] = useState<Item[]>([]);
  const [moveLoading, setMoveLoading] = useState(false);
  const [moveError, setMoveError] = useState('');
  const location = ['My Drive', ...trail.map((entry) => entry.name)].join(' / ');
  const pendingFolder = parentId?.startsWith('local-sync:') ?? false;
  useEffect(() => {
    const controller = new AbortController();
    let fetching = false;
    async function refreshCopies() {
      if (fetching) return;
      fetching = true;
      try {
        const copies = await allItems<CloudCopy>(
          request,
          '/v1/drive/cloud-copies',
          controller.signal,
        );
        if (controller.signal.aborted) return;
        const completed = copies.some(
          (copy) => copy.state === 'COMPLETED' && copyStates.current.get(copy.id) === 'SAVING',
        );
        for (const copy of copies) copyStates.current.set(copy.id, copy.state);
        setCloudCopies(
          copies
            .filter(
              (copy) =>
                copy.mode === 'SYNC' ||
                copy.state === 'SAVING' ||
                Date.parse(copy.createdAt) > Date.now() - 86400_000,
            )
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
        );
        setCopyStatusError(false);
        if (completed) {
          setRevision((value) => value + 1);
          changedCallback.current();
        }
      } catch {
        if (!controller.signal.aborted) setCopyStatusError(true);
      } finally {
        fetching = false;
      }
    }
    void refreshCopies();
    const timer = window.setInterval(() => void refreshCopies(), 5000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [request]);
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
    setNotice('');
    setFilters(defaultDriveFilters);
  }, [parentId, query, scope]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError('');
    setItems([]);
    setSyncStatuses({});
    setSyncStatusError(false);
    setSyncedFolders([]);
    setSyncFoldersError(false);
    let knownFolders: Item[] = [];
    const path =
      query && !(scope === 'folder' && parentId)
        ? `/v1/search?q=${encodeURIComponent(query)}`
        : `/v1/drive/folders/${encodeURIComponent(parentId ?? 'root')}/children`;
    let fetching = false;
    async function update() {
      if (fetching) return;
      fetching = true;
      try {
        const [driveResult, syncResult] = await Promise.allSettled([
          pendingFolder ? [] : allItems(request, path, controller.signal),
          allItems(request, '/v1/sync/folders', controller.signal),
        ]);
        if (controller.signal.aborted) return;
        if (syncResult.status === 'fulfilled') {
          knownFolders = syncResult.value;
          setSyncedFolders(knownFolders);
          setSyncFoldersError(false);
        } else {
          setSyncFoldersError(true);
        }
        if (driveResult.status === 'rejected') throw driveResult.reason;
        const data = driveResult.value;
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
          if ((error as { code?: string }).code === 'SYNC_REMOVED') syncRemovedCallback.current?.();
          else setLoadError((error as Error).message);
        }
      } finally {
        fetching = false;
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void update();
    // Keep changes from other devices current without flashing a loading state.
    const timer = window.setInterval(() => void update(), 15000);
    const refreshOnFocus = () => void update();
    window.addEventListener('focus', refreshOnFocus);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      window.removeEventListener('focus', refreshOnFocus);
    };
  }, [request, parentId, query, scope, revision, refreshKey, pendingFolder, separateFolders]);
  const statusTargets = [...new Set([...items, ...syncedFolders].map((item) => item.id))]
    .sort()
    .join(',');
  useEffect(() => {
    const controller = new AbortController();
    let fetching = false;
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
        setSyncStatuses(statuses);
        setSyncStatusError(false);
      } catch {
        if (!controller.signal.aborted) {
          setSyncStatuses({});
          setSyncStatusError(true);
        }
      } finally {
        fetching = false;
      }
    }
    void refreshStatus();
    const timer = window.setInterval(() => void refreshStatus(), 5000);
    const refreshWhenVisible = () => {
      if (document.visibilityState !== 'hidden') void refreshStatus();
    };
    window.addEventListener('focus', refreshWhenVisible);
    window.addEventListener('online', refreshWhenVisible);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      window.removeEventListener('focus', refreshWhenVisible);
      window.removeEventListener('online', refreshWhenVisible);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [request, statusTargets, parentId, query, revision, refreshKey]);
  const merged = [
    ...new Map(
      [...items, ...(separateFolders ? syncedFolders : [])].map((item) => [item.id, { ...item }]),
    ).values(),
  ];
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
        : `${status.confirmedDevices} of ${status.requiredDevices} linked devices confirmed. ${status.cloudState === 'RELEASED' ? 'Stored on linked devices. Cloud copy removed.' : status.cloudState === 'REQUESTED' ? 'Waiting for a linked device to provide a temporary cloud copy.' : 'Cloud copy kept until every linked device confirms; other transfers may also need it.'}`;
  }
  const syncIds = new Set([...syncedFolders.map((item) => item.id), ...syncedFolderIds]);
  if (!query)
    for (const pending of pendingItems) {
      if (pending.parentId !== parentId) continue;
      const index = merged.findIndex(
        (item) =>
          item.id === pending.id || (item.name === pending.name && item.type === pending.type),
      );
      if (index < 0) merged.push(pending);
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
  const files = driveView(scoped, filters);
  const cloudFiles = files.filter((item) => !syncIds.has(item.id));
  const syncFiles = files.filter((item) => syncIds.has(item.id));
  const selection = files.filter((item) => selected.includes(item.id));
  const blocked = busy || selection.some((item) => item.localOnly);
  const canTrash = (item: Item) =>
    !item.localOnly && (item.type !== 'FOLDER' || (!syncIds.has(item.id) && !syncFoldersError));
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
                item.type === 'FOLDER' && !modal.items.some((selected) => selected.id === item.id),
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
    if (mode === 'trash' && !targets.every(canTrash)) return;
    if (mode === 'move' && targets.some(isSyncFolder)) return;
    if (mode === 'copy-cloud') {
      if (!targets.every(isSyncFolder)) return;
      copyOperations.current = new Map(targets.map((item) => [item.id, operation().operationId]));
    }
    const active = document.activeElement;
    const menuId = active?.closest('[role="menu"]')?.getAttribute('aria-labelledby');
    modalReturnFocus.current = menuId
      ? document.getElementById(menuId)
      : active instanceof HTMLElement
        ? active
        : null;
    setError('');
    setMoveTrail([]);
    setModal({ mode, items: targets });
  }
  function restoreModalFocus(event: Event) {
    if (modalReturnFocus.current?.isConnected) {
      event.preventDefault();
      modalReturnFocus.current.focus();
    }
  }
  async function favorite(targets: Item[]) {
    await run(async () => {
      for (const item of targets)
        await request(`/v1/drive/items/${item.id}/favorite`, {
          method: item.favorite ? 'DELETE' : 'PUT',
          body: { ...operation(), baseRevision: item.revision },
        });
    });
  }
  function openItem(item: Item) {
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
          if (mode === 'copy-cloud') {
            const { copy } = await request(`/v1/drive/folders/${item.id}/copy-to-cloud`, {
              method: 'POST',
              body: {
                ...base,
                operationId: copyOperations.current.get(item.id),
                mode: values.copyMode || 'SNAPSHOT',
              },
            });
            copyStates.current.set(copy.id, copy.state);
            setCloudCopies((previous) => [
              copy,
              ...previous.filter((value) => value.id !== copy.id),
            ]);
          }
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
      if (mode === 'remove-sync') {
        const removed = new Set(targets.map((item) => item.id));
        setItems((previous) => previous.filter((item) => !removed.has(item.id)));
        setSyncedFolders((previous) => previous.filter((item) => !removed.has(item.id)));
        setNotice('Folder removed from sync. Local files are preserved on every device.');
      } else
        setNotice(
          mode === 'copy-cloud'
            ? 'Cloud copy started. You can keep using My Drive while it finishes.'
            : mode === 'send'
              ? 'Files sent.'
              : 'Changes saved.',
        );
    } else setRevision((value) => value + 1); // Reconcile successful items if a later operation failed.
  }
  function menu(item: Item) {
    return (
      <Menu.Root>
        <Menu.Trigger
          className="icon-button"
          aria-label={`Actions for ${item.name}`}
          disabled={item.localOnly}
        >
          <MoreHorizontal size={18} />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Content className="dropdown" align="end" sideOffset={5}>
            <Menu.Item onSelect={() => openItem(item)}>Open</Menu.Item>
            <Menu.Separator />
            <Menu.Item disabled={busy} onSelect={() => void download([item])}>
              {item.type === 'FOLDER' ? 'Download as ZIP' : 'Download'}
            </Menu.Item>
            <Menu.Item onSelect={() => show('send', [item])}>Send</Menu.Item>
            <Menu.Item onSelect={() => show('share', [item])}>Share</Menu.Item>
            <Menu.Separator />
            <Menu.Item onSelect={() => show('rename', [item])}>Rename</Menu.Item>
            {isSyncFolder(item) ? (
              <Menu.Item disabled={busy} onSelect={() => show('copy-cloud', [item])}>
                Copy to cloud
              </Menu.Item>
            ) : (
              <Menu.Item onSelect={() => show('move', [item])}>Move</Menu.Item>
            )}
            <Menu.Item onSelect={() => void favorite([item])}>
              {item.favorite ? 'Remove favorite' : 'Add to favorites'}
            </Menu.Item>
            <Menu.Separator />
            <Menu.Item onSelect={() => show('details', [item])}>View details</Menu.Item>
            {item.type === 'FILE' && (
              <Menu.Item onSelect={() => show('versions', [item])}>Version history</Menu.Item>
            )}
            <Menu.Separator />
            {item.type === 'FOLDER' && syncIds.has(item.id) && (
              <Menu.Item onSelect={() => show('remove-sync', [item])}>Remove from sync</Menu.Item>
            )}
            {canTrash(item) && (
              <Menu.Item className="danger-text" onSelect={() => show('trash', [item])}>
                Move to trash
              </Menu.Item>
            )}
          </Menu.Content>
        </Menu.Portal>
      </Menu.Root>
    );
  }
  function renderFiles(entries: Item[], label = 'Drive files') {
    return (
      <>
        {syncStatusError && (
          <p className="muted" role="status">
            Sync status is temporarily unavailable.
          </p>
        )}
        <FileCollection
          label={label}
          compact
          items={entries}
          grid={grid}
          userId={userId}
          selected={selected}
          onSelectionChange={setSelected}
          onOpen={openItem}
          canOpen={(item) => !item.localOnly || item.type === 'FOLDER'}
          renderActions={menu}
          statusColumn={
            label.startsWith('Synced folders') || entries.some((item) => !!item.syncStatus)
          }
          renderStatus={(item) =>
            item.syncStatus && (
              <span
                className={`drive-sync-status ${item.syncStatus === 'Synced' ? 'is-synced' : item.syncStatus === 'Syncing' ? 'is-syncing' : ''}`}
                title={item.syncDetail}
                aria-label={item.syncStatus + ' — ' + (item.syncDetail ?? '')}
              >
                {item.syncStatus}
                {item.syncProgress !== undefined ? ` · ${item.syncProgress}%` : ''}
              </span>
            )
          }
        />
      </>
    );
  }
  function renderSections() {
    return (
      <div className="drive-sections">
        {[
          {
            title: syncFoldersError ? 'Files' : 'Cloud files',
            entries: cloudFiles,
            empty: syncFoldersError ? 'No files' : 'No cloud files',
          },
          { title: 'Synced folders', entries: syncFiles, empty: 'No synced folders' },
        ].map(({ title, entries, empty }) => (
          <section className="drive-section" aria-label={title} key={title}>
            <div className="drive-section-heading">
              <h2>{title}</h2>
              <span>
                {entries.length}{' '}
                {title === 'Synced folders'
                  ? entries.length === 1
                    ? 'folder'
                    : 'folders'
                  : entries.length === 1
                    ? 'item'
                    : 'items'}
              </span>
            </div>
            {title === 'Synced folders' && syncFoldersError && (
              <div className="drive-feedback" role="status">
                <span>Sync folder status is unavailable. Your files are still accessible.</span>{' '}
                <Button variant="ghost" size="sm" onClick={() => setRevision((value) => value + 1)}>
                  Retry sync folder status
                </Button>
              </div>
            )}
            {entries.length ? (
              renderFiles(entries, `${title} table`)
            ) : title === 'Synced folders' && syncFoldersError ? null : (
              <p className="drive-section-empty">
                {filters.type !== 'all' || filters.modified !== 'all' ? 'No matching items' : empty}
              </p>
            )}
          </section>
        ))}
      </div>
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
        if (event.key === 'F2' && selection.length === 1 && !blocked) {
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
        if (!pendingFolder && event.dataTransfer.files.length)
          void run(() => onDropFiles(Array.from(event.dataTransfer.files)));
      }}
    >
      <div className="page-heading drive-heading">
        <h1>{query ? 'Search results' : 'My Drive'}</h1>
        <div className="heading-actions">
          <Button
            variant="outline"
            disabled={busy || pendingFolder}
            onClick={() => setCreating(true)}
          >
            <Plus size={16} />
            New folder
          </Button>
          <Button disabled={busy || pendingFolder} onClick={onUpload}>
            <ArrowUpFromLine size={16} />
            Upload files
          </Button>
        </div>
      </div>
      <nav className="breadcrumbs drive-breadcrumbs" aria-label="Drive location">
        {breadcrumbs}
      </nav>
      {query && (
        <div className="drive-search-scope">
          <span>Results for “{query}”</span>
          {parentId && (
            <select
              aria-label="Search scope"
              value={scope}
              onChange={(e) => setScope(e.target.value)}
            >
              <option value="all">Search all files</option>
              <option value="folder">Search this folder</option>
            </select>
          )}
          <button onClick={onClearSearch} aria-label="Clear search">
            <X size={16} />
          </button>
        </div>
      )}
      {storage &&
        storage.quotaBytes > 0 &&
        (storage.usedBytes + storage.reservedBytes) / storage.quotaBytes >= 0.9 && (
          <div className="drive-capacity" role="status">
            <span>
              {fileSize(storage.usedBytes)} of {fileSize(storage.quotaBytes)} used. You’re running
              low on storage.
            </span>
            <button onClick={onManageStorage}>Manage storage</button>
          </div>
        )}
      {loadError && (
        <p className="error" role="alert">
          {loadError}
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="drive-feedback" role="status">
          {notice}
        </p>
      )}
      {cloudCopies.map((copy) => (
        <p
          className={copy.state === 'FAILED' ? 'error' : 'drive-feedback'}
          role="status"
          key={copy.id}
        >
          {copy.state === 'COMPLETED'
            ? copy.mode === 'SYNC'
              ? copy.syncStatus === 'ERROR' || copy.syncStatus === 'STOPPED'
                ? `“${copy.name}”: ${copy.error}`
                : copy.syncStatus === 'WAITING'
                  ? `“${copy.name}”: waiting for a linked device to sync files.`
                  : copy.syncStatus === 'SYNCED'
                    ? `“${copy.name}” is kept synced with your local folder.`
                    : `Updating “${copy.name}” from your local folder…`
              : `“${copy.name}” saved in My Drive.`
            : copy.state === 'FAILED'
              ? `Could not create “${copy.name}”. ${copy.error ?? 'Try Copy to cloud again.'}`
              : copy.waiting
                ? `Copying “${copy.name}”: waiting for files from a linked device. Keep a synced device online.`
                : `Copying “${copy.name}” to My Drive…`}
        </p>
      ))}
      {copyStatusError && cloudCopies.some((copy) => copy.state === 'SAVING') && (
        <p role="status" className="muted">
          Cloud copy progress is temporarily unavailable. Reconnecting…
        </p>
      )}
      <div className="drive-toolbar">
        {selection.length ? (
          <>
            <strong aria-live="polite">{selection.length} selected</strong>
            <div className="drive-selection-actions">
              {['Download', 'Send', 'Share', ...(selectionHasSyncFolder ? [] : ['Move'])].map(
                (label) => (
                  <Button
                    key={label}
                    variant="ghost"
                    size="sm"
                    disabled={blocked}
                    onClick={() =>
                      label === 'Download'
                        ? void download(selection)
                        : show(label.toLowerCase(), selection)
                    }
                  >
                    {label}
                  </Button>
                ),
              )}
              {selection.every(isSyncFolder) && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={blocked}
                  onClick={() => show('copy-cloud', selection)}
                >
                  Copy to cloud
                </Button>
              )}
              {canTrashSelection && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={blocked}
                  onClick={() => show('trash', selection)}
                >
                  Delete
                </Button>
              )}
              <Menu.Root>
                <Menu.Trigger className="icon-button" aria-label="More selection actions">
                  <MoreHorizontal size={17} />
                </Menu.Trigger>
                <Menu.Portal>
                  <Menu.Content className="dropdown">
                    <Menu.Item disabled={blocked} onSelect={() => void favorite(selection)}>
                      Toggle favorites
                    </Menu.Item>
                    {selection.length === 1 && (
                      <>
                        <Menu.Item disabled={blocked} onSelect={() => show('rename', selection)}>
                          Rename
                        </Menu.Item>
                        <Menu.Item disabled={blocked} onSelect={() => show('details', selection)}>
                          View details
                        </Menu.Item>
                      </>
                    )}
                  </Menu.Content>
                </Menu.Portal>
              </Menu.Root>
            </div>
            <button
              className="icon-button"
              onClick={() => setSelected([])}
              aria-label="Clear selection"
            >
              <X size={17} />
            </button>
          </>
        ) : (
          <>
            <span className="drive-item-count">
              {loading ? 'Loading…' : `${files.length} items`}
            </span>
            <div className="drive-filters">
              <select
                aria-label="Filter by type"
                value={filters.type}
                onChange={(e) => {
                  setSelected([]);
                  setFilters({ ...filters, type: e.target.value });
                }}
              >
                <option value="all">Type · All</option>
                <option value="folders">Folders</option>
                <option value="files">Files</option>
                <option value="image">Images</option>
                <option value="video">Videos</option>
                <option value="audio">Audio</option>
              </select>
              <select
                aria-label="Filter by modified date"
                value={filters.modified}
                onChange={(e) => {
                  setSelected([]);
                  setFilters({ ...filters, modified: e.target.value });
                }}
              >
                <option value="all">Modified · Any time</option>
                <option value="1">Last 24 hours</option>
                <option value="7">Last 7 days</option>
                <option value="30">Last 30 days</option>
              </select>
              <Menu.Root>
                <Menu.Trigger className="drive-sort">
                  Sort <ChevronDown size={13} />
                </Menu.Trigger>
                <Menu.Portal>
                  <Menu.Content className="dropdown" align="end">
                    <Menu.RadioGroup
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
                        <Menu.RadioItem key={value} value={value}>
                          <span className="drive-menu-check">
                            {filters.sort === value ? '✓' : ''}
                          </span>
                          {label}
                        </Menu.RadioItem>
                      ))}
                    </Menu.RadioGroup>
                    <Menu.Separator />
                    <Menu.CheckboxItem
                      checked={filters.foldersFirst}
                      onCheckedChange={(foldersFirst) => setFilters({ ...filters, foldersFirst })}
                    >
                      {filters.foldersFirst ? '✓ ' : ''}Folders first
                    </Menu.CheckboxItem>
                    <Menu.CheckboxItem
                      checked={filters.showSystem}
                      onCheckedChange={(showSystem) => setFilters({ ...filters, showSystem })}
                    >
                      {filters.showSystem ? '✓ ' : ''}Show system files
                    </Menu.CheckboxItem>
                  </Menu.Content>
                </Menu.Portal>
              </Menu.Root>
            </div>
            <div className="view-switch">
              <button aria-label="List view" aria-pressed={!grid} onClick={() => changeView(false)}>
                <List size={17} />
              </button>
              <button aria-label="Grid view" aria-pressed={grid} onClick={() => changeView(true)}>
                <LayoutGrid size={17} />
              </button>
            </div>
          </>
        )}
      </div>
      {creating && (
        <form
          className="drive-new-folder"
          onSubmit={(event) => {
            event.preventDefault();
            const name = String(new FormData(event.currentTarget).get('name'));
            void run(async () => {
              const { item } = await request('/v1/drive/folders', {
                method: 'POST',
                body: { ...operation(), parentId, name },
              });
              focusId.current = item.id;
              setSelected([item.id]);
              setFilters(defaultDriveFilters);
              setCreating(false);
              if (query) onClearSearch();
            });
          }}
        >
          <Folder size={20} />
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
          <Button size="sm" disabled={busy}>
            Create
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setCreating(false)}>
            Cancel
          </Button>
        </form>
      )}
      <div ref={collection} className="drive-content">
        {loading ? (
          <div className="drive-collection">
            <FileCollectionSkeleton compact grid={grid} />
          </div>
        ) : loadError && !files.length ? (
          <FileLoadError onRetry={() => setRevision((value) => value + 1)} />
        ) : files.length === 0 && !separateFolders ? (
          <EmptyState
            icon={<Folder />}
            title={
              query || filters.type !== 'all' || filters.modified !== 'all'
                ? 'No matching files'
                : 'This folder is empty'
            }
            description={
              query || filters.type !== 'all' || filters.modified !== 'all'
                ? 'Try a different search or reset your filters.'
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
              ) : (
                <>
                  <Button disabled={busy || pendingFolder} onClick={onUpload}>
                    Upload files
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busy || pendingFolder}
                    onClick={() => setCreating(true)}
                  >
                    New folder
                  </Button>
                </>
              )
            }
          />
        ) : (
          <>
            {separateFolders ? renderSections() : renderFiles(files)}
            {grid && (
              <button
                className="drive-select-all"
                onClick={() => setSelected(files.map((item) => item.id))}
              >
                Select all files
              </button>
            )}
          </>
        )}
      </div>
      {onUploadFolder && (
        <button className="drive-folder-upload" onClick={onUploadFolder}>
          Upload a folder
        </button>
      )}
      {dragging && (
        <div className="drive-drop-target" role="status">
          <ArrowUpFromLine size={32} />
          <strong>
            {pendingFolder ? 'This folder is still syncing' : `Drop files to upload to ${location}`}
          </strong>
        </div>
      )}
      <Panel
        open={modal?.mode === 'details'}
        onOpenChange={(open) => {
          if (!open) setModal(null);
        }}
      >
        <DialogContent className="drive-details-panel" onCloseAutoFocus={restoreModalFocus}>
          <DialogTitle>File details</DialogTitle>
          <DialogDescription>Information about this item.</DialogDescription>
          {modal?.mode === 'details' &&
            (() => {
              const item = modal.items[0];
              return (
                <>
                  <h2>{item.name}</h2>
                  <dl>
                    {[
                      ['Type', fileKind(item)],
                      ['Size', item.type === 'FOLDER' ? '—' : fileSize(item.sizeBytes)],
                      ['Location', detailLocation],
                      ['Created', fileDate(item.createdAt).full],
                      ['Modified', fileDate(item.updatedAt).full],
                      ['Owner', item.ownerUserId === userId ? 'You' : item.ownerUserId],
                      ['Sharing', sharing],
                      ['Revision', String(item.revision)],
                      ...(item.currentVersionId
                        ? [['Current version', item.currentVersionId]]
                        : []),
                    ].map(([label, value]) => (
                      <div key={label}>
                        <dt>{label}</dt>
                        <dd>{value}</dd>
                      </div>
                    ))}
                  </dl>
                  <Button
                    variant="outline"
                    onClick={() => {
                      setModal(null);
                      onOpen(item);
                    }}
                  >
                    Open
                  </Button>
                </>
              );
            })()}
        </DialogContent>
      </Panel>
      <Dialog
        open={!!modal && modal.mode !== 'details'}
        onCloseAutoFocus={restoreModalFocus}
        onOpenChange={(open) => {
          if (!open && !busy) setModal(null);
        }}
        title={
          modal?.mode === 'copy-cloud'
            ? 'Copy to cloud?'
            : modal?.mode === 'remove-sync'
              ? `Remove “${modal.items[0].name}” from sync?`
              : modal?.mode === 'trash'
                ? `Move ${modal.items.length === 1 ? modal.items[0].name : `${modal.items.length} items`} to trash?`
                : modal?.mode === 'versions'
                  ? 'Version history'
                  : `${modal?.mode ? modal.mode[0].toUpperCase() + modal.mode.slice(1) : ''} ${modal?.items.length === 1 ? modal.items[0].name : `${modal?.items.length ?? 0} items`}`
        }
        description={
          modal?.mode === 'copy-cloud'
            ? 'Choose how this folder is copied to Cloud files in My Drive. Both options use your cloud storage. Keep a linked device online to provide files.'
            : modal?.mode === 'remove-sync'
              ? 'Stop syncing on all linked devices and remove this folder from the app. Local folders and files will stay where they are. Offline devices will stop syncing when they reconnect.'
              : modal?.mode === 'trash'
                ? 'You can restore these items from Trash.'
                : modal?.mode === 'send'
                  ? 'Send a copy to a person. They must sign in to receive it.'
                  : modal?.mode === 'share'
                    ? 'Give a registered person access to the original files.'
                    : undefined
        }
      >
        {modal?.mode === 'versions' ? (
          <>
            {metadataError ? (
              <p role="alert">{metadataError}</p>
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
                <div className="drive-version" key={version.id}>
                  <span>
                    Version {version.versionNumber}
                    <small>
                      {fileDate(version.createdAt).full} · {fileSize(version.sizeBytes)}
                      {version.cloudState === 'RELEASED' ? ' · Cloud copy removed' : ''}
                    </small>
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || version.cloudState === 'RELEASED'}
                    onClick={() => void run(() => onDownload(modal.items[0], version.id), false)}
                  >
                    Download
                  </Button>
                  {version.id !== modal.items[0].currentVersionId && (
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
            onSubmit={(event) => {
              event.preventDefault();
              void submit(
                Object.fromEntries(new FormData(event.currentTarget)) as Record<string, string>,
              );
            }}
          >
            {modal?.mode === 'copy-cloud' && (
              <fieldset className="cloud-copy-options">
                <legend>Copy options</legend>
                <label>
                  <input type="radio" name="copyMode" value="SNAPSHOT" defaultChecked />
                  <span>
                    <strong>One-time snapshot</strong>
                    <small>
                      Copy the current contents once. Future sync changes will not affect the copy.
                    </small>
                  </span>
                </label>
                <label>
                  <input type="radio" name="copyMode" value="SYNC" />
                  <span>
                    <strong>Keep synced</strong>
                    <small>
                      Local additions, edits, renames, and deletions update the cloud copy. Cloud
                      edits do not change the local folder.
                    </small>
                  </span>
                </label>
              </fieldset>
            )}
            {modal?.mode === 'rename' && (
              <label>
                Name
                <Input name="name" required maxLength={240} defaultValue={modal.items[0].name} />
              </label>
            )}
            {['send', 'share'].includes(modal?.mode ?? '') && (
              <label>
                To
                <Input name="recipient" placeholder="@username or email" required />
              </label>
            )}
            {modal?.mode === 'share' && (
              <label>
                Permission
                <select name="permission">
                  <option value="VIEWER">Can view</option>
                  <option value="EDITOR">Can edit</option>
                </select>
              </label>
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
                  <p role="alert">{moveError}</p>
                ) : moveFolders.length ? (
                  moveFolders.map((folder) => (
                    <button
                      type="button"
                      className="drive-destination"
                      key={folder.id}
                      onClick={() => setMoveTrail([...moveTrail, folder])}
                    >
                      <Folder size={17} />
                      {folder.name}
                      <ChevronRight size={14} />
                    </button>
                  ))
                ) : (
                  <p className="muted">No subfolders</p>
                )}
              </div>
            )}
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <div className="dialog-actions">
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
                variant={modal?.mode === 'trash' ? 'destructive' : 'default'}
              >
                {busy
                  ? 'Saving…'
                  : modal?.mode === 'copy-cloud'
                    ? 'Copy to cloud'
                    : modal?.mode === 'remove-sync'
                      ? 'Remove from sync'
                      : modal?.mode === 'trash'
                        ? 'Move to trash'
                        : modal?.mode === 'move'
                          ? 'Move here'
                          : modal?.mode === 'send'
                            ? 'Send'
                            : modal?.mode === 'share'
                              ? 'Share'
                              : 'Save'}
              </Button>
            </div>
          </form>
        )}
      </Dialog>
    </section>
  );
}
