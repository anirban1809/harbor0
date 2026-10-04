import { assertBackupMutable } from './backup-policy';
import { randomUUID } from 'node:crypto';
import type { ShareGrant } from '@harbor/contracts';
import { StorageService, userPK } from './domain';
import { Transaction, transact } from './repository';
import { assert } from './errors';
import { syncMembershipChanged } from './sync-relay';

export class SyncSharing {
  constructor(private service: StorageService) {}
  async invite(
    userId: string,
    input: {
      operationId: string;
      driveItemId: string;
      recipient: { type: 'USERNAME' | 'EMAIL'; value: string };
    },
  ) {
    return this.service.operation(
      userId,
      input.operationId,
      { action: 'syncInvite', ...input },
      async (tx) => {
        const item = await this.service.owned(tx, userId, input.driveItemId);
        await assertBackupMutable(tx, userId, item.id, true);
        assert(item.type === 'FOLDER', 'VALIDATION_ERROR', 'Choose a synced folder.');
        await tx.get(userPK(userId), 'SYNC_MEMBERSHIP');
        const mappings = await new Transaction(this.service.repo).list<{ folderIds: string[] }>(
          userPK(userId),
          'SYNCFOLDERS#',
        );
        assert(
          mappings.some((m) => m.folderIds.includes(item.id)),
          'INVALID_STATE',
          'Start syncing this folder before sharing it.',
          409,
        );
        const recipient = await this.service.resolveRecipient(tx, input.recipient);
        assert(
          recipient.recipientUserId && recipient.recipientUserId !== userId,
          'USER_NOT_FOUND',
          'Choose another registered account.',
          404,
        );
        const prior = await tx.get<ShareGrant>(
          userPK(recipient.recipientUserId),
          `ACCESS#${item.id}`,
        );
        if (prior?.syncState && !prior.revokedAt && prior.syncState !== 'DECLINED')
          return { share: prior };
        assert(
          !prior || prior.revokedAt || prior.syncState,
          'INVALID_STATE',
          'Remove the existing Drive share before inviting this account to sync.',
          409,
        );
        const shares = await new Transaction(this.service.repo).list<ShareGrant>(
          userPK(userId),
          'SHARE#',
        );
        assert(
          shares.filter((s) => s.syncState && !s.revokedAt && s.syncState !== 'DECLINED').length <
            20,
          'SHARE_LIMIT',
          'Up to 20 active sync invitations are supported per owner.',
          409,
        );
        const share: ShareGrant = {
          id: randomUUID(),
          driveItemId: item.id,
          ownerUserId: userId,
          recipientUserId: recipient.recipientUserId,
          permission: 'EDITOR',
          syncState: 'PENDING',
          createdAt: new Date().toISOString(),
          revokedAt: null,
        };
        const config = await tx.get<{ folderIds: string[] }>(userPK(userId), 'SYNC_SHARING');
        // Keep only active roots; old revision rows are harmless and preserve monotonicity.
        const folderIds = [
          ...new Set([
            ...shares
              .filter((s) => s.syncState && !s.revokedAt && s.syncState !== 'DECLINED')
              .map((s) => s.driveItemId),
            item.id,
          ]),
        ];
        await tx.put(userPK(userId), 'SYNC_SHARING', { ...config, folderIds });
        await this.save(tx, share);
        await syncMembershipChanged(tx, userId);
        await this.service.notification(tx, share.recipientUserId, 'SYNC_SHARE_INVITED', {
          shareId: share.id,
          name: item.name,
          itemId: item.id,
          itemName: item.name,
          actorName: await this.service.displayName(userId),
        });
        return { share };
      },
    );
  }
  private async save(tx: Transaction, share: ShareGrant) {
    await tx.put('SHARE', share.id, share);
    await tx.put(userPK(share.ownerUserId), `SHARE#${share.id}`, share);
    await tx.put(userPK(share.recipientUserId), `ACCESS#${share.driveItemId}`, share);
  }
  async respond(userId: string, id: string, action: 'ACCEPTED' | 'DECLINED') {
    return transact(this.service.repo, async (tx) => {
      const share = await tx.get<ShareGrant>('SHARE', id);
      assert(
        share?.syncState && share.recipientUserId === userId && !share.revokedAt,
        'FORBIDDEN',
        'This sync invitation is unavailable.',
        403,
      );
      const current = await tx.get<ShareGrant>(userPK(userId), `ACCESS#${share.driveItemId}`);
      assert(current?.id === id, 'FORBIDDEN', 'This invitation was replaced.', 403);
      assert(
        share.syncState === 'PENDING' || share.syncState === action,
        'INVALID_STATE',
        'This invitation has already been answered.',
        409,
      );
      await this.service.owned(tx, share.ownerUserId, share.driveItemId);
      share.syncState = action;
      await this.save(tx, share);
      await syncMembershipChanged(tx, share.ownerUserId);
      return { share };
    });
  }
  async list(userId: string) {
    const tx = new Transaction(this.service.repo);
    const shares = [
      ...(await tx.list<ShareGrant>(userPK(userId), 'ACCESS#')),
      ...(await tx.list<ShareGrant>(userPK(userId), 'SHARE#')),
    ].filter((s) => s.syncState && !s.revokedAt && s.syncState !== 'DECLINED');
    const items = [];
    for (const share of shares) {
      const item = await tx.get<import('@harbor/contracts').DriveItem>(
        userPK(share.ownerUserId),
        `ITEM#${share.driveItemId}`,
      );
      if (!item || item.deletedAt || item.syncRemovedAt) continue;
      const owner = await this.service.account(tx, share.ownerUserId);
      const recipient = await this.service.account(tx, share.recipientUserId);
      // Invitations reveal the root name, never its contents before acceptance.
      items.push({
        ...share,
        name: item.name,
        owner: { id: owner.id, username: owner.username, displayName: owner.displayName },
        recipient: {
          id: recipient.id,
          username: recipient.username,
          displayName: recipient.displayName,
        },
        direction: share.ownerUserId === userId ? ('SENT' as const) : ('RECEIVED' as const),
      });
    }
    return { items };
  }
  async status(userId: string, id: string) {
    const tx = new Transaction(this.service.repo);
    const share = await tx.get<ShareGrant>('SHARE', id);
    assert(
      share?.syncState === 'ACCEPTED' && !share.revokedAt && share.recipientUserId === userId,
      'SYNC_ACCESS_REMOVED',
      'Shared access ended. Your local files are preserved.',
      403,
    );
    const current = await tx.get<ShareGrant>(userPK(userId), `ACCESS#${share.driveItemId}`);
    assert(
      current?.id === id,
      'SYNC_ACCESS_REMOVED',
      'This invitation was replaced. Your local files are preserved.',
      403,
    );
    const { item: shared, access } = await this.service.authorized(
      tx,
      userId,
      share.driveItemId,
      true,
    );
    const item = await this.service.viewed(userId, shared, access, tx);
    const revision = await tx.get<{ sequence: number }>(
      userPK(share.ownerUserId),
      `SYNCFOLDERREV#${item.id}`,
    );
    return { share, item, sequence: revision?.sequence ?? 0 };
  }
}
