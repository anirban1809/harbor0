'use client';
import { useEffect, useRef, type ReactNode } from 'react';
import { File, FileImage, FileText, Folder, Star, Trash2 } from 'lucide-react';
import { fileDate, fileKind, fileSize, fileSummary, type FileEntry } from '../lib/file-metadata';
import { Skeleton } from './ui/skeleton';
import { LoadError } from './empty-state';
import { DataTable } from './ui/data-table';

function FileTable({
  compact,
  children,
  label = 'Drive files',
}: {
  compact?: boolean;
  children: ReactNode;
  label?: string;
}) {
  return compact ? (
    <DataTable
      className="files-table drive-data-table"
      containerClassName="files-table-scroll"
      label={label}
    >
      {children}
    </DataTable>
  ) : (
    <div className="files-table-scroll">
      <table className="files-table">{children}</table>
    </div>
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
    <input
      ref={ref}
      type="checkbox"
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
        <span className="file-entry-icon">
          <Icon size={22} aria-hidden="true" />
        </span>
        <span className="file-entry-label">
          <strong>{item.name}</strong>
          {!compact && <small title={item.mimeType ?? undefined}>{fileKind(item)}</small>}
        </span>
      </button>
      {item.favorite && <Star className="file-favorite" size={14} aria-label="Favorite" />}
      {item.deletedAt && <Trash2 size={14} className="muted" aria-label="In trash" />}
    </>
  );
}
type Props<T extends FileEntry> = {
  items: T[];
  userId?: string;
  grid?: boolean;
  trash?: boolean;
  selected?: string[];
  onSelectionChange?: (ids: string[]) => void;
  onOpen: (item: T) => void;
  renderActions: (item: T) => ReactNode;
  renderStatus?: (item: T) => ReactNode;
  statusColumn?: boolean;
  canOpen?: (item: T) => boolean;
  refreshing?: boolean;
  compact?: boolean;
  label?: string;
};
export function FileCollection<T extends FileEntry>({
  items,
  userId,
  grid,
  trash,
  selected = [],
  onSelectionChange,
  onOpen,
  renderActions,
  renderStatus,
  statusColumn = false,
  canOpen,
  refreshing,
  compact = false,
  label,
}: Props<T>) {
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
                (event.currentTarget.parentElement?.children[index] as HTMLElement)?.focus();
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
          <input
            type="checkbox"
            aria-label={`Select ${item.name}`}
            checked={selected.includes(item.id)}
            onChange={(event) => select(item, (event.nativeEvent as MouseEvent).shiftKey, true)}
          />
        )}
        <FileIdentity
          item={item}
          compact={compact && grid}
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
          {items.map((item) => (
            <article
              className={`file-entry-card ${selected.includes(item.id) ? 'is-selected' : ''}`}
              key={item.id}
              {...rowEvents(item)}
            >
              {identity(item)}
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
        <FileTable compact={compact} label={label}>
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
                <span className={compact ? undefined : 'sr-only'}>Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr
                key={item.id}
                {...rowEvents(item)}
                aria-selected={compact ? selected.includes(item.id) : undefined}
                className={`file-entry-row ${selected.includes(item.id) ? 'is-selected' : ''}`}
              >
                <td>{identity(item)}</td>
                {statusColumn && (
                  <td className="file-sync-column">
                    {renderStatus?.(item) || <span className="muted">—</span>}
                  </td>
                )}
                <td className="file-size-column">
                  {item.type === 'FOLDER' ? (
                    <span title="Folder size is not calculated">—</span>
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
  compact = false,
}: {
  grid?: boolean;
  compact?: boolean;
}) {
  return (
    <div className="files-collection" role="status" aria-label="Loading files" aria-busy="true">
      <span className="sr-only">Loading files…</span>
      {grid ? (
        <div className="files-view-grid">
          {Array.from({ length: 6 }, (_, index) => (
            <div key={index} className="file-entry-card">
              <Skeleton className="skeleton-file-icon" />
              <Skeleton className="skeleton-file-name" />
              <Skeleton className="skeleton-file-meta" />
              <Skeleton className="skeleton-file-meta" />
            </div>
          ))}
        </div>
      ) : (
        <FileTable compact={compact}>
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
              <th className="file-actions-column">{compact && 'Actions'}</th>
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
