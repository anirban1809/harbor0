import { z } from 'zod';

/**
 * What an app's sync and backup engine is doing, reported as it changes (see
 * docs/specs/device-activity.md). Apps batch events to `POST /v1/activity`; the API logs each
 * one and keeps every subject's current status. Counts only: never file or folder names.
 */
export const activityScopes = ['ENGINE', 'SYNC', 'BACKUP'] as const;
export const activityStatuses = ['PAUSED', 'BLOCKED', 'ACTIVE', 'IDLE'] as const;
export const activityActions = [
  'PAUSED',
  'RESUMED',
  'BLOCKED',
  'UNBLOCKED',
  'STARTED',
  'FINISHED',
  /** First report of a subject that is idle. */
  'IDLE',
] as const;
export const activityReasons = ['USER', 'ALL', 'APP', 'STORAGE_FULL', 'LOCKED'] as const;
export type ActivityScope = (typeof activityScopes)[number];
export type ActivityStatus = (typeof activityStatuses)[number];
export type ActivityAction = (typeof activityActions)[number];
export type ActivityReason = (typeof activityReasons)[number];

export const activityEventSchema = z
  .object({
    id: z.uuid(),
    at: z.iso.datetime(),
    scope: z.enum(activityScopes),
    /** A sync folder's cloud item id, or a backup's id; none for the engine. */
    folderId: z.string().min(1).max(128).optional(),
    action: z.enum(activityActions),
    status: z.enum(activityStatuses),
    reason: z.enum(activityReasons).optional(),
    files: z.number().int().min(0).optional(),
    bytes: z.number().int().min(0).optional(),
    failed: z.number().int().min(0).optional(),
    runId: z.string().max(128).optional(),
  })
  .strict()
  .refine((e) => (e.scope === 'ENGINE') === (e.folderId === undefined), {
    message: 'Folder events need a folderId; engine events have none.',
  });
export const ACTIVITY_BATCH = 50;
export const activityBody = z
  .object({ events: z.array(activityEventSchema).min(1).max(ACTIVITY_BATCH) })
  .strict();
export type ActivityEvent = z.infer<typeof activityEventSchema>;

/** A subject's status as the server keeps it, one row per device and subject. */
export const activityStateSchema = z.object({
  /** The device's installation key, or its session when it has none. */
  deviceKey: z.string(),
  deviceId: z.string(),
  scope: z.enum(activityScopes),
  folderId: z.string().nullable(),
  status: z.enum(activityStatuses),
  reason: z.enum(activityReasons).nullable(),
  /** When the subject took this status, as the device saw it. */
  since: z.string(),
  action: z.enum(activityActions),
  files: z.number().nullable(),
  bytes: z.number().nullable(),
  failed: z.number().nullable(),
  runId: z.string().nullable(),
  /** When the server last heard from the device about this subject. */
  reportedAt: z.string(),
});
export type ActivityState = z.infer<typeof activityStateSchema>;
