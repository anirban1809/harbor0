'use client';

import { useState } from 'react';
import { ArrowDownToLine, ChevronDown, File, FileImage, FileText, Folder } from 'lucide-react';
import type { ManifestEntry, Transfer } from '@harbor/contracts';
import { Button } from './ui/button';
import { Alert } from './ui/alert';
import { Badge } from './ui/badge';

export type TransferView = Transfer & {
  items: ManifestEntry[];
  nextEntryCursor?: string | null;
  sender: { displayName: string; username: string };
  recipient: { displayName: string; username: string } | null;
};
type Props = {
  transfers: TransferView[];
  direction: 'Received' | 'Sent';
  busy: boolean;
  onAction: (transfer: TransferView, action: string) => Promise<unknown>;
  onDownload: (transfer: TransferView, entry: ManifestEntry) => Promise<unknown>;
  loadEntries: (
    id: string,
    cursor: string,
  ) => Promise<{
    items: ManifestEntry[];
    nextCursor: string | null;
  }>;
};
const bytes = (n: number) =>
  n < 1000
    ? `${n} B`
    : n < 1e6
      ? `${(n / 1e3).toFixed(1)} KB`
      : n < 1e9
        ? `${(n / 1e6).toFixed(1)} MB`
        : `${(n / 1e9).toFixed(1)} GB`;
const shortDate = (value: string) =>
  new Date(value).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(new Date(value).getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }),
  });
function TransferDate({
  value,
  prefix = '',
  className,
}: {
  value: string;
  prefix?: string;
  className?: string;
}) {
  return (
    <time className={className} dateTime={value} title={new Date(value).toLocaleString()}>
      {prefix}
      {shortDate(value)}
    </time>
  );
}

function TransferFileIcon({ entry }: { entry?: ManifestEntry }) {
  const Icon =
    entry?.itemType === 'FOLDER'
      ? Folder
      : entry?.mimeType?.startsWith('image/')
        ? FileImage
        : entry?.mimeType?.includes('pdf') || entry?.mimeType?.startsWith('text/')
          ? FileText
          : File;
  return (
    <span
      className="file-entry-icon"
      data-kind={Icon === Folder ? 'folder' : Icon === FileImage ? 'image' : 'document'}
    >
      <Icon size={18} aria-hidden="true" />
    </span>
  );
}

function TransferRow({
  transfer: t,
  direction,
  busy,
  onAction,
  onDownload,
  loadEntries,
}: Omit<Props, 'transfers'> & { transfer: TransferView }) {
  const [extra, setExtra] = useState<ManifestEntry[]>([]);
  const [cursor, setCursor] = useState(t.nextEntryCursor);
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const received = direction === 'Received';
  const person = received ? t.sender : t.recipient;
  const entries = [...t.items, ...extra];
  const ready = t.preparationState !== 'BUILDING' && t.preparationState !== 'FAILED';
  const downloadable = received && t.state === 'ACCEPTED' && ready;
  // The row summarises the top-level items; nested files stay in the expanded list.
  const top = entries.filter((entry) => !entry.parentEntryId);
  const names = top.length
    ? top.map((entry) => entry.displayName)
    : (t.displayNames ?? []).length
      ? t.displayNames!
      : ['Files being prepared'];
  const single = entries.length === 1 && !cursor ? entries[0] : undefined;
  const expandable = entries.length > 1 || !!cursor;
  const status =
    t.preparationState === 'BUILDING'
      ? 'Preparing files'
      : t.preparationState === 'FAILED'
        ? 'Preparation failed'
        : t.saveState === 'SAVING'
          ? 'Saving…'
          : t.savedAt
            ? 'Saved to My Drive'
            : ({
                PENDING_RECIPIENT_SIGNUP: 'Waiting for sign-up',
                PENDING: received ? 'Waiting for you' : 'Waiting for recipient',
                ACCEPTED: 'Accepted',
                DECLINED: 'Declined',
                CANCELLED: 'Cancelled',
                EXPIRED: 'Expired',
              }[t.state] ?? t.state);
  const showExpiry =
    !!t.expiresAt &&
    !t.savedAt &&
    ['PENDING', 'PENDING_RECIPIENT_SIGNUP', 'ACCEPTED'].includes(t.state);
  async function more() {
    if (!cursor) return;
    setLoading(true);
    setError('');
    try {
      const page = await loadEntries(t.id, cursor);
      setExtra((previous) => [...previous, ...page.items]);
      setCursor(page.nextCursor);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  const download = (entry: ManifestEntry) => (
    <Button
      variant="ghost"
      size="icon-sm"
      disabled={busy}
      aria-label={`Download ${entry.displayName}`}
      title={`Download ${entry.displayName}`}
      onClick={() => void onDownload(t, entry)}
    >
      <ArrowDownToLine size={16} />
    </Button>
  );
  return (
    <li className="transfer-row">
      <div className="transfer-summary">
        <TransferFileIcon entry={top[0] ?? entries[0]} />
        <div className="transfer-text">
          <strong className="transfer-title" title={names.join(', ')}>
            <span>{names[0]}</span>
            {names.length > 1 && <span className="muted"> and {names.length - 1} more</span>}
          </strong>
          <span className="transfer-meta">
            <span title={person ? `@${person.username}` : undefined}>
              {received ? 'From' : 'To'}{' '}
              {person?.displayName ?? t.recipientEmail ?? 'Unknown recipient'}
            </span>
            <span>{bytes(t.totalSizeBytes)}</span>
            <TransferDate className="transfer-sent-date" value={t.createdAt} prefix="Sent " />
            {showExpiry && <TransferDate value={t.expiresAt!} prefix="Expires " />}
          </span>
        </div>
        <Badge
          className="transfer-status"
          tone={
            t.preparationState === 'FAILED'
              ? 'danger'
              : t.state === 'ACCEPTED'
                ? 'success'
                : t.state.startsWith('PENDING')
                  ? 'accent'
                  : 'neutral'
          }
        >
          {status}
        </Badge>
        <div className="transfer-actions">
          {received && t.state === 'PENDING' && ready && (
            <>
              <Button size="sm" disabled={busy} onClick={() => void onAction(t, 'accept')}>
                Accept
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void onAction(t, 'decline')}
              >
                Decline
              </Button>
            </>
          )}
          {downloadable && !t.savedAt && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy || t.saveState === 'SAVING'}
              onClick={() => void onAction(t, 'save')}
            >
              {t.saveState === 'SAVING' ? 'Saving…' : 'Save to My Drive'}
            </Button>
          )}
          {!received &&
            t.preparationState !== 'BUILDING' &&
            ['PENDING', 'PENDING_RECIPIENT_SIGNUP'].includes(t.state) && (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void onAction(t, 'cancel')}
              >
                Cancel transfer
              </Button>
            )}
          {downloadable && single?.itemType === 'FILE' && download(single)}
          {expandable && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-expanded={expanded}
              aria-controls={`transfer-files-${t.id}`}
              aria-label={expanded ? 'Hide files' : 'Show files'}
              title={expanded ? 'Hide files' : 'Show files'}
              onClick={() => setExpanded((open) => !open)}
            >
              <ChevronDown size={16} className="transfer-chevron" data-open={expanded} />
            </Button>
          )}
        </div>
      </div>
      {expanded && (
        <div className="transfer-files" id={`transfer-files-${t.id}`}>
          {entries.map((entry) => (
            <div className="transfer-file" key={entry.id} data-nested={!!entry.parentEntryId}>
              <TransferFileIcon entry={entry} />
              <span className="transfer-file-label" title={entry.relativePath}>
                {entry.displayName}
              </span>
              {entry.itemType === 'FILE' && (
                <span className="transfer-file-size">{bytes(entry.sizeBytes)}</span>
              )}
              {downloadable && entry.itemType === 'FILE' && download(entry)}
            </div>
          ))}
          {cursor && (
            <Button
              variant="ghost"
              size="sm"
              disabled={loading || busy}
              onClick={() => void more()}
            >
              {loading ? 'Loading…' : 'Load more files'}
            </Button>
          )}
        </div>
      )}
      {(t.failure || error) && (
        <Alert tone="error" role={t.failure && !error ? 'none' : undefined}>
          {error || t.failure}
        </Alert>
      )}
    </li>
  );
}

export function TransferTable(props: Props) {
  return (
    <ul className="transfer-rows" aria-label={`${props.direction} files`}>
      {props.transfers.map((t) => (
        <TransferRow key={`${t.id}:${t.preparationState}`} {...props} transfer={t} />
      ))}
    </ul>
  );
}
