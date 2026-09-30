import type { ShareGrant } from '@harbor/contracts';
import type { TransferView } from '../../web/components/transfer-table';

export type SyncInvitation = ShareGrant & {
  name: string;
  direction: 'SENT' | 'RECEIVED';
  owner: { username: string; displayName: string };
  recipient: { username: string; displayName: string };
};
export type IncomingContent =
  { kind: 'transfer'; item: TransferView } | { kind: 'sync'; item: SyncInvitation };

// Runs in the main process, including while the window is hidden in the tray.
export class IncomingMonitor {
  private running = false;
  private stopped = false;
  private seen: Set<string>;
  constructor(
    private options: {
      request: (path: string) => Promise<any>;
      seen: string[];
      save: (seen: string[]) => void;
      notify: (content: IncomingContent) => boolean | Promise<boolean>;
      active: () => boolean;
    },
  ) {
    this.seen = new Set(options.seen);
  }
  stop() {
    this.stopped = true;
  }
  retry(content: IncomingContent) {
    if (!this.active()) return;
    this.seen.delete(`${content.kind}:${content.item.id}`);
    this.options.save([...this.seen]);
  }
  private active() {
    return !this.stopped && this.options.active();
  }
  private async deliver(content: IncomingContent) {
    const key = `${content.kind}:${content.item.id}`;
    if (!this.active() || this.seen.has(key)) return;
    if ((await this.options.notify(content)) && this.active()) {
      this.seen.add(key);
      this.options.save([...this.seen]);
    }
  }
  async poll() {
    if (this.running || !this.active()) return;
    this.running = true;
    try {
      // Independent sources: a transfer failure must not suppress sync invitations.
      await Promise.allSettled([this.transfers(), this.shares()]);
    } finally {
      this.running = false;
    }
  }
  private async transfers() {
    let cursor: string | undefined;
    const cursors = new Set<string>();
    do {
      const page = await this.options.request(
        '/v1/transfers/received?state=PENDING' +
          (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''),
      );
      if (!this.active()) return;
      for (const item of page.items as TransferView[]) {
        if (
          item.state === 'PENDING' &&
          item.preparationState !== 'BUILDING' &&
          item.preparationState !== 'FAILED' &&
          (!item.expiresAt || Date.parse(item.expiresAt) > Date.now())
        )
          await this.deliver({ kind: 'transfer', item });
      }
      cursor = page.nextCursor ?? undefined;
      if (cursor && cursors.has(cursor)) break;
      if (cursor) cursors.add(cursor);
    } while (cursor && this.active());
  }
  private async shares() {
    const page = await this.options.request('/v1/sync/shares');
    if (!this.active()) return;
    for (const item of page.items as SyncInvitation[]) {
      if (item.direction === 'RECEIVED' && item.syncState === 'PENDING' && !item.revokedAt)
        await this.deliver({ kind: 'sync', item });
    }
  }
}
