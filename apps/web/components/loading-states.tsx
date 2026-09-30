'use client';
import { useAppearance } from '../lib/appearance';
import { Skeleton } from './ui/skeleton';
import { FileCollectionSkeleton } from './file-collection';
export function ContentSkeleton({ label = 'Loading content' }: { label?: string }) {
  return (
    <div className="content-skeleton" role="status" aria-label={label} aria-busy="true">
      <span className="sr-only">{label}…</span>
      {[0, 1, 2].map((index) => (
        <div className="content-skeleton-row list-row" key={index}>
          <Skeleton className="skeleton-file-icon" />
          <div className="skeleton-file-text">
            <Skeleton className="skeleton-file-name" />
            <Skeleton className="skeleton-file-meta" />
          </div>
          <Skeleton className="skeleton-action" />
        </div>
      ))}
    </div>
  );
}
export function WorkspaceSkeleton() {
  useAppearance();
  return (
    <main className="app-shell workspace-loading" aria-label="Loading workspace" aria-busy="true">
      <aside className="sidebar" aria-hidden="true">
        <Skeleton className="skeleton-logo" />
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <Skeleton key={i} />
        ))}
      </aside>
      <div className="main-shell">
        <div className="topbar">
          <Skeleton />
        </div>
        <div className="workspace">
          <Skeleton className="skeleton-heading" />
          <FileCollectionSkeleton />
        </div>
      </div>
    </main>
  );
}
