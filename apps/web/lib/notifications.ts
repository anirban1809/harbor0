import { sharedHref, workspaceRoutes } from './routes';

export type ServerNotification = {
  id: string;
  type: string;
  data?: {
    actorName?: string;
    itemName?: string;
    itemId?: string;
    transferId?: string;
    shareId?: string;
  } & Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
};

const sentence = (value: string) => {
  const text = value.replaceAll('_', ' ').toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
};

/** What a server notification says and where it leads, from its type and the names it carries. */
export function describeNotification(n: ServerNotification): { title: string; href?: string } {
  const actor = n.data?.actorName || 'Someone';
  const named = n.data?.itemName ? `“${n.data.itemName}”` : undefined;
  const received = sharedHref('Received');
  const sent = sharedHref('Sent');
  switch (n.type) {
    case 'TRANSFER_RECEIVED':
      return { title: `${actor} sent you ${named ?? 'files'}`, href: received };
    case 'TRANSFER_ACCEPTED':
      return { title: `${actor} accepted ${named ?? 'your transfer'}`, href: sent };
    case 'TRANSFER_DECLINED':
      return { title: `${actor} declined ${named ?? 'your transfer'}`, href: sent };
    case 'TRANSFER_CANCELLED':
      return {
        title: `${actor} cancelled ${named ? `the transfer of ${named}` : 'a transfer to you'}`,
        href: received,
      };
    case 'TRANSFER_EXPIRED':
      return { title: `Your transfer${named ? ` of ${named}` : ''} expired`, href: sent };
    case 'SHARE_RECEIVED':
      return { title: `${actor} shared ${named ?? 'an item'} with you`, href: received };
    case 'SHARE_REVOKED':
      return {
        title: `${actor} removed your access to ${named ?? 'a shared item'}`,
        href: received,
      };
    case 'SHARED_UPLOAD_BLOCKED_BY_STORAGE':
      return {
        title: `${actor} couldn’t upload to ${named ?? 'your shared folder'} because your storage is full`,
        href: workspaceRoutes.Storage,
      };
    default:
      return {
        title: n.data?.itemName ? `${sentence(n.type)}: ${n.data.itemName}` : sentence(n.type),
      };
  }
}

/** Newest first, whatever order the server lists them in. */
export const newestFirst = <T extends { createdAt: string }>(items: T[]) =>
  [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
