import { z } from 'zod';

/**
 * Problems an app saw that never reach the API: a storage PUT to R2 that failed or stalled,
 * or an upload that gave up. Apps batch them to `POST /v1/client-events`; the API writes each
 * to its request log under the account and device, and the console's API activity shows them.
 * File names and URLs are never sent.
 */
export const clientEventKinds = [
  /** One storage PUT attempt failed; the app retries it. */
  'UPLOAD_PART_RETRY',
  /** An upload stopped with an error the user sees. */
  'UPLOAD_FAILED',
] as const;
export const clientEventStages = [
  'hash',
  'create',
  'parts',
  'storage',
  'complete',
  'other',
] as const;
export const clientEventSchema = z
  .object({
    kind: z.enum(clientEventKinds),
    at: z.iso.datetime(),
    stage: z.enum(clientEventStages),
    uploadId: z.string().max(128).optional(),
    sizeBytes: z.number().int().min(0).optional(),
    partNumber: z.number().int().min(1).max(10_000).optional(),
    attempt: z.number().int().min(0).max(100).optional(),
    /** The HTTP status that answered, 0 when the connection failed before one did. */
    httpStatus: z.number().int().min(0).max(599).optional(),
    /** An API error code or error name, e.g. STORAGE_QUOTA_EXCEEDED, TimeoutError, STALLED. */
    code: z.string().max(64).optional(),
    message: z.string().max(300).optional(),
    /** The browser's or OS's view of the network when it happened. */
    online: z.boolean().optional(),
  })
  .strict();
export const MAX_CLIENT_EVENTS = 20;
export const clientEventsBody = z
  .object({ events: z.array(clientEventSchema).min(1).max(MAX_CLIENT_EVENTS) })
  .strict();
export type ClientEvent = z.infer<typeof clientEventSchema>;
export type ClientEventStage = (typeof clientEventStages)[number];
