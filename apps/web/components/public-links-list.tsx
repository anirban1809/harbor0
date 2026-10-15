'use client';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Link2, Lock } from 'lucide-react';
import type { Transport } from '@harbor/api-client';
import type { PublicLink } from '@harbor/contracts';
import { fileIcon } from '../lib/file-icon';
import { fileDate } from '../lib/file-metadata';
import { EmptyState, LoadError } from './empty-state';
import { ContentSkeleton } from './loading-states';
import { PublicLinkDialog, linkEnds, useCopy } from './public-link-dialog';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card } from './ui/card';

/**
 * Shared → Links: every public link that works now, newest first, to copy, change or turn off
 * without finding each item in My Drive.
 */
export function PublicLinksList({
  request,
  onBrowse,
}: {
  request: Transport;
  onBrowse: () => void;
}) {
  const queries = useQueryClient();
  const links = useQuery<PublicLink[]>({
    queryKey: ['public-links'],
    queryFn: async () => (await request('/v1/links')).items,
  });
  const { copied, copy } = useCopy();
  const [managing, setManaging] = useState<PublicLink>();

  if (links.isPending) return <ContentSkeleton label="Loading links" />;
  if (links.isError && !links.data) return <LoadError onRetry={() => void links.refetch()} />;
  if (!links.data.length)
    return (
      <EmptyState
        icon={<Link2 />}
        title="No public links"
        description="Choose a file or folder in My Drive and select “Get public link” from its menu. Anyone with the link can download it, without an account."
        actions={
          <Button variant="outline" onClick={onBrowse}>
            Browse My Drive
          </Button>
        }
      />
    );
  return (
    <Card
      title="Public links"
      description="Anyone with one of these links can open what it shares. Turning a link off stops it at once."
    >
      <div className="public-links">
        {links.data.map((link) => {
          const { Icon, kind } = fileIcon({ type: link.itemType, name: link.itemName ?? '' });
          const soon = !!link.expiresAt && Date.parse(link.expiresAt) - Date.now() < 2 * 86400_000;
          return (
            <article className="list-row public-link-row" key={link.id}>
              <span className="file-entry-icon" data-kind={kind}>
                <Icon aria-hidden="true" />
              </span>
              <span className="list-row-text">
                <strong>{link.itemName ?? 'Item no longer available'}</strong>
                <small>
                  {link.itemType === 'FOLDER' ? 'Folder' : 'File'} · Made{' '}
                  {fileDate(link.createdAt).date}
                </small>
              </span>
              <span className="public-link-row-state">
                <Badge tone={soon ? 'warning' : 'neutral'}>{linkEnds(link.expiresAt)}</Badge>
                {link.hasPassword && (
                  <Badge>
                    <Lock aria-hidden="true" /> Password
                  </Badge>
                )}
              </span>
              <span className="list-row-actions">
                <Button variant="outline" size="sm" onClick={() => void copy(link.id, link.url)}>
                  {copied === link.id ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
                  {copied === link.id ? 'Copied' : 'Copy link'}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!link.itemName}
                  onClick={() => setManaging(link)}
                >
                  Manage
                </Button>
              </span>
            </article>
          );
        })}
      </div>
      {managing && (
        <PublicLinkDialog
          request={request}
          item={{
            id: managing.driveItemId,
            name: managing.itemName ?? '',
            type: managing.itemType,
          }}
          onClose={() => {
            setManaging(undefined);
            // The dialog may have changed an expiry or password, or turned the link off.
            void queries.invalidateQueries({ queryKey: ['public-links'] });
          }}
        />
      )}
    </Card>
  );
}
