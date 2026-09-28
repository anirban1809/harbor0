import { createHash, randomUUID } from 'node:crypto';
import { normalizeName, storageUsage, type DriveItem, type FileVersion } from '@harbor/contracts';
import { StorageService, userPK, type StoredObject } from './domain';
import { Transaction, transact } from './repository';
import { assert, DomainError } from './errors';
import type { Save, StagedItem } from './workflows';

const now = () => new Date().toISOString();
const copyId = (id: string, source: string) =>
  createHash('sha256').update(`cloud-copy:${id}:${source}`).digest('hex').slice(0, 32);
type Copy = Save & {
  mode?: 'SNAPSHOT' | 'SYNC';
  syncStatus?: 'SYNCING' | 'SYNCED' | 'WAITING' | 'ERROR' | 'STOPPED';
  updatedAt?: string;
  mirrorPass?: string;
  mirrorPhase?: 'WALK' | 'SWEEP';
  mirrorCursor?: string;
  sourceId: string;
  rootId: string;
  name: string;
  sourceSequence: number;
  phase: 'CAPTURING' | 'COPYING';
  createdAt: string;
  expiresAt: string;
  waiting?: boolean;
  released?: boolean;
};
type Work = { sourceId: string; parentId: string | null; cursor?: string; captured?: boolean };
type Entry = { id: string; sourceId: string; version?: FileVersion; ready: boolean; seen?: string };
export type CopyWait = { copies: Record<string, string> };
export type CloudMirrorLinks = { copies: string[] };

// Reuse the save visibility gate: no partially copied tree can be browsed or downloaded.
export class CloudCopies {
  constructor(private s: StorageService) {}

  async create(
    userId: string,
    sourceId: string,
    input: { operationId: string; baseRevision: number; mode?: 'SNAPSHOT' | 'SYNC' },
  ) {
    const s = this.s;
    return s.operation(
      userId,
      input.operationId,
      { action: 'cloud-copy', sourceId, ...input },
      async (tx) => {
        const source = await s.owned(tx, userId, sourceId);
        assert(source.type === 'FOLDER', 'VALIDATION_ERROR', 'Choose a sync folder.');
        assert(
          source.revision === input.baseRevision,
          'REVISION_CONFLICT',
          'This folder changed. Refresh and try again.',
          409,
        );
        await tx.get(userPK(userId), 'SYNC_MEMBERSHIP');
        const mappings = await new Transaction(s.repo).list<{ folderIds: string[] }>(
          userPK(userId),
          'SYNCFOLDERS#',
        );
        assert(
          mappings.some((mapping) => mapping.folderIds.includes(sourceId)),
          'INVALID_STATE',
          'This folder is not linked for sync.',
          409,
        );
        const id = randomUUID();
        let name = '';
        for (let suffix = 1; ; suffix++) {
          const ending = suffix === 1 ? ' (cloud copy)' : ` (cloud copy ${suffix})`;
          name = source.name.slice(0, 240 - ending.length) + ending;
          if (!(await tx.get(userPK(userId), `NAME#root#${normalizeName(name)}`))) break;
          assert(
            suffix < 20,
            'NAME_CONFLICT',
            'Too many copies have the same name. Rename an existing copy and try again.',
            409,
          );
        }
        const root = {
          ...s.newItem(userId, null, name, 'FOLDER', copyId(id, sourceId)),
          stagingId: id,
        };
        await s.reserveName(tx, root);
        await tx.put(`SAVE#${id}`, `ENTRY#${root.id}`, {
          id: root.id,
          sourceId,
          ready: true,
        } satisfies Entry);
        await tx.put(`SAVE#${id}`, `WORK#${sourceId}`, {
          sourceId,
          parentId: null,
          captured: true,
        } satisfies Work);
        const copy: Copy = {
          id,
          userId,
          sourceId,
          rootId: root.id,
          name,
          targetParentId: null,
          bytes: 0,
          state: 'SAVING',
          phase: 'CAPTURING',
          sourceSequence: (await s.account(tx, userId)).sequence,
          createdAt: now(),
          expiresAt: new Date(Date.now() + 24 * 3600_000).toISOString(),
          mode: input.mode ?? 'SNAPSHOT',
        };
        if (copy.mode === 'SYNC') {
          const key = `CLOUDMIRROR#${sourceId}`;
          const links = (await tx.get<CloudMirrorLinks>(userPK(userId), key)) ?? { copies: [] };
          links.copies.push(id);
          await tx.put(userPK(userId), key, links);
        }
        await tx.put(`SAVE#${id}`, 'META', copy);
        await tx.put(userPK(userId), `CLOUDCOPY#${id}`, { id });
        await s.job(tx, {
          id: `cloud-copy-${id}`,
          type: 'CLOUD_COPY',
          userId,
          entityId: id,
          dueAt: now(),
          attempts: 0,
        });
        return { copy: this.publicCopy(copy) };
      },
    );
  }

  private publicCopy(copy: Copy) {
    return {
      id: copy.id,
      name: copy.name,
      rootId: copy.rootId,
      state: copy.state,
      waiting: !!copy.waiting,
      error: copy.error,
      createdAt: copy.createdAt,
      mode: copy.mode ?? 'SNAPSHOT',
      syncStatus: copy.syncStatus,
      updatedAt: copy.updatedAt,
    };
  }

  async list(userId: string, cursor?: string) {
    const page = await this.s.repo.query(userPK(userId), 'CLOUDCOPY#', 100, cursor);
    const copies = [];
    for (const row of page.rows) {
      const copy = await new Transaction(this.s.repo).get<Copy>(
        `SAVE#${(row.data as { id: string }).id}`,
        'META',
      );
      if (copy) copies.push(this.publicCopy(copy));
    }
    return { items: copies, nextCursor: page.cursor };
  }

  async step(id: string) {
    const s = this.s;
    try {
      for (let step = 0; step < 30; step++) {
        const copy = await new Transaction(s.repo).get<Copy>(`SAVE#${id}`, 'META');
        if (!copy || copy.state === 'COMPLETED') return true;
        if (copy.state === 'FAILED') return this.cleanup(copy);
        assert(
          copy.expiresAt > now(),
          'COPY_EXPIRED',
          'The cloud copy timed out waiting for a linked device. Bring a synced device online and try again.',
          409,
        );
        if (copy.phase === 'CAPTURING') await this.capture(copy);
        else if (!(await this.materialize(copy))) return false;
      }
      return false;
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      await transact(s.repo, async (tx) => {
        const copy = await tx.get<Copy>(`SAVE#${id}`, 'META');
        if (!copy || copy.state !== 'SAVING') return;
        await tx.put(`SAVE#${id}`, 'META', {
          ...copy,
          state: 'FAILED',
          error: error.message,
          waiting: false,
        });
      });
      return false;
    }
  }

  private async capture(previous: Copy) {
    const s = this.s;
    const page = await s.repo.query(`SAVE#${previous.id}`, 'WORK#', 1);
    await transact(s.repo, async (tx) => {
      const copy = (await tx.get<Copy>(`SAVE#${previous.id}`, 'META'))!;
      if (copy.state !== 'SAVING' || copy.phase !== 'CAPTURING') return;
      const account = await s.account(tx, copy.userId);
      assert(
        account.sequence === copy.sourceSequence,
        'REVISION_CONFLICT',
        'Your drive changed while capturing the folder. Try Copy to cloud again to capture a consistent snapshot.',
        409,
      );
      if (!page.rows.length) {
        await tx.put(`SAVE#${copy.id}`, 'META', { ...copy, phase: 'COPYING' });
        return;
      }
      const row = page.rows[0];
      const work = await tx.get<Work>(row.pk, row.sk);
      if (!work) return;
      const source = await s.owned(tx, copy.userId, work.sourceId);
      if (!work.captured) {
        const item: StagedItem = {
          ...s.newItem(
            copy.userId,
            work.parentId,
            source.name,
            source.type,
            copyId(copy.id, source.id),
          ),
          stagingId: copy.id,
        };
        const entry: Entry = { id: item.id, sourceId: source.id, ready: source.type === 'FOLDER' };
        if (source.type === 'FILE') {
          const version = await tx.get<FileVersion>(
            userPK(copy.userId),
            `VERSION#${source.id}#${source.currentVersionId}`,
          );
          assert(version, 'ITEM_NOT_FOUND', 'A file version is unavailable.', 404);
          assert(
            version.sizeBytes <= storageUsage(account).availableBytes,
            'STORAGE_QUOTA_EXCEEDED',
            'There is not enough cloud storage for this copy.',
            409,
          );
          copy.bytes += version.sizeBytes;
          account.storageReservedBytes += version.sizeBytes;
          await tx.put(userPK(copy.userId), 'PROFILE', account);
          item.sizeBytes = version.sizeBytes;
          item.mimeType = source.mimeType;
          entry.version = version;
          if (version.cloudState !== 'RELEASED') {
            await this.attach(tx, copy, item, version);
            entry.ready = true;
          } else {
            const wait = (await tx.get<CopyWait>(
              userPK(copy.userId),
              `CLOUDCOPYWAIT#${source.id}`,
            )) ?? { copies: {} };
            wait.copies[copy.id] = copy.expiresAt;
            await tx.put(userPK(copy.userId), `CLOUDCOPYWAIT#${source.id}`, wait);
          }
        }
        await s.reserveName(tx, item);
        await tx.put(`SAVE#${copy.id}`, `ENTRY#${item.id}`, entry);
        work.captured = true;
      }
      if (source.type === 'FOLDER') {
        const children = await s.repo.query(
          userPK(copy.userId),
          `CHILD#${source.id}#`,
          10,
          work.cursor,
        );
        for (const child of children.rows) {
          const sourceId = (child.data as { id: string }).id;
          await tx.put(`SAVE#${copy.id}`, `WORK#${sourceId}`, {
            sourceId,
            parentId: copyId(copy.id, source.id),
          } satisfies Work);
        }
        if (children.cursor) await tx.put(row.pk, row.sk, { ...work, cursor: children.cursor });
        else await tx.delete(row.pk, row.sk);
      } else await tx.delete(row.pk, row.sk);
      await tx.put(`SAVE#${copy.id}`, 'META', copy);
    });
  }

  private async attach(tx: Transaction, copy: Copy, item: DriveItem, source: FileVersion) {
    await this.s.reference(tx, source.storageObjectId, 1);
    const version: FileVersion = {
      ...source,
      id: copyId(copy.id, item.id + ':version'),
      driveItemId: item.id,
      versionNumber: 1,
      sourceDeviceId: null,
      createdAt: copy.createdAt,
      cloudState: 'AVAILABLE',
    };
    item.currentVersionId = version.id;
    item.cloudState = 'AVAILABLE';
    await tx.put(userPK(copy.userId), `VERSION#${item.id}#${version.id}`, version);
  }

  private async clearWait(tx: Transaction, copy: Copy, sourceId: string) {
    const wait = await tx.get<CopyWait>(userPK(copy.userId), `CLOUDCOPYWAIT#${sourceId}`);
    if (!wait) return;
    delete wait.copies[copy.id];
    if (Object.keys(wait.copies).length)
      await tx.put(userPK(copy.userId), `CLOUDCOPYWAIT#${sourceId}`, wait);
    else await tx.delete(userPK(copy.userId), `CLOUDCOPYWAIT#${sourceId}`);
  }

  private async materialize(previous: Copy) {
    const s = this.s;
    const page = await s.repo.query(`SAVE#${previous.id}`, 'ENTRY#', 10, previous.cursor);
    let waiting = false;
    for (const row of page.rows) {
      await transact(s.repo, async (tx) => {
        const copy = (await tx.get<Copy>(`SAVE#${previous.id}`, 'META'))!;
        if (copy.state !== 'SAVING') return;
        const entry = (await tx.get<Entry>(row.pk, row.sk))!;
        if (entry.ready) return;
        const source = await s.owned(tx, copy.userId, entry.sourceId);
        const version = await tx.get<FileVersion>(
          userPK(copy.userId),
          `VERSION#${source.id}#${source.currentVersionId}`,
        );
        assert(
          version &&
            version.contentHash === entry.version!.contentHash &&
            version.sizeBytes === entry.version!.sizeBytes,
          'REVISION_CONFLICT',
          'A device-only file changed before it could be copied. Try Copy to cloud again.',
          409,
        );
        const object = await tx.get<StoredObject>('OBJECT', version.storageObjectId);
        if (version.cloudState === 'RELEASED' || !object || object.references <= 0) {
          if (source.cloudState !== 'REQUESTED') {
            source.cloudState = 'REQUESTED';
            await tx.put(userPK(copy.userId), `ITEM#${source.id}`, source);
            await s.record(tx, copy.userId, 'SYNC_CONTENT_REQUESTED', source.id, source);
          }
          waiting = true;
          return;
        }
        const item = (await tx.get<StagedItem>(userPK(copy.userId), `ITEM#${entry.id}`))!;
        await this.attach(tx, copy, item, version);
        await tx.put(userPK(copy.userId), `ITEM#${item.id}`, item);
        await tx.put(row.pk, row.sk, { ...entry, ready: true });
        await this.clearWait(tx, copy, source.id);
      });
    }
    await transact(s.repo, async (tx) => {
      const copy = (await tx.get<Copy>(`SAVE#${previous.id}`, 'META'))!;
      if (copy.state !== 'SAVING' || copy.cursor !== previous.cursor) return;
      copy.waiting = waiting;
      if (!waiting) {
        if (page.cursor) copy.cursor = page.cursor;
        else {
          const account = await s.account(tx, copy.userId);
          account.storageReservedBytes -= copy.bytes;
          account.storageUsedBytes += copy.bytes;
          await tx.put(userPK(copy.userId), 'PROFILE', account);
          copy.state = 'COMPLETED';
          if (copy.mode === 'SYNC') {
            copy.syncStatus = 'SYNCING';
            await s.job(tx, {
              id: `cloud-mirror-${copy.id}`,
              type: 'CLOUD_MIRROR',
              userId: copy.userId,
              entityId: copy.id,
              dueAt: now(),
              attempts: 0,
            });
          }
          const root = (await tx.get<DriveItem>(userPK(copy.userId), `ITEM#${copy.rootId}`))!;
          await s.record(tx, copy.userId, 'FOLDER_CREATED', root.id, root);
        }
      }
      await tx.put(`SAVE#${copy.id}`, 'META', copy);
    });
    return !waiting;
  }

  private async cleanup(copy: Copy) {
    const s = this.s;
    const page = await s.repo.query(`SAVE#${copy.id}`, 'ENTRY#', 10);
    for (const row of page.rows)
      await transact(s.repo, async (tx) => {
        const entry = await tx.get<Entry>(row.pk, row.sk);
        if (!entry) return;
        const item = await tx.get<StagedItem>(userPK(copy.userId), `ITEM#${entry.id}`);
        if (item) {
          if (item.currentVersionId) {
            const version = (await tx.get<FileVersion>(
              userPK(copy.userId),
              `VERSION#${item.id}#${item.currentVersionId}`,
            ))!;
            await s.reference(tx, version.storageObjectId, -1);
            await tx.delete(userPK(copy.userId), `VERSION#${item.id}#${version.id}`);
          }
          await s.reserveName(tx, { ...item, deletedAt: now() }, item);
          await tx.delete(userPK(copy.userId), `ITEM#${item.id}`);
          await tx.delete(userPK(copy.userId), `ALLCHILD#${item.parentId ?? 'root'}#${item.id}`);
          await tx.delete('ITEMOWNER', item.id);
        }
        await this.clearWait(tx, copy, entry.sourceId);
        await tx.delete(row.pk, row.sk);
      });
    if (page.cursor) return false;
    await transact(s.repo, async (tx) => {
      const current = (await tx.get<Copy>(`SAVE#${copy.id}`, 'META'))!;
      if (current.released) return;
      const account = await s.account(tx, copy.userId);
      account.storageReservedBytes -= current.bytes;
      await tx.put(userPK(copy.userId), 'PROFILE', account);
      await tx.put(`SAVE#${copy.id}`, 'META', { ...current, released: true });
      await this.unlink(tx, copy);
    });
    return true;
  }

  private async unlink(tx: Transaction, copy: Copy) {
    const key = `CLOUDMIRROR#${copy.sourceId}`;
    const links = await tx.get<CloudMirrorLinks>(userPK(copy.userId), key);
    if (!links) return;
    links.copies = links.copies.filter((id) => id !== copy.id);
    if (links.copies.length) await tx.put(userPK(copy.userId), key, links);
    else await tx.delete(userPK(copy.userId), key);
  }

  // Each pass walks the current source tree, then trashes copies of removed items.
  // The stable destination IDs preserve links and file history across passes.
  async mirror(id: string) {
    const s = this.s;
    try {
      for (let step = 0; step < 30; step++) {
        const previous = await new Transaction(s.repo).get<Copy>(`SAVE#${id}`, 'META');
        if (
          !previous ||
          previous.mode !== 'SYNC' ||
          previous.state !== 'COMPLETED' ||
          previous.syncStatus === 'STOPPED'
        )
          return true;
        const result = await transact(s.repo, async (tx) => {
          const copy = (await tx.get<Copy>(`SAVE#${id}`, 'META'))!;
          const source = await tx.get<DriveItem>(userPK(copy.userId), `ITEM#${copy.sourceId}`);
          const root = await tx.get<DriveItem & { purging?: boolean }>(
            userPK(copy.userId),
            `ITEM#${copy.rootId}`,
          );
          let invalidLocation = false;
          for (const [item, otherId] of [
            [source, copy.rootId],
            [root, copy.sourceId],
          ] as const) {
            let parentId = item?.parentId;
            const visited = new Set<string>();
            while (parentId) {
              if (parentId === otherId || visited.has(parentId) || visited.size >= 32) {
                invalidLocation = true;
                break;
              }
              visited.add(parentId);
              const parent = await tx.get<DriveItem>(userPK(copy.userId), `ITEM#${parentId}`);
              if (!parent || parent.deletedAt || parent.syncRemovedAt) {
                invalidLocation = true;
                break;
              }
              parentId = parent.parentId;
            }
          }
          if (
            !source ||
            source.deletedAt ||
            source.syncRemovedAt ||
            !root ||
            root.deletedAt ||
            root.purging ||
            invalidLocation
          ) {
            copy.syncStatus = 'STOPPED';
            copy.error =
              'Ongoing copying stopped because a folder was removed or moved to an incompatible location. Existing cloud files are preserved.';
            await this.unlink(tx, copy);
            await tx.put(`SAVE#${id}`, 'META', copy);
            return 'STOP';
          }
          if (!copy.mirrorPass) {
            copy.mirrorPass = randomUUID();
            copy.mirrorPhase = 'WALK';
            copy.mirrorCursor = undefined;
            copy.syncStatus = 'SYNCING';
            copy.error = undefined;
            copy.waiting = false;
            await tx.put(`MIRROR#${id}`, `WORK#${copy.sourceId}`, {
              sourceId: copy.sourceId,
              parentId: null,
            } satisfies Work);
            await tx.put(`SAVE#${id}`, 'META', copy);
          }
          return 'CONTINUE';
        });
        if (result === 'STOP') return true;
        const copy = (await new Transaction(s.repo).get<Copy>(`SAVE#${id}`, 'META'))!;
        if (copy.mirrorPhase === 'WALK') {
          if (!(await this.mirrorWalk(copy))) return false;
        } else if (await this.mirrorSweep(copy)) return false;
      }
      return false;
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      await transact(s.repo, async (tx) => {
        const copy = (await tx.get<Copy>(`SAVE#${id}`, 'META'))!;
        if (copy.syncStatus === 'STOPPED') return;
        await tx.put(`SAVE#${id}`, 'META', {
          ...copy,
          syncStatus: 'ERROR',
          error: error.message,
          waiting: false,
        });
      });
      return false;
    }
  }

  private async mirrorWalk(previous: Copy) {
    const s = this.s;
    const page = await s.repo.query(`MIRROR#${previous.id}`, 'WORK#', 1);
    let waiting = false;
    await transact(s.repo, async (tx) => {
      const copy = (await tx.get<Copy>(`SAVE#${previous.id}`, 'META'))!;
      if (
        copy.mirrorPass !== previous.mirrorPass ||
        copy.mirrorPhase !== 'WALK' ||
        copy.syncStatus === 'STOPPED'
      )
        return;
      if (!page.rows.length) {
        await tx.put(`SAVE#${copy.id}`, 'META', {
          ...copy,
          mirrorPhase: 'SWEEP',
          mirrorCursor: undefined,
        });
        return;
      }
      const row = page.rows[0];
      const work = await tx.get<Work>(row.pk, row.sk);
      if (!work) return;
      let source: DriveItem;
      try {
        source = await s.owned(tx, copy.userId, work.sourceId);
      } catch (error) {
        if (
          !(error instanceof DomainError) ||
          !['ITEM_NOT_FOUND', 'PARENT_NOT_FOUND', 'SYNC_REMOVED', 'ITEM_DELETING'].includes(
            error.code,
          )
        )
          throw error;
        await tx.delete(row.pk, row.sk);
        return;
      }
      if (source.id !== copy.sourceId && copyId(copy.id, source.parentId!) !== work.parentId) {
        await tx.delete(row.pk, row.sk);
        return;
      }
      const id = copyId(copy.id, source.id);
      const old = await tx.get<StagedItem & { purging?: boolean }>(
        userPK(copy.userId),
        `ITEM#${id}`,
      );
      assert(
        !old?.purging,
        'ITEM_DELETING',
        'A cloud file is being deleted. Sync will retry shortly.',
        409,
      );
      const item: StagedItem = old
        ? { ...old }
        : {
            ...s.newItem(copy.userId, work.parentId, source.name, source.type, id),
            stagingId: copy.id,
          };
      if (source.id !== copy.sourceId) {
        item.name = source.name;
        item.normalizedName = normalizeName(source.name);
        item.parentId = work.parentId;
        item.deletedAt = null;
      }
      if (source.type === 'FILE') {
        const version = await tx.get<FileVersion>(
          userPK(copy.userId),
          `VERSION#${source.id}#${source.currentVersionId}`,
        );
        assert(
          version,
          'ITEM_NOT_FOUND',
          'A source file version is unavailable. Sync will retry.',
          409,
        );
        const current = item.currentVersionId
          ? await tx.get<FileVersion>(userPK(copy.userId), `VERSION#${id}#${item.currentVersionId}`)
          : undefined;
        if (
          !current ||
          current.cloudState === 'RELEASED' ||
          current.contentHash !== version.contentHash ||
          current.sizeBytes !== version.sizeBytes
        ) {
          if (version.cloudState === 'RELEASED') {
            if (source.cloudState !== 'REQUESTED') {
              source.cloudState = 'REQUESTED';
              await tx.put(userPK(copy.userId), `ITEM#${source.id}`, source);
              await s.record(tx, copy.userId, 'SYNC_CONTENT_REQUESTED', source.id, source);
            }
            await tx.put(`SAVE#${copy.id}`, 'META', {
              ...copy,
              syncStatus: 'WAITING',
              waiting: true,
            });
            waiting = true;
            return;
          }
          const account = await s.account(tx, copy.userId);
          assert(
            version.sizeBytes <= storageUsage(account).availableBytes,
            'STORAGE_QUOTA_EXCEEDED',
            'Cloud sync is paused because storage is full. Free up space to continue.',
            409,
          );
          const next: FileVersion = {
            ...version,
            id: randomUUID(),
            driveItemId: id,
            versionNumber: (current?.versionNumber ?? 0) + 1,
            sourceDeviceId: null,
            createdAt: now(),
            cloudState: 'AVAILABLE',
          };
          await s.reference(tx, version.storageObjectId, 1);
          await tx.put(userPK(copy.userId), `VERSION#${id}#${next.id}`, next);
          account.storageUsedBytes += version.sizeBytes;
          await tx.put(userPK(copy.userId), 'PROFILE', account);
          item.currentVersionId = next.id;
          item.sizeBytes = version.sizeBytes;
          item.cloudState = 'AVAILABLE';
        }
        item.mimeType = source.mimeType;
      }
      if (
        !old ||
        item.name !== old.name ||
        item.parentId !== old.parentId ||
        item.deletedAt !== old.deletedAt ||
        item.currentVersionId !== old.currentVersionId ||
        item.mimeType !== old.mimeType
      ) {
        item.revision = (old?.revision ?? 0) + 1;
        item.updatedAt = now();
        // Handle source rename swaps without losing either cloud file's history.
        const claim = await tx.get<{ id: string }>(
          userPK(copy.userId),
          `NAME#${item.parentId ?? 'root'}#${item.normalizedName}`,
        );
        if (claim && claim.id !== item.id) {
          const collision = await tx.get<StagedItem>(userPK(copy.userId), `ITEM#${claim.id}`);
          assert(
            collision?.stagingId === copy.id,
            'NAME_CONFLICT',
            'A cloud item is using a synced name. Rename that item to continue syncing.',
            409,
          );
          const trashed = { ...collision, deletedAt: now(), revision: collision.revision + 1 };
          await s.reserveName(tx, trashed, collision);
          await s.record(tx, copy.userId, 'FILE_DELETED', trashed.id, trashed);
        }
        await s.reserveName(tx, item, old);
        await s.record(
          tx,
          copy.userId,
          old ? 'FILE_UPDATED' : source.type === 'FILE' ? 'FILE_CREATED' : 'FOLDER_CREATED',
          item.id,
          item,
        );
      }
      const entry = (await tx.get<Entry>(`SAVE#${copy.id}`, `ENTRY#${id}`)) ?? {
        id,
        sourceId: source.id,
        ready: true,
      };
      await tx.put(`SAVE#${copy.id}`, `ENTRY#${id}`, { ...entry, seen: copy.mirrorPass });
      if (source.type === 'FOLDER') {
        const children = await s.repo.query(
          userPK(copy.userId),
          `CHILD#${source.id}#`,
          10,
          work.cursor,
        );
        for (const child of children.rows) {
          const sourceId = (child.data as { id: string }).id;
          await tx.put(`MIRROR#${copy.id}`, `WORK#${sourceId}`, {
            sourceId,
            parentId: id,
          } satisfies Work);
        }
        if (children.cursor) await tx.put(row.pk, row.sk, { ...work, cursor: children.cursor });
        else await tx.delete(row.pk, row.sk);
      } else await tx.delete(row.pk, row.sk);
      await tx.put(`SAVE#${copy.id}`, 'META', {
        ...copy,
        syncStatus: 'SYNCING',
        waiting: false,
        error: undefined,
      });
    });
    return !waiting;
  }

  private async mirrorSweep(previous: Copy) {
    const s = this.s;
    const page = await s.repo.query(`SAVE#${previous.id}`, 'ENTRY#', 10, previous.mirrorCursor);
    for (const row of page.rows)
      await transact(s.repo, async (tx) => {
        const copy = (await tx.get<Copy>(`SAVE#${previous.id}`, 'META'))!;
        if (
          copy.mirrorPass !== previous.mirrorPass ||
          copy.mirrorPhase !== 'SWEEP' ||
          copy.syncStatus === 'STOPPED'
        )
          return;
        const entry = (await tx.get<Entry>(row.pk, row.sk))!;
        if (entry.seen === copy.mirrorPass || entry.id === copy.rootId) return;
        const item = await tx.get<StagedItem>(userPK(copy.userId), `ITEM#${entry.id}`);
        if (item && !item.deletedAt) {
          const trashed = { ...item, deletedAt: now(), revision: item.revision + 1 };
          await s.reserveName(tx, trashed, item);
          await s.record(tx, copy.userId, 'FILE_DELETED', item.id, trashed);
        }
      });
    await transact(s.repo, async (tx) => {
      const copy = (await tx.get<Copy>(`SAVE#${previous.id}`, 'META'))!;
      if (
        copy.mirrorPass !== previous.mirrorPass ||
        copy.mirrorCursor !== previous.mirrorCursor ||
        copy.syncStatus === 'STOPPED'
      )
        return;
      if (page.cursor) copy.mirrorCursor = page.cursor;
      else {
        copy.mirrorPass = undefined;
        copy.mirrorPhase = undefined;
        copy.mirrorCursor = undefined;
        copy.syncStatus = 'SYNCED';
        copy.updatedAt = now();
        copy.error = undefined;
      }
      await tx.put(`SAVE#${copy.id}`, 'META', copy);
    });
    return !page.cursor;
  }
}
