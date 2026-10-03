'use client';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from 'react';
import { File, FileImage, FileText, Folder, Star, Trash2 } from 'lucide-react';
import { fileDate, fileKind, fileSize, fileSummary, type FileEntry } from '../lib/file-metadata';
import { LoadMoreFiles } from './load-more-files';
import { Skeleton } from './ui/skeleton';
import { LoadError } from './empty-state';
import { DataTable } from './ui/table';
import { Checkbox } from './ui/checkbox';

function FileTable({ children, label = 'Drive files' }: { children: ReactNode; label?: string }) {
  return (
    <DataTable className="files-table" label={label}>
      {children}
    </DataTable>
  );
}

function DateCell({ value }: { value?: string | null }) {
  const date = fileDate(value);
  return (
    <span className="file-date-detail" title={date.full}>
      <span>{date.date}</span>
      {date.time && <small>{date.time}</small>}
    </span>
  );
}
function SelectAll({
  items,
  selected,
  onChange,
}: {
  items: FileEntry[];
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const count = items.filter((item) => selected.includes(item.id)).length;
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = count > 0 && count < items.length;
  }, [count, items.length]);
  return (
    <Checkbox
      ref={ref}
      aria-label="Select all files on this page"
      checked={items.length > 0 && count === items.length}
      onChange={(event) =>
        onChange(
          event.target.checked
            ? [...new Set([...selected, ...items.map((item) => item.id)])]
            : selected.filter((id) => !items.some((item) => item.id === id)),
        )
      }
    />
  );
}
function FileIdentity({
  item,
  onOpen,
  disabled,
  compact,
}: {
  item: FileEntry;
  onOpen: (item: FileEntry) => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  const Icon =
    item.type === 'FOLDER'
      ? Folder
      : item.mimeType?.startsWith('image/')
        ? FileImage
        : item.mimeType?.includes('pdf') || item.mimeType?.startsWith('text/')
          ? FileText
          : File;
  return (
    <>
      <button
        className="file-entry-open"
        data-file-id={item.id}
        aria-label={item.name}
        title={disabled ? `${item.name} · Available after syncing` : item.name}
        disabled={disabled}
        onClick={() => onOpen(item)}
      >
        <span
          className="file-entry-icon"
          data-kind={Icon === Folder ? 'folder' : Icon === FileImage ? 'image' : 'document'}
        >
          <Icon aria-hidden="true" />
        </span>
        <span className="file-entry-label">
          <strong>{item.name}</strong>
          {!compact && <small title={item.mimeType ?? undefined}>{fileKind(item)}</small>}
          {/* Phones drop the size and date columns, so the row carries them instead. */}
          <span className="file-entry-mobile-meta" aria-hidden="true">
            {item.type === 'FOLDER' ? 'Folder' : fileSize(item.sizeBytes)} ·{' '}
            {fileDate(item.deletedAt ?? item.updatedAt).date}
          </span>
        </span>
      </button>
      {item.favorite && <Star className="file-favorite" size={14} aria-label="Favorite" />}
      {item.deletedAt && <Trash2 size={14} className="muted" aria-label="In trash" />}
    </>
  );
}
/**
 * A folder-like place listed before the files, such as Synced Folders in My Drive or a device
 * inside it. It opens like a folder but can't be selected, changed or moved.
 */
export type PinnedEntry = {
  id: string;
  name: string;
  icon?: ComponentType<{ 'aria-hidden'?: boolean | 'true' }>;
  /** A short line under the name, e.g. “3 folders”. */
  detail?: string;
  /** Storage it uses, e.g. “4.2 GB”, once known. */
  size?: string;
  onOpen: () => void;
};
function PinnedIdentity({
  entry,
  selectable,
  grid,
}: {
  entry: PinnedEntry;
  selectable: boolean;
  grid?: boolean;
}) {
  const Icon = entry.icon ?? Folder;
  return (
    <div className="file-entry-identity">
      {selectable && <span className="file-entry-select-spacer" aria-hidden="true" />}
      <button
        className="file-entry-open"
        data-file-id={entry.id}
        aria-label={[entry.name, entry.detail, entry.size].filter(Boolean).join(', ')}
        title={entry.name}
        onClick={entry.onOpen}
      >
        <span className="file-entry-icon" data-kind="folder">
          <Icon aria-hidden="true" />
        </span>
        <span className="file-entry-label">
          <strong>{entry.name}</strong>
          {/* Cards have no size column, so the size joins the detail line. */}
          {(entry.detail || (grid && entry.size)) && (
            <small>{[entry.detail, grid && entry.size].filter(Boolean).join(' · ')}</small>
          )}
          {entry.size && (
            <span className="file-entry-mobile-meta" aria-hidden="true">
              {entry.size}
            </span>
          )}
        </span>
      </button>
    </div>
  );
}
type Props<T extends FileEntry> = {
  items: T[];
  /** Listed first, in this order, regardless of sorting. */
  pinned?: PinnedEntry[];
  /** Storage used by folders, by ID, shown where files show their size. */
  folderSizes?: Record<string, string>;
  userId?: string;
  grid?: boolean;
  trash?: boolean;
  selected?: string[];
  onSelectionChange?: (ids: string[]) => void;
  onOpen: (item: T) => void;
  renderActions: (item: T) => ReactNode;
  renderStatus?: (item: T) => ReactNode;
  statusColumn?: boolean;
  renderDevice?: (item: T) => ReactNode;
  canOpen?: (item: T) => boolean;
  refreshing?: boolean;
  compact?: boolean;
  label?: string;
};
export function FileCollection<T extends FileEntry>({
  items,
  pinned = [],
  folderSizes,
  userId,
  grid,
  trash,
  selected = [],
  onSelectionChange,
  onOpen,
  renderActions,
  renderStatus,
  statusColumn = false,
  renderDevice,
  canOpen,
  refreshing,
  compact = true,
  label,
}: Props<T>) {
  const [visibleCount, setVisibleCount] = useState(80);
  const visibleItems = items.slice(0, visibleCount);
  const showMore = useCallback(() => setVisibleCount((count) => count + 80), []);
  const anchor = useRef<string | null>(null);
  function select(item: T, extend = false, toggle = false) {
    if (!onSelectionChange) return;
    const start = items.findIndex((entry) => entry.id === anchor.current);
    const end = items.findIndex((entry) => entry.id === item.id);
    if (extend && start >= 0) {
      onSelectionChange([
        ...new Set([
          ...selected,
          ...items.slice(Math.min(start, end), Math.max(start, end) + 1).map((entry) => entry.id),
        ]),
      ]);
    } else {
      onSelectionChange(
        toggle
          ? selected.includes(item.id)
            ? selected.filter((id) => id !== item.id)
            : [...selected, item.id]
          : [item.id],
      );
      anchor.current = item.id;
    }
  }
  function rowEvents(item: T) {
    return compact
      ? {
          tabIndex: 0,
          onClick: (event: React.MouseEvent) => {
            if ((event.target as HTMLElement).closest('button, input, [role="menuitem"]')) return;
            select(item, event.shiftKey, event.metaKey || event.ctrlKey);
          },
          onDoubleClick: (event: React.MouseEvent) => {
            if ((event.target as HTMLElement).closest('button, input, [role="menuitem"]')) return;
            if (!canOpen || canOpen(item)) onOpen(item);
          },
          onKeyDown: (event: React.KeyboardEvent) => {
            if (event.target !== event.currentTarget) return;
            if (event.key === ' ') {
              event.preventDefault();
              select(item, event.shiftKey, true);
            }
            if (event.key === 'Enter' && (!canOpen || canOpen(item))) onOpen(item);
            if ((event.metaKey || event.ctrlKey) && event.key === 'a') {
              event.preventDefault();
              onSelectionChange?.(items.map((entry) => entry.id));
            }
            if (event.key === 'Escape') onSelectionChange?.([]);
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              const index = items.indexOf(item) + (event.key === 'ArrowDown' ? 1 : -1);
              const next = items[index];
              if (next) {
                if (event.shiftKey) {
                  anchor.current ??= item.id;
                  select(next, true);
                }
                const parent = event.currentTarget.parentElement;
                if (index >= visibleCount) {
                  setVisibleCount((count) => count + 80);
                  requestAnimationFrame(() => (parent?.children[index] as HTMLElement)?.focus());
                } else (parent?.children[index] as HTMLElement)?.focus();
              }
            }
          },
        }
      : {};
  }
  function identity(item: T) {
    return (
      <div className="file-entry-identity">
        {onSelectionChange && (
          <Checkbox
            aria-label={`Select ${item.name}`}
            checked={selected.includes(item.id)}
            onChange={(event) => select(item, (event.nativeEvent as MouseEvent).shiftKey, true)}
          />
        )}
        <FileIdentity
          item={item}
          compact={compact}
          onOpen={() => onOpen(item)}
          disabled={canOpen ? !canOpen(item) : false}
        />
        {(!statusColumn || grid) && renderStatus?.(item)}
      </div>
    );
  }
  const owner = (item: T) =>
    !userId || !item.ownerUserId ? '—' : item.ownerUserId === userId ? 'You' : 'Other owner';
  return (
    <section className={`files-collection ${compact ? 'drive-collection' : ''}`} aria-label="Files">
      {grid ? (
        <div className="files-view-grid file-grid">
          {pinned.map((entry) => (
            <article
              className="card file-entry-card file-entry-pinned"
              key={entry.id}
              onDoubleClick={(event) => {
                if (!(event.target as HTMLElement).closest('button')) entry.onOpen();
              }}
            >
              <PinnedIdentity entry={entry} selectable={false} grid />
            </article>
          ))}
          {visibleItems.map((item) => (
            <article
              className={`card file-entry-card ${selected.includes(item.id) ? 'is-selected' : ''}`}
              key={item.id}
              {...rowEvents(item)}
            >
              {identity(item)}
              {renderDevice && <div className="file-card-device">{renderDevice(item)}</div>}
              <div className="file-card-actions">{renderActions(item)}</div>
              {!compact && (
                <dl className="file-card-details">
                  <dt>Size</dt>
                  <dd>{item.type === 'FOLDER' ? '—' : fileSize(item.sizeBytes)}</dd>
                  <dt>Modified</dt>
                  <dd>{fileDate(item.updatedAt).date}</dd>
                  <dt>{trash ? 'Deleted' : 'Created'}</dt>
                  <dd>{fileDate(trash ? item.deletedAt : item.createdAt).date}</dd>
                  <dt>Owner</dt>
                  <dd>{owner(item)}</dd>
                </dl>
              )}
            </article>
          ))}
        </div>
      ) : (
        <FileTable label={label}>
          <caption className="sr-only">
            Your files with size and modified date.{' '}
            {!compact && <> {trash ? 'deleted' : 'created'} date, and owner</>}
          </caption>
          <thead>
            <tr>
              <th scope="col" className="file-name-column">
                <div className="file-heading-name">
                  {onSelectionChange && (
                    <SelectAll items={items} selected={selected} onChange={onSelectionChange} />
                  )}
                  <span>{compact ? 'Name' : 'Name & type'}</span>
                </div>
              </th>
              {renderDevice && (
                <th scope="col" className="file-device-column">
                  Device
                </th>
              )}
              {statusColumn && (
                <th scope="col" className="file-sync-column">
                  Sync status
                </th>
              )}
              <th scope="col" className="file-size-column">
                Size
              </th>
              <th scope="col" className="file-modified-column">
                Modified
              </th>
              {!compact && (
                <>
                  <th scope="col" className="file-created-column">
                    {trash ? 'Deleted' : 'Created'}
                  </th>
                  <th scope="col" className="file-owner-column">
                    Owner
                  </th>
                </>
              )}
              <th scope="col" className="file-actions-column">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {pinned.map((entry) => (
              <tr
                key={entry.id}
                className="file-entry-row file-entry-pinned"
                onDoubleClick={(event) => {
                  if (!(event.target as HTMLElement).closest('button')) entry.onOpen();
                }}
              >
                <td>
                  <PinnedIdentity entry={entry} selectable={!!onSelectionChange} />
                </td>
                {renderDevice && <td className="file-device-column" />}
                {statusColumn && (
                  <td className="file-sync-column">
                    <span className="muted">—</span>
                  </td>
                )}
                <td className="file-size-column">
                  {entry.size ? <span>{entry.size}</span> : <span className="muted">—</span>}
                </td>
                <td className="file-modified-column">
                  <span className="muted">—</span>
                </td>
                {!compact && (
                  <>
                    <td className="file-created-column" />
                    <td className="file-owner-column" />
                  </>
                )}
                <td className="file-actions-column" />
              </tr>
            ))}
            {visibleItems.map((item) => (
              <tr
                key={item.id}
                {...rowEvents(item)}
                aria-selected={compact ? selected.includes(item.id) : undefined}
                className={`file-entry-row ${selected.includes(item.id) ? 'is-selected' : ''}`}
              >
                <td>{identity(item)}</td>
                {renderDevice && <td className="file-device-column">{renderDevice(item)}</td>}
                {statusColumn && (
                  <td className="file-sync-column">
                    {renderStatus?.(item) || <span className="muted">—</span>}
                  </td>
                )}
                <td className="file-size-column">
                  {item.type === 'FOLDER' ? (
                    folderSizes?.[item.id] ? (
                      <span title="Storage used by this folder, every version included">
                        {folderSizes[item.id]}
                      </span>
                    ) : (
                      <span title="Folder size is not calculated">—</span>
                    )
                  ) : (
                    <span title={`${item.sizeBytes.toLocaleString()} bytes`}>
                      {fileSize(item.sizeBytes)}
                    </span>
                  )}
                </td>
                <td className="file-modified-column">
                  <DateCell value={item.updatedAt} />
                </td>
                {!compact && (
                  <>
                    <td className="file-created-column">
                      <DateCell value={trash ? item.deletedAt : item.createdAt} />
                    </td>
                    <td className="file-owner-column">
                      <span className="file-owner-tag">{owner(item)}</span>
                    </td>
                  </>
                )}
                <td className="file-actions-column">{renderActions(item)}</td>
              </tr>
            ))}
          </tbody>
        </FileTable>
      )}
      {visibleCount < items.length && <LoadMoreFiles loading={false} onLoad={showMore} />}
      {!compact && (
        <div className="file-list-summary">
          <span>{fileSummary(items)}</span>
          {refreshing && <span role="status">Updating…</span>}
        </div>
      )}
    </section>
  );
}
export function FileCollectionSkeleton({
  grid = false,
  compact = true,
}: {
  grid?: boolean;
  compact?: boolean;
}) {
  return (
    <div
      className={`files-collection ${compact ? 'drive-collection' : ''}`}
      role="status"
      aria-label="Loading files"
      aria-busy="true"
    >
      <span className="sr-only">Loading files…</span>
      {grid ? (
        <div className="files-view-grid">
          {Array.from({ length: 6 }, (_, index) => (
            <div key={index} className="card file-entry-card">
              <Skeleton className="skeleton-file-icon" />
              <Skeleton className="skeleton-file-name" />
              <Skeleton className="skeleton-file-meta" />
              <Skeleton className="skeleton-file-meta" />
            </div>
          ))}
        </div>
      ) : (
        <FileTable>
          <thead>
            <tr>
              <th className="file-name-column">{compact ? 'Name' : 'Name & type'}</th>
              <th className="file-size-column">Size</th>
              <th className="file-modified-column">Modified</th>
              {!compact && (
                <>
                  <th className="file-created-column">Created</th>
                  <th className="file-owner-column">Owner</th>
                </>
              )}
              <th className="file-actions-column">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: 6 }, (_, index) => (
              <tr key={index}>
                <td>
                  <div className="file-entry-identity">
                    <Skeleton className="skeleton-file-icon" />
                    <div className="skeleton-file-text">
                      <Skeleton className={`skeleton-file-name skeleton-width-${index % 3}`} />
                      <Skeleton className="skeleton-file-meta" />
                    </div>
                  </div>
                </td>
                <td className="file-size-column">
                  <Skeleton />
                </td>
                <td className="file-modified-column">
                  <Skeleton />
                </td>
                {!compact && (
                  <>
                    <td className="file-created-column">
                      <Skeleton />
                    </td>
                    <td className="file-owner-column">
                      <Skeleton />
                    </td>
                  </>
                )}
                <td className="file-actions-column">
                  <Skeleton />
                </td>
              </tr>
            ))}
          </tbody>
        </FileTable>
      )}
    </div>
  );
}
export function FileLoadError({ onRetry }: { onRetry: () => void }) {
  return <LoadError title="We couldn’t load these files." onRetry={onRetry} />;
}
