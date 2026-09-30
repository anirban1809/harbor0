'use client';

import { useState } from 'react';
import { ArrowDownToLine, File, FileImage, FileText, Folder } from 'lucide-react';
import type { ManifestEntry, Transfer } from '@harbor/contracts';
import { Button } from './ui/button';
import { DataTable } from './ui/table';
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
function TransferDate({ value }: { value: string | null }) {
  return value ? (
    <time dateTime={value} title={new Date(value).toLocaleString()}>
      {new Date(value).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })}
    </time>
  ) : (
    <span className="muted">No expiry</span>
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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const received = direction === 'Received';
  const person = received ? t.sender : t.recipient;
  const entries = [...t.items, ...extra];
  const ready = t.preparationState !== 'BUILDING' && t.preparationState !== 'FAILED';
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
  return (
    <tr>
      <td className="transfer-name-cell">
        <div className="transfer-file-list">
          {entries.map((entry) => (
            <div className="transfer-file" key={entry.id}>
              <TransferFileIcon entry={entry} />
              <span className="transfer-file-label" title={entry.relativePath}>
                <strong>{entry.displayName}</strong>
              </span>
              {received && t.state === 'ACCEPTED' && ready && entry.itemType === 'FILE' && (
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
              )}
            </div>
          ))}
          {!entries.length &&
            (t.displayNames?.length ? t.displayNames : ['Files being prepared']).map(
              (name, index) => (
                <div className="transfer-file" key={`${index}:${name}`}>
                  <TransferFileIcon />
                  <strong>{name}</strong>
                </div>
              ),
            )}
        </div>
        {cursor && (
          <Button variant="ghost" size="sm" disabled={loading || busy} onClick={() => void more()}>
            {loading ? 'Loading…' : 'Load more files'}
          </Button>
        )}
        {error && <Alert tone="error">{error}</Alert>}
      </td>
      <td>
        <div className="transfer-contact">
          <strong>{person?.displayName ?? t.recipientEmail ?? 'Unknown recipient'}</strong>
          <small>{person ? `@${person.username}` : 'Account invitation'}</small>
        </div>
      </td>
      <td className="transfer-size-cell">{bytes(t.totalSizeBytes)}</td>
      <td>
        <TransferDate value={t.createdAt} />
      </td>
      <td>
        <TransferDate value={t.expiresAt} />
      </td>
      <td>
        <Badge
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
        {t.failure && (
          <Alert tone="error" role="none">
            {t.failure}
          </Alert>
        )}
      </td>
      <td>
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
          {received && t.state === 'ACCEPTED' && ready && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !!t.savedAt || t.saveState === 'SAVING'}
              onClick={() => void onAction(t, 'save')}
            >
              {t.savedAt ? 'Saved' : t.saveState === 'SAVING' ? 'Saving…' : 'Save to My Drive'}
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
          {((received && !['PENDING', 'ACCEPTED'].includes(t.state)) ||
            (!received && !t.state.startsWith('PENDING'))) && <span className="muted">—</span>}
        </div>
      </td>
    </tr>
  );
}

export function TransferTable(props: Props) {
  return (
    <DataTable
      align="top"
      className="transfer-table"
      containerClassName="transfer-table-scroll"
      label={`${props.direction} files`}
    >
      <caption className="sr-only">
        {props.direction} files and transfer details. Saved copies remain in My Drive after a
        transfer expires.
      </caption>
      <thead>
        <tr>
          <th scope="col">Files</th>
          <th scope="col">{props.direction === 'Received' ? 'From' : 'To'}</th>
          <th scope="col">Size</th>
          <th scope="col">Date sent</th>
          <th scope="col">Expires</th>
          <th scope="col">Status</th>
          <th scope="col">Actions</th>
        </tr>
      </thead>
      <tbody>
        {props.transfers.map((t) => (
          <TransferRow key={`${t.id}:${t.preparationState}`} {...props} transfer={t} />
        ))}
      </tbody>
    </DataTable>
  );
}
