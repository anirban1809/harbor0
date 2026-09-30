'use client';
import { useEffect, useState } from 'react';
import { ArrowDownToLine, FileQuestion, LoaderCircle, Music } from 'lucide-react';
import { fileDate, fileKind, fileSize, type FileEntry } from '../lib/file-metadata';
import { previewKind, type PreviewContent, type PreviewLoader } from '../lib/file-preview';
import { Drawer } from './ui/dialog';
import { previewCache, previewCacheKey } from '../lib/preview-cache';
import { Button } from './ui/button';

export function FilePreview({
  item,
  cacheScope,
  load,
  onDownload,
  onClose,
}: {
  item: FileEntry;
  cacheScope: string;
  load: PreviewLoader;
  onDownload: () => void;
  onClose: () => void;
}) {
  const [opener] = useState(() => document.activeElement as HTMLElement | null);
  return (
    <Drawer
      open
      modal={false}
      className="file-preview-tray"
      title={item.name}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      finalFocus={() => {
        const fallback = Array.from(
          document.querySelectorAll<HTMLElement>('.file-entry-open'),
        ).find((button) => button.dataset.fileId === item.id);
        return fallback ?? (opener?.isConnected ? opener : null);
      }}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Close preview
          </Button>
          <Button onClick={onDownload}>
            <ArrowDownToLine />
            Download
          </Button>
        </>
      }
    >
      <PreviewBody
        key={previewCacheKey(cacheScope, item)}
        item={item}
        cacheScope={cacheScope}
        load={load}
      />
      <section className="file-preview-info" aria-label="File information">
        <h3>File information</h3>
        <dl className="details">
          {[
            ['Type', fileKind(item)],
            ['Size', fileSize(item.sizeBytes)],
            ...(item.createdAt ? [['Created', fileDate(item.createdAt).full]] : []),
            ...(item.updatedAt ? [['Modified', fileDate(item.updatedAt).full]] : []),
          ].map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      </section>
    </Drawer>
  );
}

function PreviewBody({
  item,
  load,
  cacheScope,
}: {
  item: FileEntry;
  load: PreviewLoader;
  cacheScope: string;
}) {
  const cache = previewCache(load);
  const key = previewCacheKey(cacheScope, item);
  const kind = previewKind(item);
  const [content, setContent] = useState<PreviewContent | undefined>(() => cache.get(key));
  const [error, setError] = useState('');
  const [ready, setReady] = useState(() => {
    const cached = cache.get(key);
    return !!cached && 'text' in cached;
  });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const cached = cache.get(key);
    setContent(cached);
    setError('');
    setReady(!!cached && 'text' in cached);
    if (kind)
      void cache
        .load(
          key,
          async () => {
            // The request is shared across closes/reopens; only the subscriber is cancelled.
            const result = await load(item, new AbortController().signal);
            return result;
          },
          kind === 'text' ? 5 * 60_000 : 30_000,
        )
        .then((result) => {
          if (controller.signal.aborted) return;
          setContent(result);
          if ('text' in result) setReady(true);
        })
        .catch(() => {
          if (!controller.signal.aborted)
            setError('Could not load this preview. Check your connection and try again.');
        });
    return () => controller.abort();
  }, [item.id, item.name, item.mimeType, item.sizeBytes, load, kind, attempt, cache, key]);
  const mediaError = () =>
    setError(
      'This file could not be displayed. Its format may not be supported, or the preview link may have expired. Try again or download the file.',
    );
  return (
    <div className="file-preview-body">
      {!kind ? (
        <div className="file-preview-message">
          <FileQuestion aria-hidden="true" />
          <p>No preview available for this file type. Download it to open it on your device.</p>
        </div>
      ) : error ? (
        <div className="file-preview-message" role="alert">
          <p>{error}</p>
          <Button
            variant="outline"
            onClick={() => {
              cache.delete(key);
              setAttempt((value) => value + 1);
            }}
          >
            Try again
          </Button>
        </div>
      ) : (
        <>
          {!ready && (
            <div className="file-preview-loading" role="status">
              <LoaderCircle className="spin" size={18} />
              Loading preview…
            </div>
          )}
          {content && 'text' in content && (
            <>
              {content.truncated && (
                <p className="file-preview-notice">
                  Showing the first 1 MB. Download to read the full file.
                </p>
              )}
              {content.text === '' ? (
                <p className="file-preview-message">This text file is empty.</p>
              ) : (
                <pre className="file-preview-text" tabIndex={0} aria-label="Text preview">
                  {content.text}
                </pre>
              )}
            </>
          )}
          {content && 'url' in content && kind === 'image' && (
            <img
              className="file-preview-image"
              src={content.url}
              alt={item.name}
              referrerPolicy="no-referrer"
              onLoad={() => setReady(true)}
              onError={mediaError}
            />
          )}
          {content && 'url' in content && kind === 'video' && (
            <video
              className="file-preview-video"
              src={content.url}
              controls
              playsInline
              preload="metadata"
              aria-label={`Video preview: ${item.name}`}
              onLoadedMetadata={() => setReady(true)}
              onError={mediaError}
            />
          )}
          {content && 'url' in content && kind === 'audio' && (
            <div className="file-preview-audio">
              <Music size={48} aria-hidden="true" />
              <audio
                src={content.url}
                controls
                preload="metadata"
                aria-label={`Audio preview: ${item.name}`}
                onLoadedMetadata={() => setReady(true)}
                onError={mediaError}
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}
