import { z } from 'zod';
import { deviceSchema, storageSchema } from './index';

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
  ],
} as const satisfies Record<z.infer<typeof staffRole>, readonly string[]>;
export type StaffPermission = (typeof staffPermissions)['ADMIN'][number];
export const can = (role: z.infer<typeof staffRole>, permission: StaffPermission) =>
  (staffPermissions[role] as readonly string[]).includes(permission);

// Sign-in is password, then a TOTP code. New staff set a password and enrol an authenticator.
export const staffLoginResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('SIGNED_IN'), staff: staffSchema }),
  z.object({
    status: z.literal('CHALLENGE'),
    challenge: z.enum(['NEW_PASSWORD', 'MFA_SETUP', 'MFA']),
    session: z.string(),
    /** Base32 secret to add to an authenticator app (MFA_SETUP only). */
    secret: z.string().optional(),
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
export const adminUserDetailSchema = z.object({
  account: directoryUserSchema,
  /** Null until the user verifies their email and first signs in. */
  profile: adminProfileSchema.nullable(),
  devices: z.array(deviceSchema),
  backupCount: z.number(),
  activity: z.array(auditEntrySchema),
});
export const adminUserPageSchema = z.object({
  items: z.array(
    directoryUserSchema.extend({
      quotaBytes: z.number().nullable(),
      usedBytes: z.number().nullable(),
      suspended: z.boolean(),
      deleted: z.boolean(),
    }),
  ),
  nextCursor: z.string().nullable(),
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
export const adminOverviewSchema = z.object({
  estimatedUsers: z.number().nullable(),
  storage: storageTotalsSchema.nullable(),
  recent: z.array(auditEntrySchema),
});

const reason = z.string().trim().min(3).max(500);
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
});
// Far above any planned wave; it only stops a typo.
export const MAX_BETA_CAP = 100_000;
export const adminWaveBody = z
  .object({ cap: z.number().int().min(1).max(MAX_BETA_CAP), reason })
  .strict();
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
export type AdminUserPage = z.infer<typeof adminUserPageSchema>;
export type AuditPage = z.infer<typeof auditPageSchema>;
export type AdminOverview = z.infer<typeof adminOverviewSchema>;
export type AdminBeta = z.infer<typeof adminBetaSchema>;
export type AdminPurgeResult = z.infer<typeof adminPurgeResultSchema>;
export type StorageTotals = z.infer<typeof storageTotalsSchema>;
