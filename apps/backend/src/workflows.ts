import { assertBackupMutable } from './backup-policy';
import { randomUUID, createHash } from 'node:crypto';
import type { DriveItem, FileVersion, ManifestEntry, Transfer } from '@harbor/contracts';
import { storageUsage } from '@harbor/contracts';
import { StorageService, userPK } from './domain';
import { Transaction, transact } from './repository';
import { assert, DomainError } from './errors';
const now = () => new Date().toISOString();
type ExtendedTransfer = Transfer & {
  preparationState?: 'BUILDING' | 'READY' | 'FAILED';
  saveState?: 'SAVING' | 'SAVED' | 'FAILED';
  failure?: string;
};
type Build = {
  id: string;
  pending: number;
  state: 'BUILDING' | 'READY' | 'FAILED';
  senderUserId: string;
  sourceSequence?: number;
  error?: string;
  cleanupCursor?: string;
};
type Work = {
  sourceId: string;
  parentEntryId: string | null;
  path: string;
  cursor?: string;
  revision?: number;
};
export type Save = {
  id: string;
  userId: string;
  targetParentId: string | null;
  bytes: number;
  state: 'SAVING' | 'COMPLETED' | 'FAILED';
  cursor?: string;
  error?: string;
  cleanupCursor?: string;
};
export type StagedItem = DriveItem & { stagingId?: string };
const deterministicId = (transferId: string, entryId: string) =>
  createHash('sha256').update(`save:${transferId}:${entryId}`).digest('hex').slice(0, 32);
export class TransferWorkflows {
  constructor(private service: StorageService) {}
  async create(
    userId: string,
    input: {
      operationId: string;
      recipient: { type: 'USERNAME' | 'EMAIL'; value: string };
      items: { driveItemId: string }[];
    },
  ) {
    const s = this.service;
    return s.operation(userId, input.operationId, { action: 'transfer', ...input }, async (tx) => {
      const resolved = await s.resolveRecipient(tx, input.recipient);
      assert(
        resolved.recipientUserId !== userId,
        'TRANSFER_NOT_ALLOWED',
        'Choose another recipient.',
      );
      const roots = new Set(input.items.map((i) => i.driveItemId));
      assert(roots.size === input.items.length, 'VALIDATION_ERROR', 'Select each item only once.');
      const displayNames: string[] = [];
      for (const id of roots) {
        const item = await s.owned(tx, userId, id);
        displayNames.push(item.name);
        let parent = item.parentId;
        while (parent) {
          assert(
            !roots.has(parent),
            'VALIDATION_ERROR',
            'A selected folder already includes a selected file.',
          );
          parent = (await s.owned(tx, userId, parent)).parentId;
        }
      }
      const t: ExtendedTransfer = {
        displayNames,
        id: randomUUID(),
        senderUserId: userId,
        ...resolved,
        state: resolved.recipientUserId ? 'PENDING' : 'PENDING_RECIPIENT_SIGNUP',
        preparationState: 'BUILDING',
        createdAt: now(),
        acceptedAt: null,
        declinedAt: null,
        cancelledAt: null,
        expiresAt: new Date(Date.now() + 30 * 86400_000).toISOString(),
        totalSizeBytes: 0,
        savedAt: null,
      };
      await tx.put('TRANSFER', t.id, t);
      await tx.put(`BUILD#${t.id}`, 'META', {
        id: t.id,
        pending: roots.size,
        state: 'BUILDING',
        senderUserId: userId,
      } satisfies Build);
      for (const sourceId of roots)
        await tx.put(`BUILD#${t.id}`, `WORK#${sourceId}`, {
          sourceId,
          parentEntryId: null,
          path: '',
        } satisfies Work);
      await tx.put(userPK(userId), `SENT#${t.id}`, { id: t.id });
      await s.job(tx, {
        id: `build-${t.id}`,
        type: 'TRANSFER_BUILD',
        entityId: t.id,
        userId,
        dueAt: now(),
        attempts: 0,
      });
      await s.record(tx, userId, 'TRANSFER_PREPARING', t.id);
      const build = (await tx.get<Build>(`BUILD#${t.id}`, 'META'))!;
      build.sourceSequence = (await s.account(tx, userId)).sequence;
      await tx.put(`BUILD#${t.id}`, 'META', build);
      return { transfer: t };
    });
  }
  async build(id: string) {
    const s = this.service;
    for (let step = 0; step < 40; step++) {
      const meta = await new Transaction(s.repo).get<Build>(`BUILD#${id}`, 'META');
      if (!meta || meta.state === 'READY') return true;
      if (meta.state === 'FAILED') return this.cleanupBuild(id);
      try {
        const workPage = await s.repo.query(`BUILD#${id}`, 'WORK#', 1);
        if (!workPage.rows.length) {
          await this.finishBuild(id);
          return true;
        }
        const key = workPage.rows[0].sk;
        await transact(s.repo, async (tx) => {
          const build = (await tx.get<Build>(`BUILD#${id}`, 'META'))!;
          if (build.state !== 'BUILDING') return;
          const work = await tx.get<Work>(`BUILD#${id}`, key);
          if (!work) return;
          const transfer = (await tx.get<ExtendedTransfer>('TRANSFER', id))!;
          assert(
            transfer.preparationState === 'BUILDING',
            'TRANSFER_NOT_ALLOWED',
            'Transfer preparation was cancelled.',
            409,
          );
          const source = await s.account(tx, build.senderUserId);
          assert(
            source.sequence === build.sourceSequence,
            'REVISION_CONFLICT',
            'Your drive changed while preparing this folder. Send it again to capture a consistent copy.',
            409,
          );
          const item = await s.owned(tx, build.senderUserId, work.sourceId);
          if (work.revision !== undefined)
            assert(
              work.revision === item.revision,
              'REVISION_CONFLICT',
              'A folder changed while preparing the transfer. Retry sending it.',
              409,
            );
          let entry = await tx.get<ManifestEntry>(`TRANSFER#${id}`, `ENTRY#${item.id}`);
          if (!entry) {
            const version = item.currentVersionId
              ? await tx.get<FileVersion>(
                  userPK(build.senderUserId),
                  `VERSION#${item.id}#${item.currentVersionId}`,
                )
              : undefined;
            entry = {
              id: item.id,
              sourceDriveItemId: item.id,
              sourceVersionId: version?.id ?? null,
              displayName: item.name,
              relativePath: work.path + item.name,
              parentEntryId: work.parentEntryId,
              itemType: item.type,
              sizeBytes: item.sizeBytes,
              mimeType: item.mimeType,
              contentHash: version?.contentHash ?? null,
              storageObjectId: version?.storageObjectId ?? null,
            };
            if (version) await s.reference(tx, version.storageObjectId, 1, build.senderUserId);
            await tx.put(`TRANSFER#${id}`, `ENTRY#${item.id}`, entry);
            transfer.totalSizeBytes += item.sizeBytes;
            await tx.put('TRANSFER', id, transfer);
          }
          if (item.type === 'FOLDER') {
            const children = await s.repo.query(
              userPK(build.senderUserId),
              `CHILD#${item.id}#`,
              10,
              work.cursor,
            );
            for (const row of children.rows) {
              const childId = (row.data as { id: string }).id;
              const childKey = `WORK#${childId}`;
              if (
                !(await tx.get(`TRANSFER#${id}`, `ENTRY#${childId}`)) &&
                !(await tx.get(`BUILD#${id}`, childKey))
              ) {
                await tx.put(`BUILD#${id}`, childKey, {
                  sourceId: childId,
                  parentEntryId: item.id,
                  path: entry.relativePath + '/',
                } satisfies Work);
                build.pending++;
              }
            }
            if (children.cursor) {
              await tx.put(`BUILD#${id}`, key, {
                ...work,
                cursor: children.cursor,
                revision: item.revision,
              });
            } else {
              await tx.delete(`BUILD#${id}`, key);
              build.pending--;
            }
          } else {
            await tx.delete(`BUILD#${id}`, key);
            build.pending--;
          }
          await tx.put(`BUILD#${id}`, 'META', build);
        });
      } catch (e) {
        if (!(e instanceof DomainError)) throw e;
        await transact(s.repo, async (tx) => {
          const build = (await tx.get<Build>(`BUILD#${id}`, 'META'))!;
          build.state = 'FAILED';
          build.error = e.code;
          await tx.put(`BUILD#${id}`, 'META', build);
          const t = (await tx.get<ExtendedTransfer>('TRANSFER', id))!;
          t.preparationState = 'FAILED';
          t.state = 'CANCELLED';
          t.cancelledAt = now();
          t.failure = e.message;
          await tx.put('TRANSFER', id, t);
        });
        return false;
      }
    }
    return false;
  }
  private async finishBuild(id: string) {
    const s = this.service;
    await transact(s.repo, async (tx) => {
      const build = (await tx.get<Build>(`BUILD#${id}`, 'META'))!;
      if (build.state !== 'BUILDING') return;
      assert(
        build.pending === 0,
        'CONCURRENT_UPDATE',
        'Manifest preparation is still in progress.',
        409,
      );
      const t = (await tx.get<ExtendedTransfer>('TRANSFER', id))!;
      build.state = 'READY';
      t.preparationState = 'READY';
      await tx.put(`BUILD#${id}`, 'META', build);
      await tx.put('TRANSFER', id, t);
      if (t.recipientUserId) {
        await tx.put(userPK(t.recipientUserId), `RECEIVED#${id}`, { id });
        await s.notification(tx, t.recipientUserId, 'TRANSFER_RECEIVED', { transferId: id });
        await s.recordContact(tx, t.senderUserId, t.recipientUserId);
        await s.record(tx, t.recipientUserId, 'TRANSFER_CREATED', id);
      } else {
        await tx.put(`PENDING#${t.recipientEmail}`, id, { id });
        const sender = await s.account(tx, t.senderUserId);
        await s.job(tx, {
          id: `invite-${id}`,
          type: 'EMAIL',
          to: t.recipientEmail!,
          sender: sender.displayName,
          dueAt: now(),
          attempts: 0,
        });
      }
      await s.record(tx, t.senderUserId, 'TRANSFER_CREATED', id);
      await s.job(tx, {
        id: `expire-transfer-${id}`,
        type: 'TRANSFER_EXPIRE',
        entityId: id,
        dueAt: t.expiresAt!,
        attempts: 0,
      });
    });
  }
  private async cleanupBuild(id: string) {
    const s = this.service;
    const page = await s.repo.query(`TRANSFER#${id}`, 'ENTRY#', 10);
    for (const row of page.rows)
      await transact(s.repo, async (tx) => {
        const e = await tx.get<ManifestEntry>(row.pk, row.sk);
        if (!e) return;
        if (e.storageObjectId)
          await s.reference(
            tx,
            e.storageObjectId,
            -1,
            (await tx.get<Transfer>('TRANSFER', id))!.senderUserId,
          );
        await tx.delete(row.pk, row.sk);
      });
    return !page.cursor;
  }
  async save(
    userId: string,
    id: string,
    input: { operationId: string; targetParentId: string | null },
  ) {
    const s = this.service;
    return s.operation(userId, input.operationId, { action: 'save', id, ...input }, async (tx) => {
      const t = await tx.get<ExtendedTransfer>('TRANSFER', id);
      assert(
        t && t.recipientUserId === userId && t.state === 'ACCEPTED',
        'TRANSFER_NOT_ALLOWED',
        'Accept this transfer before saving.',
        403,
      );
      assert(
        !t.expiresAt || t.expiresAt > now(),
        'TRANSFER_EXPIRED',
        'This transfer expired.',
        410,
      );
      const existing = await tx.get<Save>(`SAVE#${id}`, 'META');
      if (existing) return { items: [], jobId: id, state: existing.state };
      await s.parent(tx, userId, input.targetParentId);
      await assertBackupMutable(tx, userId, input.targetParentId);
      const account = await s.account(tx, userId);
      assert(
        t.totalSizeBytes <= storageUsage(account).availableBytes,
        'STORAGE_QUOTA_EXCEEDED',
        'There is not enough storage to save this transfer.',
        409,
      );
      account.storageReservedBytes += t.totalSizeBytes;
      await tx.put(userPK(userId), 'PROFILE', account);
      const save: Save = {
        id,
        userId,
        targetParentId: input.targetParentId,
        bytes: t.totalSizeBytes,
        state: 'SAVING',
      };
      await tx.put(`SAVE#${id}`, 'META', save);
      t.saveState = 'SAVING';
      await tx.put('TRANSFER', id, t);
      await s.job(tx, {
        id: `save-${id}`,
        type: 'TRANSFER_SAVE',
        entityId: id,
        userId,
        dueAt: now(),
        attempts: 0,
      });
      return { items: [], jobId: id, state: 'SAVING' };
    });
  }
  async saveBatch(id: string) {
    const s = this.service;
    const stage = await new Transaction(s.repo).get<Save>(`SAVE#${id}`, 'META');
    if (!stage || stage.state === 'COMPLETED') return true;
    if (stage.state === 'FAILED') return this.cleanupSave(stage);
    try {
      const page = await s.repo.query(`TRANSFER#${id}`, 'ENTRY#', 10, stage.cursor);
      for (const row of page.rows)
        await transact(s.repo, async (tx) => {
          const save = (await tx.get<Save>(`SAVE#${id}`, 'META'))!;
          if (save.state !== 'SAVING') return;
          const entry = row.data as ManifestEntry;
          const itemId = deterministicId(id, entry.id);
          if (await tx.get(userPK(save.userId), `ITEM#${itemId}`)) return;
          await s.account(tx, save.userId);
          const item: StagedItem = {
            ...s.newItem(
              save.userId,
              entry.parentEntryId ? deterministicId(id, entry.parentEntryId) : save.targetParentId,
              entry.displayName,
              entry.itemType,
              itemId,
            ),
            stagingId: id,
          };
          if (entry.itemType === 'FILE') {
            const version: FileVersion = {
              id: deterministicId(id, entry.id + 'version'),
              driveItemId: item.id,
              storageObjectId: entry.storageObjectId!,
              versionNumber: 1,
              sizeBytes: entry.sizeBytes,
              contentHash: entry.contentHash!,
              contentHashAlgorithm: 'SHA256',
              sourceDeviceId: null,
              createdAt: now(),
            };
            await s.reference(tx, version.storageObjectId, 1);
            await tx.put(userPK(save.userId), `VERSION#${item.id}#${version.id}`, version);
            item.currentVersionId = version.id;
            item.sizeBytes = entry.sizeBytes;
            item.mimeType = entry.mimeType;
          }
          await s.reserveName(tx, item);
          await tx.put(`SAVE#${id}`, `STAGED#${item.id}`, { id: item.id });
        });
      await transact(s.repo, async (tx) => {
        const save = (await tx.get<Save>(`SAVE#${id}`, 'META'))!;
        if (save.state !== 'SAVING' || save.cursor !== stage.cursor) return;
        if (page.cursor) {
          save.cursor = page.cursor;
          await tx.put(`SAVE#${id}`, 'META', save);
          return;
        }
        await s.parent(tx, save.userId, save.targetParentId);
        await assertBackupMutable(tx, save.userId, save.targetParentId);
        const account = await s.account(tx, save.userId);
        account.storageReservedBytes -= save.bytes;
        account.storageUsedBytes += save.bytes;
        await tx.put(userPK(save.userId), 'PROFILE', account);
        save.state = 'COMPLETED';
        await tx.put(`SAVE#${id}`, 'META', save);
        const transfer = (await tx.get<ExtendedTransfer>('TRANSFER', id))!;
        transfer.savedAt = now();
        transfer.saveState = 'SAVED';
        await tx.put('TRANSFER', id, transfer);
        await s.record(tx, save.userId, 'TRANSFER_SAVED', id);
      });
      return !page.cursor;
    } catch (e) {
      if (!(e instanceof DomainError)) throw e;
      await transact(s.repo, async (tx) => {
        const save = (await tx.get<Save>(`SAVE#${id}`, 'META'))!;
        if (save.state !== 'SAVING') return;
        save.state = 'FAILED';
        save.error = e.message;
        await tx.put(`SAVE#${id}`, 'META', save);
        const t = (await tx.get<ExtendedTransfer>('TRANSFER', id))!;
        t.saveState = 'FAILED';
        t.failure = e.message;
        await tx.put('TRANSFER', id, t);
      });
      return false;
    }
  }
  private async cleanupSave(stage: Save) {
    const s = this.service;
    const page = await s.repo.query(`SAVE#${stage.id}`, 'STAGED#', 10);
    for (const row of page.rows)
      await transact(s.repo, async (tx) => {
        const itemId = (row.data as { id: string }).id;
        const item = await tx.get<StagedItem>(userPK(stage.userId), `ITEM#${itemId}`);
        if (item) {
          if (item.currentVersionId) {
            const version = (await tx.get<FileVersion>(
              userPK(stage.userId),
              `VERSION#${item.id}#${item.currentVersionId}`,
            ))!;
            await s.reference(tx, version.storageObjectId, -1);
            await tx.delete(userPK(stage.userId), `VERSION#${item.id}#${version.id}`);
          }
          await s.reserveName(tx, { ...item, deletedAt: now() }, item);
          await tx.delete(userPK(stage.userId), `ITEM#${item.id}`);
          await tx.delete(userPK(stage.userId), `ALLCHILD#${item.parentId ?? 'root'}#${item.id}`);
          await tx.delete('ITEMOWNER', item.id);
        }
        await tx.delete(row.pk, row.sk);
      });
    if (!page.cursor)
      await transact(s.repo, async (tx) => {
        const current = await tx.get<Save & { released?: boolean }>(`SAVE#${stage.id}`, 'META');
        if (!current || current.released) return;
        const account = await s.account(tx, stage.userId);
        account.storageReservedBytes -= stage.bytes;
        await tx.put(userPK(stage.userId), 'PROFILE', account);
        await tx.put(`SAVE#${stage.id}`, 'META', { ...current, released: true });
      });
    return !page.cursor;
  }
  async release(id: string) {
    return this.releaseCursor(id);
  }
  private async releaseCursor(id: string) {
    const s = this.service;
    const cursor = (await new Transaction(s.repo).get<{ cursor?: string }>(`RELEASE#${id}`, 'META'))
      ?.cursor;
    const page = await s.repo.query(`TRANSFER#${id}`, 'ENTRY#', 20, cursor);
    for (const row of page.rows)
      await transact(s.repo, async (tx) => {
        const e = await tx.get<ManifestEntry>(row.pk, row.sk);
        if (e?.storageObjectId) {
          await s.reference(
            tx,
            e.storageObjectId,
            -1,
            (await tx.get<Transfer>('TRANSFER', id))!.senderUserId,
          );
          await tx.put(row.pk, row.sk, { ...e, storageObjectId: null });
        }
      });
    await transact(s.repo, (tx) =>
      tx.put(`RELEASE#${id}`, 'META', { cursor: page.cursor ?? undefined }),
    );
    return !page.cursor;
  }
  async expire(id: string) {
    const s = this.service;
    return transact(s.repo, async (tx) => {
      const t = await tx.get<ExtendedTransfer>('TRANSFER', id);
      if (!t || !['PENDING', 'PENDING_RECIPIENT_SIGNUP', 'ACCEPTED'].includes(t.state)) return true;
      if (!t.expiresAt || t.expiresAt > now() || t.saveState === 'SAVING') return false;
      t.state = 'EXPIRED';
      await tx.put('TRANSFER', id, t);
      await s.record(tx, t.senderUserId, 'TRANSFER_EXPIRED', id);
      if (t.recipientUserId) await s.record(tx, t.recipientUserId, 'TRANSFER_EXPIRED', id);
      await s.job(tx, {
        id: `release-${id}`,
        type: 'TRANSFER_RELEASE',
        entityId: id,
        dueAt: now(),
        attempts: 0,
      });
      return true;
    });
  }
}
