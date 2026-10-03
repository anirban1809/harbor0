import type { FolderUsage } from '@harbor/contracts';
import { fileSize } from './file-metadata';

type Request = (path: string, init?: { signal?: AbortSignal }) => Promise<any>;
export type UsageMap = Record<string, FolderUsage>;

/** Storage used by each folder, every stored version included. Asks 50 folders at a time. */
export async function loadUsage(request: Request, ids: string[], signal?: AbortSignal) {
  const unique = [...new Set(ids)];
  const pages = await Promise.all(
    Array.from({ length: Math.ceil(unique.length / 50) }, (_, index) =>
      request(`/v1/drive/usage?ids=${unique.slice(index * 50, index * 50 + 50).join(',')}`, {
        signal,
      }),
    ),
  );
  const map: UsageMap = {};
  for (const page of pages)
    for (const entry of page.items as FolderUsage[]) map[entry.itemId] = entry;
  return map;
}

/**
 * The combined size of several folders, each counted once. Undefined until every folder has a
 * size; incomplete when a folder was too large to count fully, so the total is a lower bound.
 */
export function totalUsage(ids: string[], usage: UsageMap | undefined) {
  if (!usage) return undefined;
  let bytes = 0;
  let complete = true;
  for (const id of new Set(ids)) {
    const entry = usage[id];
    // A folder left out was removed or can't be read; it adds nothing.
    if (!entry) continue;
    bytes += entry.bytes;
    complete &&= entry.complete;
  }
  return { bytes, complete };
}

export const usageLabel = (usage: { bytes: number; complete: boolean } | undefined) =>
  usage
    ? usage.complete
      ? fileSize(usage.bytes)
      : `At least ${fileSize(usage.bytes)}`
    : undefined;
