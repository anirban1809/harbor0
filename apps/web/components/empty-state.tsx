'use client';

import { useId, type ReactNode } from 'react';
import {
  ArrowUpFromLine,
  Folder,
  FolderPlus,
  RefreshCw,
  Search,
  Trash2,
  WifiOff,
} from 'lucide-react';
import { Button } from './ui/button';

export function EmptyState({
  icon,
  title,
  description,
  actions,
  compact = false,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  actions?: ReactNode;
  compact?: boolean;
}) {
  const id = useId();
  return (
    <section className="empty-state" data-compact={compact} aria-labelledby={id}>
      <div className="empty-state-icon" aria-hidden="true">
        {icon}
      </div>
      <div className="empty-state-copy">
        <h3 id={id}>{title}</h3>
        <p>{description}</p>
      </div>
      {actions && <div className="empty-state-actions">{actions}</div>}
    </section>
  );
}

export function LoadError({
  onRetry,
  title = 'This view couldn’t be loaded.',
  compact = false,
}: {
  onRetry: () => void;
  title?: string;
  compact?: boolean;
}) {
  return (
    <EmptyState
      compact={compact}
      icon={<WifiOff />}
      title={title}
      description="Your data hasn’t changed. Check your connection and try again."
      actions={
        <Button type="button" variant="outline" onClick={onRetry}>
          <RefreshCw />
          Try again
        </Button>
      }
    />
  );
}

export function FileEmptyState({
  section,
  search = false,
  inFolder = false,
  busy = false,
  onUpload,
  onCreateFolder,
  onBrowse,
  onClearSearch,
}: {
  section: string;
  search?: boolean;
  inFolder?: boolean;
  desktop?: boolean;
  busy?: boolean;
  onUpload: () => void;
  onCreateFolder: () => void;
  onBrowse: () => void;
  onClearSearch?: () => void;
}) {
  if (search)
    return (
      <EmptyState
        icon={<Search />}
        title="No matching files"
        description="Try a different name or clear your search to see your files again."
        actions={
          <Button variant="outline" onClick={onClearSearch}>
            Clear search
          </Button>
        }
      />
    );
  const views: Record<string, { icon: ReactNode; title: string; description: string }> = {
    Trash: {
      icon: <Trash2 />,
      title: 'Trash is empty',
      description:
        'Files you move to trash will appear here. You can restore them or delete them permanently.',
    },
  };
  const view = views[section];
  if (view)
    return (
      <EmptyState
        {...view}
        actions={
          <Button variant="outline" onClick={onBrowse}>
            Browse My Drive
          </Button>
        }
      />
    );
  return (
    <EmptyState
      icon={<Folder />}
      title={inFolder ? 'This folder is empty' : 'No files'}
      description={
        inFolder
          ? 'Upload files or create a folder.'
          : 'Upload files to access them across your devices.'
      }
      actions={
        <>
          <Button disabled={busy} onClick={onUpload}>
            <ArrowUpFromLine />
            Upload files
          </Button>
          <Button variant="outline" disabled={busy} onClick={onCreateFolder}>
            <FolderPlus />
            Create a folder
          </Button>
        </>
      }
    />
  );
}
