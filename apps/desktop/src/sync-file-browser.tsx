import { useEffect, useState } from 'react';
import { ArrowDownToLine, ChevronRight, RefreshCw } from 'lucide-react';
import { FileCollection, FileCollectionSkeleton } from '../../web/components/file-collection';
import { EmptyState, LoadError } from '../../web/components/empty-state';
import { FilePreview } from '../../web/components/file-preview';
import { Button } from '../../web/components/ui/button';
import { previewKind, type PreviewLoader } from '../../web/lib/file-preview';
import { mergeSyncItems, type SyncDriveItem } from './sync-drive';
import type { SyncFolder, SyncRuntime } from './sync-state';

export type SyncBrowserState = SyncRuntime & {
  driveItems?: SyncDriveItem[];
  folderIds?: Record<string, string>;
};
const bridge = window.harbor;
const loadPreview: PreviewLoader = async (item, signal) => {
  if (previewKind(item) === 'text') return bridge.previewText({ driveItemId: item.id });
  const result = await bridge.request({
    path: '/v1/downloads',
    method: 'POST',
    body: { driveItemId: item.id },
  });
  signal.throwIfAborted();
  return { url: result.downloadUrl };
};

export function SyncFileBrowser({
  root,
  state,
  back,
}: {
  root: SyncFolder;
  state: SyncBrowserState;
  back: () => void;
}) {
  const [trail, setTrail] = useState<{ id: string; name: string }[]>([]);
  const [cursor, setCursor] = useState<string>();
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [cloud, setCloud] = useState<SyncDriveItem[]>([]);
  const [loadedView, setLoadedView] = useState('');
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [revision, setRevision] = useState(0);
  const [preview, setPreview] = useState<SyncDriveItem | null>(null);
  const folderId = trail.at(-1)?.id ?? root.remoteId;
  const parentId = (folderId && state.folderIds?.[folderId]) || folderId;
  const view = JSON.stringify([parentId, cursor]);
  const recentId = state.recent?.[0]?.id;
  useEffect(() => {
    let cancelled = false;
    setError('');
    async function load() {
      try {
        const result = parentId?.startsWith('local-sync:')
          ? { items: [], nextCursor: null }
          : await bridge.request({
              path: `/v1/drive/folders/${encodeURIComponent(parentId ?? 'root')}/children${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
            });
        if (!cancelled) {
          setCloud(result.items);
          setNextCursor(result.nextCursor);
        }
      } catch (e) {
        if (!cancelled) {
          setCloud([]);
          setNextCursor(null);
          setError((e as Error).message);
        }
      } finally {
        if (!cancelled) setLoadedView(view);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [parentId, cursor, view, revision, recentId, state.online, state.lastSync]);
  const loading = loadedView !== view;
  const items = mergeSyncItems(loading ? [] : cloud, state.driveItems ?? [], parentId);
  function navigate(next: typeof trail) {
    setTrail(next);
    setCursor(undefined);
  }
  async function download(item: SyncDriveItem) {
    setActionError('');
    try {
      await bridge.download({
        driveItemId: item.id,
        name: item.name,
        folder: item.type === 'FOLDER',
      });
    } catch (e) {
      setActionError((e as Error).message);
    }
  }
  return (
    <section className="sync-file-browser" aria-label={`Files in ${root.localPathDisplayName}`}>
      <div className="sync-browser-toolbar">
        <nav className="breadcrumbs" aria-label="Synced folder location">
          <button onClick={back}>Synced folders</button>
          <ChevronRight size={14} />
          <button
            aria-current={!trail.length ? 'location' : undefined}
            onClick={() => navigate([])}
          >
            {root.localPathDisplayName}
          </button>
          {trail.map((folder, index) => (
            <span key={folder.id}>
              <ChevronRight size={14} />
              <button
                aria-current={index === trail.length - 1 ? 'location' : undefined}
                onClick={() => navigate(trail.slice(0, index + 1))}
              >
                {folder.name}
              </button>
            </span>
          ))}
        </nav>
        <Button variant="outline" size="sm" onClick={() => setRevision((value) => value + 1)}>
          <RefreshCw size={14} />
          Refresh files
        </Button>
      </div>
      {actionError && (
        <p className="error" role="alert">
          {actionError}
        </p>
      )}
      {error && items.length > 0 && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {loading ? (
        <div className="drive-collection">
          <FileCollectionSkeleton compact />
        </div>
      ) : error && !items.length ? (
        <LoadError onRetry={() => setRevision((value) => value + 1)} />
      ) : !items.length ? (
        <EmptyState
          compact
          icon={<RefreshCw />}
          title="This folder is empty"
          description="Synced files will appear here."
        />
      ) : (
        <FileCollection
          compact
          items={items}
          onOpen={(item) =>
            item.type === 'FOLDER'
              ? navigate([...trail, { id: item.id, name: item.name }])
              : setPreview(item)
          }
          canOpen={(item) => item.type === 'FOLDER' || !item.localOnly}
          renderStatus={(item) =>
            item.syncStatus && (
              <span className="drive-sync-status" title={item.syncDetail}>
                {item.syncStatus}
                {item.syncProgress !== undefined ? ` · ${item.syncProgress}%` : ''}
              </span>
            )
          }
          renderActions={(item) =>
            !item.localOnly && (
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Download ${item.name}`}
                onClick={() => void download(item)}
              >
                <ArrowDownToLine size={16} />
              </Button>
            )
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
      {preview && (
        <FilePreview
          item={preview}
          load={loadPreview}
          onClose={() => setPreview(null)}
          onDownload={() => void download(preview)}
        />
      )}
    </section>
  );
}
