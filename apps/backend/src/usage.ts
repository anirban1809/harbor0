import type { DriveItem, FileVersion } from '@harbor/contracts';
import { StorageService, userPK } from './domain';
import { DomainError } from './errors';
import { Transaction, transact, type Repository } from './repository';

export type FolderUsage = { itemId: string; bytes: number; files: number; complete: boolean };
type Cached = Omit<FolderUsage, 'itemId'> & { sequence: number; computedAt: number };

/** Items one request may visit; larger trees report a lower bound (`complete: false`). */
export const USAGE_ITEM_BUDGET = 10_000;
/** A result stays good while the account is unchanged, and for this long after it changes. */
export const USAGE_CACHE_MS = 60_000;

const row = async <T>(repo: Repository, pk: string, sk: string) =>
  (await repo.get({ pk, sk }))?.data as T | undefined;

/**
 * Storage consumed by folders: every stored version of every file in the subtree that isn't in
 * the trash, which is what counts against the owner's quota. Folders have no running total, so
 * this walks the tree on demand and caches the answer for a short while.
 */
export class UsageService {
  constructor(
    private s: StorageService,
    private itemBudget = USAGE_ITEM_BUDGET,
  ) {}

  async usage(userId: string, ids: string[]) {
    const tx = new Transaction(this.s.repo);
    const budget = { items: this.itemBudget };
    const items: FolderUsage[] = [];
    for (const id of new Set(ids)) {
      // A folder that was removed, or isn't yours, is left out instead of failing the rest.
      const found = await this.s.authorized(tx, userId, id).catch((error) => {
        if (error instanceof DomainError) return null;
        throw error;
      });
      if (found)
        items.push({ itemId: id, ...(await this.measure(found.owner, found.item, budget)) });
    }
    return { items };
  }

  private async measure(owner: string, item: DriveItem, budget: { items: number }) {
    const repo = this.s.repo;
    const key = `USAGE#${item.id}`;
    const sequence = (await row<{ sequence: number }>(repo, userPK(owner), 'PROFILE'))!.sequence;
    const cached = await row<Cached>(repo, userPK(owner), key);
    if (cached && (cached.sequence === sequence || Date.now() - cached.computedAt < USAGE_CACHE_MS))
      return { bytes: cached.bytes, files: cached.files, complete: cached.complete };
    const total = { bytes: 0, files: 0, complete: true };
    if (item.type === 'FILE') await this.file(owner, item.id, total);
    else await this.folder(owner, item.id, total, budget);
    await transact(repo, (tx) =>
      tx.put(userPK(owner), key, { ...total, sequence, computedAt: Date.now() } satisfies Cached, {
        expiresAt: Math.floor(Date.now() / 1000) + 7 * 86400,
      }),
    ).catch(() => {}); // A lost cache write only costs a recount.
    return total;
  }

  private async folder(
    owner: string,
    folderId: string,
    total: { bytes: number; files: number; complete: boolean },
    budget: { items: number },
  ) {
    const pending = [folderId];
    while (pending.length) {
      const parent = pending.shift()!;
      let cursor: string | undefined;
      do {
        if (budget.items <= 0) {
          total.complete = false;
          return;
        }
        const page = await this.s.repo.query(userPK(owner), `CHILD#${parent}#`, 100, cursor);
        budget.items -= page.rows.length;
        await Promise.all(
          page.rows.map(async (child) => {
            const id = (child.data as { id: string }).id;
            const item = await row<DriveItem>(this.s.repo, userPK(owner), `ITEM#${id}`);
            if (!item || item.deletedAt || item.syncRemovedAt) return;
            if (item.type === 'FOLDER') pending.push(item.id);
            else await this.file(owner, item.id, total);
          }),
        );
        cursor = page.cursor ?? undefined;
      } while (cursor);
    }
  }

  private async file(owner: string, itemId: string, total: { bytes: number; files: number }) {
    total.files++;
    let cursor: string | undefined;
    do {
      const page = await this.s.repo.query(userPK(owner), `VERSION#${itemId}#`, 100, cursor);
      for (const version of page.rows.map((entry) => entry.data as FileVersion))
        if (version.cloudState !== 'RELEASED') total.bytes += version.sizeBytes;
      cursor = page.cursor ?? undefined;
    } while (cursor);
  }
}
