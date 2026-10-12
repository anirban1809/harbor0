import { useSyncExternalStore } from 'react';
import { ApiClient, ApiError, operation, type Transport } from '@harbor/api-client';
import type { DriveItem, E2eeMigration } from '@harbor/contracts';
import {
  decryptName,
  encryptName,
  isEncryptedName,
  plainSize,
  type AccountKeys,
} from '../../../packages/api-client/src/e2ee';
import { openEncrypted, rangeFetcher, uploadEncrypted, type PlainReader } from './e2ee-files';
import { isNameConflict, numberedName, put } from './upload';

/**
 * Re-encrypts files stored before encryption was turned on: each file's name, then its content
 * as a new version, then its unencrypted versions are deleted. Runs in one tab at a time while
 * the account is unlocked, and picks up where it left off, as already encrypted files are
 * skipped. Backups stay as they are: only the desktop app that owns them may change them.
 *
 * It talks to the API without the encrypting transport, to see which names are still plain.
 */
export type MigrationProgress = Omit<E2eeMigration, 'deviceName' | 'updatedAt'> & {
  /** Encrypting existing files after turning on, or decrypting them to turn off. */
  direction: 'encrypt' | 'decrypt';
  running: boolean;
  current?: string;
  error?: string;
};
let progress: MigrationProgress | null = null;
const listeners = new Set<() => void>();
const publish = (next: MigrationProgress | null) => {
  progress = next;
  for (const l of listeners) l();
};
export function useMigrationProgress() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => progress,
    () => null,
  );
}

type Found = { item: DriveItem; backup: boolean };
async function walk(api: ApiClient, signal: AbortSignal) {
  const found: Found[] = [];
  const folders: { id: string | null; backup: boolean }[] = [{ id: null, backup: false }];
  while (folders.length) {
    const folder = folders.shift()!;
    let cursor: string | undefined;
    do {
      signal.throwIfAborted();
      const page = await api.list(folder.id, cursor, signal);
      for (const item of page.items) {
        const backup = folder.backup || !!item.backupRootId;
        found.push({ item, backup });
        if (item.type === 'FOLDER') folders.push({ id: item.id, backup });
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
  }
  return found;
}

/** A plaintext file in storage, read through its download link. */
async function plainSource(api: ApiClient, item: DriveItem): Promise<PlainReader> {
  const link = await api.download({ driveItemId: item.id });
  const fetchRange = rangeFetcher(
    link.downloadUrl,
    async () => (await api.download({ driveItemId: item.id })).downloadUrl,
  );
  return { size: link.sizeBytes, read: (b, e) => fetchRange(b, e) };
}

const done = (f: Found) =>
  f.item.type === 'FILE' && f.item.encrypted && isEncryptedName(f.item.name);
const purgeKey = (userId: string) => `harbor0-e2ee-purge:${userId}`;

export async function runMigration(
  raw: Transport,
  userId: string,
  keys: AccountKeys,
  signal: AbortSignal,
) {
  const api = new ApiClient(raw);
  const found = await walk(api, signal);
  const files = found.filter((f) => f.item.type === 'FILE');
  const counted = files.filter((f) => !f.backup);
  const size = (f: Found) => (f.item.encrypted ? plainSize(f.item.sizeBytes) : f.item.sizeBytes);
  const state: MigrationProgress = {
    direction: 'encrypt',
    running: true,
    totalFiles: counted.length,
    doneFiles: counted.filter(done).length,
    totalBytes: counted.reduce((n, f) => n + size(f), 0),
    doneBytes: counted.filter(done).reduce((n, f) => n + size(f), 0),
    skippedFiles: files.length - counted.length,
    complete: false,
  };
  let reported = 0;
  const report = async (force = false) => {
    publish({ ...state });
    if (!force && Date.now() - reported < 15_000) return;
    reported = Date.now();
    const { running: _, current: __, error: ___, ...body } = state;
    await raw('/v1/e2ee/migration', { method: 'PUT', body }).catch(() => {});
  };
  await report(true);
  // Versions left behind if a tab closed between uploading and purging.
  const pending = new Set<string>(JSON.parse(localStorage.getItem(purgeKey(userId)) ?? '[]'));
  const savePending = () => localStorage.setItem(purgeKey(userId), JSON.stringify([...pending]));
  const purge = async (id: string) => {
    pending.add(id);
    savePending();
    await raw(`/v1/e2ee/items/${id}/purge-plaintext`, { method: 'POST' }).catch((e) => {
      if (!(e instanceof ApiError && [404, 409].includes(e.status))) throw e;
    });
    pending.delete(id);
    savePending();
  };
  for (const id of [...pending]) await purge(id).catch(() => {});

  let failed = 0;
  // Folders first, so names are hidden even before the slower content step.
  for (const f of found.filter((f) => !f.backup && f.item.type === 'FOLDER')) {
    signal.throwIfAborted();
    if (isEncryptedName(f.item.name)) continue;
    try {
      await rename(api, f.item, keys);
    } catch {
      failed++;
    }
  }
  for (const f of counted) {
    signal.throwIfAborted();
    if (done(f)) continue;
    state.current = f.item.name;
    publish({ ...state });
    try {
      let item = f.item;
      if (!item.encrypted) {
        if (item.cloudState === 'RELEASED') {
          // Its content is only on synced devices; it is encrypted when one uploads it again.
          state.skippedFiles++;
          continue;
        }
        item = await uploadEncrypted({
          api,
          keys,
          source: await plainSource(api, item),
          name: item.name,
          parentId: item.parentId,
          replace: item,
          signal,
          put,
          onProgress: () => {},
        });
        await purge(item.id);
      }
      if (!isEncryptedName(item.name)) await rename(api, item, keys);
      state.doneFiles++;
      state.doneBytes += size(f);
      await report();
    } catch (e) {
      if (signal.aborted) throw e;
      failed++;
      state.error = (e as Error).message;
    }
  }
  state.current = undefined;
  state.complete = failed === 0;
  state.running = false;
  await report(true);
  return state;
}

async function rename(api: ApiClient, item: DriveItem, keys: AccountKeys) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const current: DriveItem =
      attempt === 0 ? item : (await api.request(`/v1/drive/items/${item.id}`)).item;
    if (isEncryptedName(current.name)) return current;
    try {
      return (
        await api.request(`/v1/drive/items/${item.id}`, {
          method: 'PATCH',
          body: {
            ...operation(),
            baseRevision: current.revision,
            name: await encryptName(keys, current.name),
          },
        })
      ).item as DriveItem;
    } catch (e) {
      if (!(e instanceof ApiError && e.code === 'REVISION_CONFLICT')) throw e;
    }
  }
  throw new Error('The item kept changing; it will be encrypted on the next pass.');
}

/** Runs the migration in this tab unless another tab already is, retrying failures later. */
export function startMigration(raw: Transport, userId: string, keys: AccountKeys) {
  const controller = new AbortController();
  const run = async () => {
    for (let pass = 0; !controller.signal.aborted; pass++) {
      try {
        const result = await runMigration(raw, userId, keys, controller.signal);
        if (result.complete) return;
      } catch (e) {
        if (controller.signal.aborted) return;
        publish({ ...(progress ?? emptyProgress()), running: false, error: (e as Error).message });
      }
      await new Promise((r) => setTimeout(r, Math.min(300_000, 30_000 * 2 ** pass)));
    }
  };
  if (typeof navigator !== 'undefined' && navigator.locks)
    void navigator.locks.request(
      `harbor0-e2ee-migration:${userId}`,
      { ifAvailable: true },
      async (lock) => {
        if (lock) await run();
      },
    );
  else void run();
  return () => controller.abort();
}
const emptyProgress = (
  direction: MigrationProgress['direction'] = 'encrypt',
): MigrationProgress => ({
  direction,
  running: false,
  totalFiles: 0,
  doneFiles: 0,
  totalBytes: 0,
  doneBytes: 0,
  skippedFiles: 0,
  complete: false,
});

/**
 * Turning encryption off: decrypts every file and name the account stores, Trash included,
 * then asks the server to delete the keys. Each file's current version is uploaded again
 * unencrypted and its encrypted versions are deleted, as nothing could read them afterwards.
 * Items in Trash are restored for a moment, decrypted and put back.
 */
export async function runDecryption(
  raw: Transport,
  keys: AccountKeys,
  signal: AbortSignal,
): Promise<MigrationProgress & { finished: boolean }> {
  const api = new ApiClient(raw);
  const found = (await walk(api, signal)).filter((f) => !f.backup);
  const trashed: DriveItem[] = [];
  let cursor: string | null = null;
  do {
    const page: { items: DriveItem[]; nextCursor: string | null } = await raw(
      `/v1/search?trash=true&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      { signal },
    );
    trashed.push(...page.items.filter(needsWork));
    cursor = page.nextCursor;
  } while (cursor);
  const files = found.filter((f) => f.item.type === 'FILE');
  const state: MigrationProgress = {
    direction: 'decrypt',
    running: true,
    totalFiles: files.length + trashed.length,
    doneFiles: files.filter((f) => !needsWork(f.item)).length,
    totalBytes: files.reduce((n, f) => n + plainBytes(f.item), 0),
    doneBytes: files.filter((f) => !needsWork(f.item)).reduce((n, f) => n + plainBytes(f.item), 0),
    skippedFiles: 0,
    complete: false,
  };
  let reported = 0;
  const report = async (force = false) => {
    publish({ ...state });
    if (!force && Date.now() - reported < 15_000) return;
    reported = Date.now();
    const { running: _, current: __, error: ___, direction: ____, ...body } = state;
    await raw('/v1/e2ee/decryption', { method: 'PUT', body }).catch(() => {});
  };
  await report(true);
  let failed = 0;
  const attempt = async (work: () => Promise<unknown>) => {
    try {
      await work();
      return true;
    } catch (e) {
      if (signal.aborted) throw e;
      failed++;
      state.error = (e as Error).message;
      return false;
    }
  };
  const decryptItem = async (item: DriveItem) => {
    signal.throwIfAborted();
    if (item.type === 'FOLDER') {
      if (isEncryptedName(item.name)) await plainRename(api, item, keys);
      return;
    }
    state.current = isEncryptedName(item.name) ? await decryptName(keys, item.name) : item.name;
    publish({ ...state });
    let current = item;
    if (item.encrypted) {
      current = await uploadEncrypted({
        api,
        keys,
        source: await openEncrypted(api, { driveItemId: item.id }, keys),
        name: state.current,
        parentId: item.parentId,
        replace: item,
        signal,
        put,
        plain: true,
        onProgress: () => {},
      });
      await raw(`/v1/e2ee/items/${item.id}/purge-encrypted`, { method: 'POST' });
    }
    if (isEncryptedName(current.name)) await plainRename(api, current, keys);
  };
  // Folders first, then files, as in the live tree.
  for (const f of found.filter((f) => f.item.type === 'FOLDER'))
    await attempt(() => decryptItem(f.item));
  for (const f of files) {
    if (!needsWork(f.item)) continue;
    if (await attempt(() => decryptItem(f.item))) {
      state.doneFiles++;
      state.doneBytes += plainBytes(f.item);
    }
    await report();
  }
  for (const item of trashed) {
    const ok = await attempt(async () => {
      const restored: DriveItem = (
        await api.request(`/v1/drive/items/${item.id}/restore`, {
          method: 'POST',
          body: { ...operation(), baseRevision: item.revision },
        })
      ).item;
      try {
        await decryptItem(restored);
        if (restored.type === 'FOLDER')
          for (const inner of await walkFrom(api, restored.id, signal))
            await decryptItem(inner.item);
      } finally {
        const latest: DriveItem = (await api.request(`/v1/drive/items/${item.id}`)).item;
        await api.request(`/v1/drive/items/${item.id}`, {
          method: 'DELETE',
          body: { ...operation(), baseRevision: latest.revision },
        });
      }
    });
    if (ok) state.doneFiles++;
    await report();
  }
  state.current = undefined;
  state.running = false;
  let finished = false;
  if (failed === 0) {
    try {
      await raw('/v1/e2ee/disable/finish', { method: 'POST', body: { proof: keys.proof } });
      finished = true;
      state.complete = true;
    } catch (e) {
      state.error = (e as Error).message;
    }
  }
  await report(true);
  return { ...state, finished };
}

const needsWork = (item: DriveItem) => !!item.encrypted || isEncryptedName(item.name);
const plainBytes = (item: DriveItem) =>
  item.encrypted ? plainSize(item.sizeBytes) : item.sizeBytes;
async function walkFrom(api: ApiClient, id: string, signal: AbortSignal) {
  const found: Found[] = [];
  const folders = [id];
  while (folders.length) {
    const folder = folders.shift()!;
    let cursor: string | undefined;
    do {
      signal.throwIfAborted();
      const page = await api.list(folder, cursor, signal);
      for (const item of page.items) {
        found.push({ item, backup: false });
        if (item.type === 'FOLDER') folders.push(item.id);
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
  }
  return found;
}

/** Gives an item its decrypted name, numbering it if a name differing only in case is taken. */
async function plainRename(api: ApiClient, item: DriveItem, keys: AccountKeys) {
  const name = await decryptName(keys, item.name);
  let revision = item.revision;
  for (let n = 1; n <= 50; n++) {
    try {
      return (
        await api.request(`/v1/drive/items/${item.id}`, {
          method: 'PATCH',
          body: {
            ...operation(),
            baseRevision: revision,
            name: n === 1 ? name : numberedName(name, n),
          },
        })
      ).item as DriveItem;
    } catch (e) {
      if (e instanceof ApiError && e.code === 'REVISION_CONFLICT') {
        const latest: DriveItem = (await api.request(`/v1/drive/items/${item.id}`)).item;
        if (!isEncryptedName(latest.name)) return latest;
        revision = latest.revision;
        n--;
        continue;
      }
      if (!isNameConflict(e)) throw e;
    }
  }
  throw new Error('No free name was found for a decrypted item.');
}

/** Decrypts in this tab unless another tab already is, retrying until it can finish. */
export function startDecryption(
  raw: Transport,
  userId: string,
  keys: AccountKeys,
  onFinished: () => void,
) {
  const controller = new AbortController();
  const run = async () => {
    for (let pass = 0; !controller.signal.aborted; pass++) {
      try {
        const result = await runDecryption(raw, keys, controller.signal);
        if (result.finished) {
          publish(null);
          return onFinished();
        }
      } catch (e) {
        if (controller.signal.aborted) return;
        publish({
          ...(progress ?? emptyProgress('decrypt')),
          running: false,
          error: (e as Error).message,
        });
      }
      await new Promise((r) => setTimeout(r, Math.min(120_000, 10_000 * 2 ** pass)));
    }
  };
  if (typeof navigator !== 'undefined' && navigator.locks)
    void navigator.locks
      .request(`harbor0-e2ee-migration:${userId}`, { signal: controller.signal }, run)
      .catch(() => {});
  else void run();
  return () => controller.abort();
}
