'use client';
import { useEffect, useRef } from 'react';
import { Button } from './ui/button';

/** Load another page near the viewport, with an accessible manual fallback. */
export function LoadMoreFiles({
  loading,
  onLoad,
  error,
}: {
  loading: boolean;
  onLoad: () => void;
  error?: boolean;
}) {
  const marker = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (loading || error || !marker.current || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer.disconnect();
          onLoad();
        }
      },
      { rootMargin: '240px' },
    );
    observer.observe(marker.current);
    return () => observer.disconnect();
  }, [loading, error, onLoad]);
  return (
    <div ref={marker} className="file-pagination">
      <Button variant="outline" disabled={loading} onClick={onLoad}>
        {loading ? 'Loading more files…' : error ? 'Retry loading more files' : 'Load more files'}
      </Button>
    </div>
  );
}
