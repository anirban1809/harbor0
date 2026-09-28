'use client';
import { useEffect, useState } from 'react';
import { ArrowDownToLine, FileQuestion, LoaderCircle, Music } from 'lucide-react';
import { fileKind, fileSize, type FileEntry } from '../lib/file-metadata';
import { previewKind, type PreviewContent, type PreviewLoader } from '../lib/file-preview';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from './ui/dialog-primitives';
import { Button } from './ui/button';

export function FilePreview({
  item,
  load,
  onDownload,
  onClose,
}: {
  item: FileEntry;
  load: PreviewLoader;
  onDownload: () => void;
  onClose: () => void;
}) {
  const [opener] = useState(() => document.activeElement as HTMLElement | null);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="file-preview-dialog"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const fallback = Array.from(
            document.querySelectorAll<HTMLElement>('.file-entry-open'),
          ).find((button) => button.dataset.fileId === item.id);
          (opener?.isConnected && opener !== document.body ? opener : fallback)?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle className="file-preview-title">{item.name}</DialogTitle>
          <DialogDescription>
            {fileKind(item)} · {fileSize(item.sizeBytes)}
          </DialogDescription>
        </DialogHeader>
        <PreviewBody key={item.id} item={item} load={load} />
        <div className="dialog-actions">
          <Button variant="outline" onClick={onClose}>
            Close preview
          </Button>
          <Button onClick={onDownload}>
            <ArrowDownToLine size={16} />
            Download
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function PreviewBody({ item, load }: { item: FileEntry; load: PreviewLoader }) {
  const kind = previewKind(item);
  const [content, setContent] = useState<PreviewContent>();
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setContent(undefined);
    setError('');
    setReady(false);
    if (kind)
      void load(item, controller.signal)
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
  }, [item.id, item.name, item.mimeType, item.sizeBytes, load, kind, attempt]);
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
          <Button variant="outline" onClick={() => setAttempt((value) => value + 1)}>
            Try again
          </Button>
        </div>
      ) : (
        <>
          {!ready && (
            <div className="file-preview-loading" role="status">
              <LoaderCircle className="animate-spin" size={20} />
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
