import { z } from 'zod';
import { deviceSchema, platform, storageSchema, trackingId } from './index';
import { flagReason, flagRuleSchema } from './flags';

/**
 * The management console's API. Staff sign in to their own Cognito pool, never the
 * customer pool, and every change they make is written to the audit log.
 */
export const staffRole = z.enum(['ADMIN', 'SUPPORT']);
export const staffSchema = z.object({
  id: z.string(),
  email: z.string(),
  role: staffRole,
});

/** Actions each role may take. Support can look and help; only admins change accounts. */
export const staffPermissions = {
  SUPPORT: ['read', 'note', 'password-reset', 'resend-verification', 'sign-out'],
  ADMIN: [
    'read',
    'note',
    'password-reset',
    'resend-verification',
    'sign-out',
    'confirm',
    'quota',
    'suspend',
    'delete',
    'beta',
    'flags',
    'campaigns',
    'forms',
    'tracking',
  ],
} as const satisfies Record<z.infer<typeof staffRole>, readonly string[]>;
export type StaffPermission = (typeof staffPermissions)['ADMIN'][number];
export const can = (role: z.infer<typeof staffRole>, permission: StaffPermission) =>
  (staffPermissions[role] as readonly string[]).includes(permission);

// Sign-in is email and password. New staff replace their temporary password first.
export const staffLoginResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('SIGNED_IN'), staff: staffSchema }),
  z.object({
    status: z.literal('CHALLENGE'),
    challenge: z.enum(['NEW_PASSWORD']),
    session: z.string(),
  }),
]);

/** Status of the sign-in account in the identity provider. */
export const accountStatus = z.enum([
  'CONFIRMED',
  'UNCONFIRMED',
  'RESET_REQUIRED',
  'FORCE_CHANGE_PASSWORD',
  'UNKNOWN',
]);
export const directoryUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  username: z.string().nullable(),
  displayName: z.string().nullable(),
  status: accountStatus,
  enabled: z.boolean(),
  createdAt: z.string().nullable(),
});
export const adminProfileSchema = z.object({
  username: z.string(),
  displayName: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable(),
  purgeAt: z.string().nullable(),
  suspendedAt: z.string().nullable(),
  suspendedReason: z.string().nullable(),
  storage: storageSchema.extend({
    trashBytes: z.number(),
    purgingBytes: z.number(),
  }),
});
export const auditEntrySchema = z.object({
  id: z.string(),
  at: z.string(),
  actor: z.object({ id: z.string(), email: z.string() }),
  action: z.string(),
  userId: z.string().nullable(),
  userEmail: z.string().nullable(),
  reason: z.string().nullable(),
  details: z.record(z.string(), z.unknown()),
});
/** An account's email settings: optional email, a bounce or complaint, and campaign groups. */
export const adminUserEmailSchema = z.object({
  productUpdates: z.boolean(),
  suppressed: z.object({ source: z.enum(['BOUNCE', 'COMPLAINT']), at: z.string() }).nullable(),
  groups: z.array(z.object({ id: z.string(), name: z.string() })),
});
export const adminUserDetailSchema = z.object({
  account: directoryUserSchema,
  /** Null until the user verifies their email and first signs in. */
  profile: adminProfileSchema.nullable(),
  devices: z.array(deviceSchema),
  backupCount: z.number(),
  activity: z.array(auditEntrySchema),
  /** Each feature flag for this account, ignoring app versions (those vary by device). */
  flags: z.array(z.object({ key: z.string(), enabled: z.boolean(), reason: flagReason })),
  email: adminUserEmailSchema,
  /** The sign-up link's tracking id and the source staff mapped it to; null without one. */
  signup: z
    .object({ trackingId: z.string(), source: z.string().nullable(), at: z.string() })
    .nullable(),
  /** Other accounts whose apps signed in with one of this account's device keys. */
  sameDevice: z.array(
    z.object({
      userId: z.string(),
      email: z.string(),
      /** When that account first signed in with the shared key. */
      boundAt: z.string(),
      suspended: z.boolean(),
      deleted: z.boolean(),
    }),
  ),
});
/** How the console orders the account list; Cognito's own order is unsorted. */
export const adminUserSortSchema = z.object({
  /** `activity` is the last upload, download or other usage, from the request log. */
  sort: z.enum(['created', 'storage', 'seen', 'activity']),
  order: z.enum(['asc', 'desc']).default('desc'),
});
/** A day count in a filter window, from 1 day to 10 years. */
const days = '([1-9]\\d{0,3})d';
/** Hours or days the request log still covers: up to 720 hours or 30 days. */
const hours = '([1-9]|[1-9]\\d|[1-6]\\d\\d|7[01]\\d|720)h';
const logDays = '([1-9]|[12]\\d|30)d';
/**
 * Narrows the account list. Each filter is optional and they all apply together, so
 * `platform=ANDROID&seen=inactive-30d` is the Android users who have gone quiet. The numeric
 * filters take any value: `over-75` (% of quota), `gb-10`, `14d`, `inactive-45d`, `older-180d`.
 */
export const adminUserFiltersSchema = z.object({
  /** Account state; `never-signed-in` has a sign-in account but no profile yet. */
  state: z
    .enum(['active', 'unverified', 'disabled', 'suspended', 'deleted', 'never-signed-in'])
    .optional(),
  /** A platform the account has signed in from, a group of them, or `NONE` for no sign-ins. */
  platform: z.enum([...platform.options, 'MOBILE', 'DESKTOP', 'NONE']).optional(),
  /** Nothing or something stored, at least N% of the quota (`over-N`), or at least N GB (`gb-N`). */
  storage: z
    .string()
    .regex(/^(empty|uploaded|over-(100|[1-9]\d?)|gb-(\d{1,6}(\.\d{1,3})?))$/)
    .optional(),
  /** Whether staff raised the quota above what the account got at sign-up. */
  quota: z.enum(['standard', 'raised']).optional(),
  /** Any device seen within N days (`Nd`), none seen for more than N (`inactive-Nd`), or never. */
  seen: z
    .string()
    .regex(new RegExp(`^(never|${days}|inactive-${days})$`))
    .optional(),
  /** Created within N days (`Nd`) or more than N days ago (`older-Nd`). */
  joined: z
    .string()
    .regex(new RegExp(`^(${days}|older-${days})$`))
    .optional(),
  /**
   * What the account's desktop apps do: sync folders (`sync`), back up folders (`backup`),
   * either, or `neither`. Counts signed-in Mac, Windows and Linux apps only, and backups that
   * are on (not paused, archived or removed).
   */
  desktop: z.enum(['sync', 'backup', 'either', 'neither']).optional(),
  /**
   * Usage (uploads, downloads, file changes, sync and backups) within N hours (`Nh`) or days
   * (`Nd`), none for more than N days (`inactive-Nd`), or none at all (`none`). Read from the
   * request log, which keeps 30 days, so days go up to 30.
   */
  activity: z
    .string()
    .regex(new RegExp(`^(none|${hours}|${logDays}|inactive-${logDays})$`))
    .optional(),
});
export const adminUserListItemSchema = directoryUserSchema.extend({
  quotaBytes: z.number().nullable(),
  usedBytes: z.number().nullable(),
  suspended: z.boolean(),
  deleted: z.boolean(),
  /** Platforms the account has signed in from, signed out or not. */
  platforms: z.array(platform).default([]),
  /** The latest time any of its devices was seen. */
  lastSeenAt: z.string().nullable().default(null),
  /** The account's latest usage in the request log, when the list was asked for it. */
  lastActivityAt: z.string().nullable().default(null),
  /** What that was, a `USAGE_ACTIONS` value such as UPLOADED. */
  lastAction: z.string().nullable().default(null),
});
export const adminUserPageSchema = z.object({
  items: z.array(adminUserListItemSchema),
  nextCursor: z.string().nullable(),
  /** Every account that matches, across all pages; only when filtering or sorting. */
  summary: z
    .object({
      computedAt: z.string(),
      accounts: z.number(),
      usedBytes: z.number(),
      quotaBytes: z.number(),
      /** Matching accounts seen on any device in the last 30 days. */
      active30d: z.number(),
      /** Matching accounts per platform they have signed in from. */
      platforms: z.partialRecord(platform, z.number()),
      /** When the request log was read for usage; null when the list didn't need it. */
      activityComputedAt: z.string().nullable().default(null),
      /** Matching accounts that uploaded, downloaded or changed anything in 24 hours. */
      usage24h: z.number().nullable().default(null),
    })
    .nullable()
    .default(null),
});
export const auditPageSchema = z.object({
  items: z.array(auditEntrySchema),
  nextCursor: z.string().nullable(),
});
/** Storage summed over every account, from a cached table scan. Bytes are decimal. */
export const storageTotalsSchema = z.object({
  computedAt: z.string(),
  /** Accounts with a drive and a sign-in, excluding deleted ones. */
  accounts: z.number(),
  /** Sum of `storageUsedBytes`: what live accounts store, trash and all versions included. */
  usedBytes: z.number(),
  /** Sum of storage limits: what live accounts may store. */
  allocatedBytes: z.number(),
  /** Uploads in progress, reserved against limits but not yet stored. */
  reservedBytes: z.number(),
  /** Part of `usedBytes` that is in trash. */
  trashBytes: z.number(),
  /** Still in storage but leaving: emptied trash being purged, and deleted accounts' files. */
  pendingDeletionBytes: z.number(),
  deletedAccounts: z.number(),
  /** Deleted accounts still in their grace period, whose files have not started purging. */
  awaitingPurge: z.object({ accounts: z.number(), usedBytes: z.number() }),
  /**
   * Profiles whose sign-in account no longer exists but which were never deleted through the
   * app (e.g. removed directly in Cognito). Excluded from the totals above.
   */
  orphans: z.object({ accounts: z.number(), usedBytes: z.number(), allocatedBytes: z.number() }),
});
/**
 * What running harbor0 has cost since `since`, in USD: the AWS bill from Cost Explorer (before
 * credits, refunds and tax) plus R2 storage at Cloudflare's standard rate with no free tier.
 * Refreshed daily at 06:00 IST; days are UTC, as AWS bills them.
 */
export const platformCostsSchema = z.object({
  computedAt: z.string(),
  since: z.string(),
  /** The last day included, the UTC day before the refresh. */
  through: z.string(),
  totalUsd: z.number(),
  aws: z.object({
    totalUsd: z.number(),
    services: z.array(z.object({ service: z.string(), usd: z.number() })),
  }),
  r2: z.object({
    totalUsd: z.number(),
    /** USD per decimal GB-month. R2 operations are not counted. */
    rate: z.number(),
    /** Bytes in the bucket at the refresh. */
    storedBytes: z.number(),
    /** Days priced from objects' write dates; later deletions make these low. */
    reconstructedDays: z.number(),
  }),
  daily: z.array(z.object({ date: z.string(), awsUsd: z.number(), r2Usd: z.number() })),
});
export const adminOverviewSchema = z.object({
  estimatedUsers: z.number().nullable(),
  storage: storageTotalsSchema.nullable(),
  costs: platformCostsSchema.nullable().default(null),
  recent: z.array(auditEntrySchema),
});

/**
 * Requests an app makes by itself, without anyone clicking: polling, session upkeep, sync
 * bookkeeping. Written as "METHOD route" with the route pattern the request log records.
 */
export const BACKGROUND_REQUESTS = [
  'GET /v1/users/me',
  'GET /v1/sync/status',
  'GET /v1/sync/changes',
  'GET /v1/sync/folders',
  'GET /v1/sync/shares',
  'GET /v1/sync/shares/:id/status',
  'GET /v1/notifications',
  'GET /v1/backups',
  'GET /v1/backups/:id',
  'GET /v1/backups/:id/pending-restores',
  'GET /v1/transfers/received',
  'GET /v1/drive/usage',
  'GET /v1/billing/subscription',
  'GET /v1/uploads/:id',
  'GET /v1/folder-downloads/:id',
  'POST /v1/realtime/tickets',
  'POST /v1/auth/session',
  'POST /v1/auth/session/challenge',
  'POST /v1/auth/refresh',
  'POST /v1/sync/devices/register',
  'POST /v1/sync/checkpoints',
  'POST /v1/sync/items/:id/acknowledge',
  'POST /v1/client-events',
  'PUT /v1/devices/current/push',
] as const;
/** What the mobile apps' on-device sync and backup send by themselves. */
const ENGINE_REQUESTS = [
  'POST /v1/uploads',
  'POST /v1/uploads/:id/parts',
  'POST /v1/uploads/:id/complete',
  'POST /v1/uploads/batch',
  'POST /v1/uploads/batch/finish',
  'DELETE /v1/uploads/:id',
  'POST /v1/downloads',
  'POST /v1/sync/operations',
  'POST /v1/sync/items/acknowledge',
  'POST /v1/sync/items/:id/request-content',
  'POST /v1/backups/:id/runs',
  'POST /v1/backups/:id/runs/:runId/folders',
  'POST /v1/backups/:id/runs/:runId/uploads',
  'POST /v1/backups/:id/runs/:runId/uploads/batch',
  'GET /v1/backups/:id/runs/:runId/files',
  'POST /v1/backups/:id/runs/:runId/files/batch',
  'POST /v1/backups/:id/runs/:runId/files',
  'POST /v1/backups/:id/runs/:runId/complete',
  'POST /v1/backups/:id/checked',
  'POST /v1/backups/:id/restores/:restoreId/complete',
];
/**
 * The desktop apps have no file browser: their sync engine also reads, creates, renames, moves
 * and deletes items, and re-registers its sync folders.
 */
export const DESKTOP_ENGINE_REQUESTS = [
  ...ENGINE_REQUESTS,
  'GET /v1/drive/items/:id',
  'GET /v1/drive/folders/:id/children',
  'POST /v1/drive/folders',
  'PATCH /v1/drive/items/:id',
  'POST /v1/drive/items/:id/move',
  'DELETE /v1/drive/items/:id',
  'PUT /v1/sync/folders',
] as const;
export const MOBILE_ENGINE_REQUESTS = ENGINE_REQUESTS;
const DESKTOP_PLATFORMS = ['MACOS', 'WINDOWS', 'LINUX'];
const MOBILE_PLATFORMS = ['IOS', 'ANDROID'];
/**
 * Whether the app made a request by itself rather than for a person's click, judged from the
 * route and the platform. A best guess: a desktop rename the person made in Finder or Explorer
 * also counts as automatic, since the sync engine sends it.
 */
export function isAutomatedRequest(method: string, route: string, platform: string | null) {
  const key = `${method} ${route}`;
  if ((BACKGROUND_REQUESTS as readonly string[]).includes(key)) return true;
  if (platform && DESKTOP_PLATFORMS.includes(platform))
    return (DESKTOP_ENGINE_REQUESTS as readonly string[]).includes(key);
  if (platform && MOBILE_PLATFORMS.includes(platform)) return MOBILE_ENGINE_REQUESTS.includes(key);
  return false;
}
/** The same test as `isAutomatedRequest`, as a Logs Insights expression over a request line. */
export function automatedRequestQuery() {
  const list = (items: readonly string[]) => `[${items.map((i) => JSON.stringify(i)).join(', ')}]`;
  const key = 'concat(method, " ", route)';
  return (
    `(${key} in ${list(BACKGROUND_REQUESTS)}` +
    ` or (platform in ${list(DESKTOP_PLATFORMS)} and ${key} in ${list(DESKTOP_ENGINE_REQUESTS)})` +
    ` or (platform in ${list(MOBILE_PLATFORMS)} and ${key} in ${list(MOBILE_ENGINE_REQUESTS)}))`
  );
}
export const adminActivityOrigins = ['manual', 'automated', 'all'] as const;
export type AdminActivityOrigin = (typeof adminActivityOrigins)[number];
export const ADMIN_REQUEST_PAGE = 50;
/** How far back a user's activity lookup reads the API request log. */
export const adminActivityRanges = ['1h', '24h', '7d', '30d'] as const;
export const adminActivityQuery = z.object({
  range: z.enum(adminActivityRanges).default('24h'),
});
export const adminRequestLogQuery = z.object({
  range: z.enum(adminActivityRanges).default('24h'),
  origin: z.enum(adminActivityOrigins).default('manual'),
  /** Only requests that failed (status 400 and up). */
  failed: z.enum(['0', '1']).default('0'),
  cursor: z.string().max(4096).optional(),
});
/** One API request an account made, from the request log. */
export const adminActivityRequestSchema = z.object({
  automated: z.boolean(),
  at: z.string(),
  requestId: z.string(),
  method: z.string(),
  route: z.string(),
  status: z.number(),
  /** The error code a failed request answered with. */
  code: z.string().nullable(),
  ms: z.number().nullable(),
  deviceId: z.string().nullable(),
  platform: z.string().nullable(),
  appVersion: z.string().nullable(),
});
/** A problem an app reported, e.g. a storage PUT that failed or stalled. */
export const adminAppEventSchema = z.object({
  at: z.string(),
  kind: z.string(),
  stage: z.string(),
  code: z.string().nullable(),
  httpStatus: z.number().nullable(),
  message: z.string().nullable(),
  uploadId: z.string().nullable(),
  sizeBytes: z.number().nullable(),
  partNumber: z.number().nullable(),
  attempt: z.number().nullable(),
  online: z.boolean().nullable(),
  deviceId: z.string().nullable(),
  platform: z.string().nullable(),
  appVersion: z.string().nullable(),
});
/**
 * An account's API requests over a range: totals, failures grouped by route and error, and the
 * latest requests. Read from the request log (kept 30 days), which names accounts since
 * 11 Oct 2026.
 */
/** A page of an account's requests, newest first. */
export const adminRequestLogSchema = z.object({
  requests: z.array(adminActivityRequestSchema),
  nextCursor: z.string().nullable(),
});
export const adminActivitySchema = z.object({
  range: z.enum(adminActivityRanges),
  since: z.string(),
  totals: z.object({
    requests: z.number(),
    /** Status 400 and up, sign-in expiry (401) included. */
    failed: z.number(),
    /** Status 500 and up: our faults, not the caller's. */
    serverErrors: z.number(),
    /** 401s, mostly expired sessions an app renews by itself. */
    unauthorized: z.number(),
    /** Storage PUTs the apps retried, as they reported them. */
    appRetries: z.number().default(0),
    /** Uploads the apps reported as failed. */
    appFailures: z.number().default(0),
    /** Requests a person made, by `isAutomatedRequest`. */
    manual: z.number().default(0),
    /** Requests the apps made by themselves. */
    automated: z.number().default(0),
  }),
  problems: z.array(
    z.object({
      method: z.string(),
      route: z.string(),
      status: z.number(),
      code: z.string().nullable(),
      count: z.number(),
      lastAt: z.string(),
      automated: z.boolean().default(false),
    }),
  ),
  /** Problems the apps reported (`POST /v1/client-events`), grouped. */
  appProblems: z
    .array(
      z.object({
        kind: z.string(),
        stage: z.string(),
        code: z.string().nullable(),
        httpStatus: z.number().nullable(),
        count: z.number(),
        lastAt: z.string(),
      }),
    )
    .default([]),
  /** The latest problems the apps reported. */
  appEvents: z.array(adminAppEventSchema).default([]),
});

/**
 * What an account did, named by the request that did it. Successful requests to these routes
 * are the account's usage; since 11 Oct 2026 their request lines also carry a `usage` object
 * with the sizes and counts below (never names or item ids).
 */
export const USAGE_ACTIONS = {
  'POST /v1/uploads/:id/complete': 'UPLOADED',
  'POST /v1/backups/:id/runs/:runId/files/batch': 'UPLOADED',
  'POST /v1/uploads/batch/finish': 'UPLOADED',
  'POST /v1/downloads': 'DOWNLOADED',
  'POST /v1/folder-downloads': 'FOLDER_ZIPPED',
  'POST /v1/drive/folders': 'FOLDER_CREATED',
  'PATCH /v1/drive/items/:id': 'RENAMED',
  'POST /v1/drive/items/:id/move': 'MOVED',
  'DELETE /v1/drive/items/:id': 'TRASHED',
  'POST /v1/drive/items/:id/restore': 'UNTRASHED',
  'DELETE /v1/drive/items/:id/permanent': 'DELETED',
  'POST /v1/drive/trash/empty': 'TRASH_EMPTIED',
  'POST /v1/drive/items/:id/versions/:versionId/restore': 'VERSION_RESTORED',
  'POST /v1/transfers': 'TRANSFER_SENT',
  'POST /v1/transfers/:id/save': 'TRANSFER_SAVED',
  'POST /v1/shares': 'SHARED',
  'POST /v1/sync/shares': 'SYNC_SHARED',
  'PUT /v1/sync/folders': 'SYNC_FOLDERS_CHANGED',
  'DELETE /v1/sync/folders/:id': 'SYNC_FOLDER_REMOVED',
  'POST /v1/backups': 'BACKUP_ADDED',
  'POST /v1/backups/:id/runs': 'BACKUP_STARTED',
  'POST /v1/backups/:id/runs/:runId/complete': 'BACKUP_FINISHED',
  'DELETE /v1/backups/:id': 'BACKUP_DISCONNECTED',
  'POST /v1/backups/:id/archive': 'BACKUP_ARCHIVED',
  'POST /v1/backups/:id/unarchive': 'BACKUP_RESUMED',
  'POST /v1/backups/:id/restores': 'BACKUP_RESTORED',
} as const;
export type UsageAction = (typeof USAGE_ACTIONS)[keyof typeof USAGE_ACTIONS];
/** The usage action of a request, e.g. "POST /v1/downloads" → DOWNLOADED. */
export const usageAction = (method: string, route: string): UsageAction | null =>
  (USAGE_ACTIONS as Record<string, UsageAction>)[`${method} ${route}`] ?? null;
export const usageGroups = ['all', 'transfers', 'files', 'sync', 'sharing'] as const;
export type UsageGroup = (typeof usageGroups)[number];
export const USAGE_GROUP_ACTIONS: Record<Exclude<UsageGroup, 'all'>, readonly UsageAction[]> = {
  transfers: ['UPLOADED', 'DOWNLOADED', 'FOLDER_ZIPPED'],
  files: [
    'FOLDER_CREATED',
    'RENAMED',
    'MOVED',
    'TRASHED',
    'UNTRASHED',
    'DELETED',
    'TRASH_EMPTIED',
    'VERSION_RESTORED',
  ],
  sync: [
    'SYNC_FOLDERS_CHANGED',
    'SYNC_FOLDER_REMOVED',
    'BACKUP_ADDED',
    'BACKUP_STARTED',
    'BACKUP_FINISHED',
    'BACKUP_DISCONNECTED',
    'BACKUP_ARCHIVED',
    'BACKUP_RESUMED',
    'BACKUP_RESTORED',
  ],
  sharing: ['TRANSFER_SENT', 'TRANSFER_SAVED', 'SHARED', 'SYNC_SHARED'],
};
/** The sizes and counts a usage request line carries in its `usage` object. */
export const usageDetailsSchema = z.object({
  sizeBytes: z.number().nullable(),
  /** A file's type, e.g. "image/jpeg". */
  mimeType: z.string().nullable(),
  /** FILE or FOLDER, for trash and delete. */
  itemType: z.string().nullable(),
  /** An upload into a backup folder. */
  backup: z.boolean().nullable(),
  /** What a download fetched: FILE, VERSION, TRANSFER or ZIP. */
  source: z.string().nullable(),
  files: z.number().nullable(),
  /** Sync folders this device started or stopped syncing. */
  added: z.number().nullable(),
  removed: z.number().nullable(),
  /** AUTOMATIC or MANUAL backup runs. */
  trigger: z.string().nullable(),
  /** How a backup run ended. */
  state: z.string().nullable(),
  permission: z.string().nullable(),
});
export type UsageDetails = z.infer<typeof usageDetailsSchema>;
export const USAGE_DETAIL_FIELDS = Object.keys(usageDetailsSchema.shape) as (keyof UsageDetails)[];
export const adminUsageQuery = z.object({ range: z.enum(adminActivityRanges).default('7d') });
export const adminUsageEventsQuery = z.object({
  range: z.enum(adminActivityRanges).default('7d'),
  group: z.enum(usageGroups).default('all'),
  cursor: z.string().max(4096).optional(),
});
const usageCount = { count: z.number(), bytes: z.number() };
/** An account's usage over a range, totalled, by hour and by device. */
export const adminUsageSchema = z.object({
  range: z.enum(adminActivityRanges),
  since: z.string(),
  totals: z.array(z.object({ action: z.string(), ...usageCount })),
  /** Each hour with any usage (UTC hour start), by action. */
  hours: z.array(z.object({ at: z.string(), action: z.string(), ...usageCount })),
  devices: z.array(
    z.object({
      deviceId: z.string().nullable(),
      platform: z.string().nullable(),
      uploads: z.object(usageCount),
      downloads: z.object(usageCount),
      other: z.number(),
      lastAt: z.string(),
    }),
  ),
  /** Backups the account set up, ever, from the database rather than the log. */
  backups: z.array(
    z.object({
      id: z.string(),
      deviceName: z.string().nullable(),
      state: z.string(),
      createdAt: z.string(),
    }),
  ),
});
export const adminUsageEventSchema = z.object({
  at: z.string(),
  requestId: z.string(),
  action: z.string(),
  automated: z.boolean(),
  deviceId: z.string().nullable(),
  platform: z.string().nullable(),
  appVersion: z.string().nullable(),
  details: usageDetailsSchema,
});
export const adminUsageEventsSchema = z.object({
  events: z.array(adminUsageEventSchema),
  nextCursor: z.string().nullable(),
});
export type AdminUsage = z.infer<typeof adminUsageSchema>;
export type AdminUsageEvent = z.infer<typeof adminUsageEventSchema>;
export type AdminUsageEvents = z.infer<typeof adminUsageEventsSchema>;

const reason = z.string().trim().min(3).max(500);
/**
 * A tracking id and where its links were shared. Sign-ups through an id staff haven't named
 * yet are listed too, with a null `source`, so they can be named afterwards.
 */
export const adminTrackerSchema = z.object({
  id: z.string(),
  source: z.string().nullable(),
  notes: z.string(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  updatedBy: z.string().nullable(),
  /** Emails that asked for a beta sign-up link through it. */
  requests: z.number(),
  /** Emails that created a sign-in account through it. */
  signups: z.number(),
  /** Accounts that verified their email and signed in, so exist in full. */
  accounts: z.number(),
  /** The latest of those, or null when nobody has used it yet. */
  lastAt: z.string().nullable(),
});
/** `signupUrl` is the web app's sign-up page; a tracking link adds `?ref=<id>` to it. */
export const adminTrackerListSchema = z.object({
  items: z.array(adminTrackerSchema),
  signupUrl: z.string(),
});
export const adminTrackerDetailSchema = z.object({
  tracker: adminTrackerSchema,
  signupUrl: z.string(),
  /** Everyone who came through it, newest first. */
  people: z.array(
    z.object({
      email: z.string(),
      userId: z.string().nullable(),
      at: z.string(),
      requestedAt: z.string().nullable(),
      signedUpAt: z.string().nullable(),
      joinedAt: z.string().nullable(),
    }),
  ),
});
export const adminTrackerBody = z
  .object({
    source: z.string().trim().min(1).max(120),
    notes: z.string().trim().max(1000).default(''),
    /** The `updatedAt` the editor loaded (null for a new one); refused if it changed since. */
    expectedUpdatedAt: z.string().nullable(),
  })
  .strict();
export const adminTrackerId = trackingId;
export const adminReasonBody = z.object({ reason }).strict();
// 1 PB is far above any plan; it only stops a typo adding three zeros too many.
export const MAX_ADMIN_QUOTA = 1_000_000_000_000_000;
export const adminQuotaBody = z
  .object({ quotaBytes: z.number().int().min(0).max(MAX_ADMIN_QUOTA), reason })
  .strict();
/** Beta sign-up: seats taken and allowed, unused sign-up links, and people waiting. */
export const adminBetaSchema = z.object({
  inviteRequired: z.boolean(),
  used: z.number(),
  cap: z.number(),
  invited: z.number(),
  waitlisted: z.number(),
  /** Accounts made with a test link, which take no seat. */
  testAccounts: z.number(),
});
/** A single-use test sign-up link: any email, no beta seat. */
export const adminTestInviteSchema = z.object({ url: z.string() });
// Far above any planned wave; it only stops a typo.
export const MAX_BETA_CAP = 100_000;
export const adminWaveBody = z
  .object({ cap: z.number().int().min(1).max(MAX_BETA_CAP), reason })
  .strict();
/** A feature flag's rule as staff see it, with the allowlisted accounts' emails. */
export const adminFlagSchema = flagRuleSchema.extend({
  key: z.string(),
  description: z.string(),
  users: z.array(z.object({ id: z.string(), email: z.string().nullable() })),
  updatedAt: z.string().nullable(),
  updatedBy: z.string().nullable(),
});
export const adminFlagListSchema = z.object({
  items: z.array(adminFlagSchema),
  /** Active accounts, for estimating a rollout's reach; null when not yet counted. */
  accounts: z.number().nullable(),
});
export const adminFlagDetailSchema = adminFlagListSchema.pick({ accounts: true }).extend({
  flag: adminFlagSchema,
  history: z.array(auditEntrySchema),
});
export const adminFlagBody = flagRuleSchema
  .extend({
    reason,
    /** The `updatedAt` the editor loaded; the save is refused if someone changed it since. */
    expectedUpdatedAt: z.string().nullable(),
  })
  .strict();
export const adminFlagUserBody = z.object({ userId: z.string().min(1).max(128), reason }).strict();
export const adminPurgeResultSchema = z.object({ accounts: z.number(), usedBytes: z.number() });
export const adminNoteBody = z.object({ text: z.string().trim().min(1).max(2000) }).strict();
/** Why staff deleted an account; each sends the account holder its own email. */
export const staffDeletionReason = z.enum([
  'USER_REQUEST',
  'TERMS_VIOLATION',
  'ABUSE',
  'DUPLICATE',
  'OTHER',
]);
/** Suspending emails the account holder a short notice unless staff turn it off (abuse). */
export const adminSuspendBody = z.object({ reason, notify: z.boolean().default(true) }).strict();
export const adminDeleteBody = z
  .object({
    confirmEmail: z.string().max(254),
    reason,
    category: staffDeletionReason,
    notify: z.boolean().default(true),
  })
  .strict();

export type Staff = z.infer<typeof staffSchema>;
export type StaffDeletionReason = z.infer<typeof staffDeletionReason>;
export type StaffRole = z.infer<typeof staffRole>;
export type StaffLoginResult = z.infer<typeof staffLoginResultSchema>;
export type AccountStatus = z.infer<typeof accountStatus>;
export type DirectoryUser = z.infer<typeof directoryUserSchema>;
export type AdminProfile = z.infer<typeof adminProfileSchema>;
export type AuditEntry = z.infer<typeof auditEntrySchema>;
export type AdminUserDetail = z.infer<typeof adminUserDetailSchema>;
export type AdminUserEmail = z.infer<typeof adminUserEmailSchema>;
export type AdminUserPage = z.infer<typeof adminUserPageSchema>;
export type AdminUserSort = z.infer<typeof adminUserSortSchema>;
export type AdminUserFilters = z.infer<typeof adminUserFiltersSchema>;
export type AdminUserListItem = z.infer<typeof adminUserListItemSchema>;
export type AuditPage = z.infer<typeof auditPageSchema>;
export type AdminOverview = z.infer<typeof adminOverviewSchema>;
export type PlatformCosts = z.infer<typeof platformCostsSchema>;
export type AdminBeta = z.infer<typeof adminBetaSchema>;
export type AdminTestInvite = z.infer<typeof adminTestInviteSchema>;
export type AdminPurgeResult = z.infer<typeof adminPurgeResultSchema>;
export type AdminFlag = z.infer<typeof adminFlagSchema>;
export type AdminFlagList = z.infer<typeof adminFlagListSchema>;
export type AdminFlagDetail = z.infer<typeof adminFlagDetailSchema>;
export type AdminFlagBody = z.infer<typeof adminFlagBody>;
export type AdminTracker = z.infer<typeof adminTrackerSchema>;
export type AdminTrackerList = z.infer<typeof adminTrackerListSchema>;
export type AdminTrackerDetail = z.infer<typeof adminTrackerDetailSchema>;
export type AdminTrackerBody = z.input<typeof adminTrackerBody>;
export type StorageTotals = z.infer<typeof storageTotalsSchema>;
export type AdminActivity = z.infer<typeof adminActivitySchema>;
export type AdminActivityRange = (typeof adminActivityRanges)[number];
export type AdminRequestLog = z.infer<typeof adminRequestLogSchema>;
export type AdminActivityRequest = z.infer<typeof adminActivityRequestSchema>;
