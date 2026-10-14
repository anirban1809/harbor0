/** API requests one account may make a minute, across all its devices; see the API's rateLimit. */
export const RATE_LIMIT = 600;
/**
 * Uploads and backup runs have a minute's allowance of their own, so a large first backup or
 * upload neither stalls on the general limit nor leaves the rest of the app refused.
 */
export const BULK_RATE_LIMIT = 1800;
/** Whether a request, by route template or by path, counts against BULK_RATE_LIMIT. */
export function bulkTransferPath(path: string) {
  return /^\/v1\/(uploads(\/|$|\?)|backups\/[^/]+\/runs\/)/.test(path);
}
/** Small files a backup run commits in one request; see the batch upload routes. */
export const BATCH_UPLOAD_FILES = 25;
/** Files up to this size go in batches: one storage part each. Larger ones upload alone. */
export const BATCH_UPLOAD_MAX_BYTES = 8 * 1024 * 1024;
/** Synced copies a desktop confirms in one request; see POST /v1/sync/items/acknowledge. */
export const SYNC_ACKNOWLEDGE_ITEMS = 50;
