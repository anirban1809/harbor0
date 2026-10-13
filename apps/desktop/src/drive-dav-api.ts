import { randomUUID } from 'node:crypto';
import { ApiError, type ApiClient } from '@harbor/api-client';
import type { DriveItem } from '@harbor/contracts';
import { guessMime } from '../../../packages/api-client/src/e2ee-transport';
import { openEncryptedFile, openPlainFile } from './e2ee-reader';
import { transferKeys, uploadFile } from './transfers';
import type { DavDrive, DavEntry } from './drive-dav';

const davEntry = (item: DriveItem): DavEntry => ({
  id: item.id,
  parentId: item.parentId,
  name: item.name,
  folder: item.type === 'FOLDER',
  size: item.type === 'FILE' ? item.sizeBytes : 0,
  mimeType: item.mimeType || guessMime(item.name),
  created: item.createdAt,
  modified: item.modifiedAt ?? item.updatedAt,
  etag: item.currentVersionId ?? `${item.id}-${item.revision}`,
  encrypted: item.encrypted === true,
});

/**
 * My Drive through the app's API client, whose transport encrypts names and decrypts answers.
 * File contents are decrypted here as they're read and encrypted by uploadFile.
 */
export function apiDrive(api: ApiClient): DavDrive {
  // Listings can be a few seconds old, so changes go up against the item's current revision.
  const current = async (id: string): Promise<DriveItem> =>
    (await api.request(`/v1/drive/items/${encodeURIComponent(id)}`)).item;
  return {
    async list(folderId) {
      const entries: DavEntry[] = [];
      let cursor: string | undefined;
      do {
        const page = await api.list(folderId, cursor);
        for (const item of page.items) if (!item.deletedAt) entries.push(davEntry(item));
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      return entries;
    },
    async open(file) {
      if (!file.encrypted) return openPlainFile(api, file.id);
      const keys = transferKeys.read();
      if (!keys) throw new ApiError('E2EE_LOCKED', 'Unlock your files to continue.', 423);
      return openEncryptedFile(api, file.id, keys);
    },
    async write(parentId, name, source, existing, modifiedAt) {
      const base = existing && (await current(existing.id));
      let item = await uploadFile(
        api,
        source,
        name,
        parentId,
        { operationId: randomUUID() },
        () => {},
        base && { itemId: base.id, revision: base.revision },
      );
      if (modifiedAt)
        ({ item } = await api.request(`/v1/drive/items/${encodeURIComponent(item.id)}/modified`, {
          method: 'PATCH',
          body: { baseRevision: item.revision, modifiedAt: modifiedAt.toISOString() },
        }));
      return davEntry(item);
    },
    async mkdir(parentId, name) {
      return davEntry((await api.createFolder(name, parentId)).item);
    },
    async move(entry, parentId, name) {
      const item = await current(entry.id);
      const id = encodeURIComponent(item.id);
      const body = { operationId: randomUUID(), baseRevision: item.revision };
      if (item.parentId === parentId)
        await api.request(`/v1/drive/items/${id}`, { method: 'PATCH', body: { ...body, name } });
      else
        await api.request(`/v1/drive/items/${id}/move`, {
          method: 'POST',
          body: { ...body, parentId, ...(name !== item.name ? { name } : {}) },
        });
    },
    async quota() {
      const { storage } = await api.me();
      return { usedBytes: storage.usedBytes, availableBytes: storage.availableBytes };
    },
    async remove(entry) {
      const item = await current(entry.id);
      await api.request(`/v1/drive/items/${encodeURIComponent(item.id)}`, {
        method: 'DELETE',
        body: { operationId: randomUUID(), baseRevision: item.revision },
      });
    },
  };
}
