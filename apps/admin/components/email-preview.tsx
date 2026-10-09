'use client';
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { CampaignContent } from '../../../packages/contracts/src/campaigns';
import { Alert } from '../../web/components/ui/alert';
import { Segmented } from '../../web/components/ui/segmented';
import { Skeleton } from '../../web/components/ui/skeleton';
import { api } from '../lib/api';

/** Waits for typing to pause before previewing, so each keystroke isn't a request. */
function useSettled<T>(value: T, ms = 400) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/**
 * The email exactly as the backend renders it, in a sandboxed frame with no scripts. Variables
 * come from `sampleUserId`'s account, or stand-in values without one.
 */
export function EmailPreview({
  content,
  sampleUserId,
}: {
  content: CampaignContent;
  sampleUserId?: string;
}) {
  const [width, setWidth] = useState<'desktop' | 'mobile'>('desktop');
  const [format, setFormat] = useState<'html' | 'text'>('html');
  // Only the content fields: callers may pass a whole template, and the endpoint is strict.
  const settled = useSettled({
    subject: content.subject,
    preheader: content.preheader,
    markdown: content.markdown,
    category: content.category,
    sampleUserId,
  });
  const ready = !!settled.subject.trim() && !!settled.markdown.trim();
  const preview = useQuery({
    queryKey: ['email-preview', settled],
    queryFn: () => api.preview(settled),
    enabled: ready,
    placeholderData: (previous) => previous,
  });
  return (
    <div className="admin-preview">
      <div className="admin-preview-bar">
        <Segmented
          label="Format"
          value={format}
          onValueChange={setFormat}
          options={[
            { value: 'html', label: 'Email' },
            { value: 'text', label: 'Plain text' },
          ]}
        />
        {format === 'html' && (
          <Segmented
            label="Width"
            value={width}
            onValueChange={setWidth}
            options={[
              { value: 'desktop', label: 'Desktop' },
              { value: 'mobile', label: 'Phone' },
            ]}
          />
        )}
      </div>
      {!ready ? (
        <p className="admin-empty">Add a subject and a message to see the preview.</p>
      ) : preview.error ? (
        <Alert tone="error">{preview.error.message}</Alert>
      ) : !preview.data ? (
        <Skeleton className="admin-skeleton-block" />
      ) : (
        <>
          {preview.data.problems.map((p) => (
            <Alert key={p} tone="warning" role="none">
              {p}
            </Alert>
          ))}
          <div className="admin-preview-subject">
            <span className="admin-muted">Subject</span>
            <strong>{preview.data.subject}</strong>
          </div>
          {format === 'html' ? (
            <iframe
              title="Email preview"
              className="admin-preview-frame"
              data-width={width}
              sandbox=""
              srcDoc={preview.data.html}
            />
          ) : (
            <pre className="admin-preview-text">{preview.data.text}</pre>
          )}
        </>
      )}
    </div>
  );
}
