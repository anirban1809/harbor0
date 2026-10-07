import { z } from 'zod';
/** Storage on the free plan for accounts created after the beta. */
export const FREE_QUOTA = 25_000_000_000;
/** Storage for accounts created during the beta; they keep it after launch. */
export const BETA_QUOTA = 50_000_000_000;
/** Whether new accounts join the beta. Set to false at launch. */
export const BETA = true;
/** Free storage a new account gets. */
export const SIGNUP_QUOTA = BETA ? BETA_QUOTA : FREE_QUOTA;
/** Sign-ups the beta takes before staff open the next wave from the management console. */
export const BETA_FIRST_WAVE = 50;
export const PART_SIZE = 64 * 1024 * 1024;
export const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/);
export const operationId = z.string().uuid();
export const filename = z
  .string()
  .min(1)
  .max(240)
  .refine(
    (v) => !/[\\/\u0000-\u001f\u007f]/.test(v) && !['.', '..'].includes(v) && v.trim().length > 0,
    'Use a filename without path separators or control characters.',
  );
export const username = z
  .string()
  .transform((v) => v.toLowerCase())
  .pipe(
    z
      .string()
      .min(3)
      .max(32)
      .regex(/^[a-z0-9_][a-z0-9_.]*[a-z0-9_]$/)
      .refine(
        (v) =>
          !v.includes('..') &&
          ![
            'admin',
            'administrator',
            'support',
            'system',
            'harbor',
            'security',
            'help',
            'root',
          ].includes(v),
        'Choose a different username.',
      ),
  );
export const platform = z.enum(['WEB', 'MACOS', 'WINDOWS', 'LINUX', 'IOS', 'ANDROID']);
export const transferState = z.enum([
  'PENDING_RECIPIENT_SIGNUP',
  'PENDING',
  'ACCEPTED',
  'DECLINED',
  'CANCELLED',
  'EXPIRED',
]);
export const uploadState = z.enum([
  'CREATED',
  'UPLOADING',
  'COMPLETING',
  'COMPLETED',
  'FAILED',
  'ABORTED',
  'EXPIRED',
]);
export const recipient = z
  .object({ type: z.enum(['USERNAME', 'EMAIL']), value: z.string().min(3).max(254) })
  .strict();
export const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const themePreset = z.enum(['default', 'ocean', 'forest', 'violet', 'sunset']);
const appearanceColor = z.string().regex(/^#[a-fA-F0-9]{6}$/);
const appearancePalette = z
  .object({
    primary: appearanceColor.optional(),
    background: appearanceColor.optional(),
    card: appearanceColor.optional(),
    sidebar: appearanceColor.optional(),
    border: appearanceColor.optional(),
  })
  .strict();
export const appearanceSchema = z
  .object({
    preference: z.enum(['light', 'dark', 'system']),
    preset: themePreset,
    palettes: z.object({ light: appearancePalette, dark: appearancePalette }).strict(),
  })
  .strict();
export type AppearancePreference = z.infer<typeof appearanceSchema>;
/**
 * Which optional emails an account gets. Service notices (security, terms, pricing) are always
 * sent. A missing field means the default: on.
 */
export const emailPreferencesSchema = z.object({ productUpdates: z.boolean() }).strict();
export type EmailPreferences = z.infer<typeof emailPreferencesSchema>;
/** What an unsubscribe link changed, for the page it opens. */
export const emailSubscriptionSchema = z.object({
  /** The address with its local part masked, e.g. "a•••@example.com". */
  email: z.string(),
  productUpdates: z.boolean(),
});
export type EmailSubscription = z.infer<typeof emailSubscriptionSchema>;
export type ThemePreset = z.infer<typeof themePreset>;
export const userSchema = z.object({
  id: z.string(),
  email: z.string(),
  emailVerified: z.boolean(),
  username: z.string(),
  displayName: z.string(),
  avatarUrl: z.string().nullable(),
  appearance: appearanceSchema.optional(),
  emailPreferences: emailPreferencesSchema.optional(),
  storageQuotaBytes: z.number(),
  storageUsedBytes: z.number(),
  storageReservedBytes: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const syncCloudState = z.enum(['AVAILABLE', 'RELEASED', 'REQUESTED']);
export const syncItemStatusSchema = z.object({
  itemId: id,
  revision: z.number().int().positive().optional(),
  deviceConfirmed: z.boolean().optional(),
  state: z.enum(['PENDING', 'SYNCING', 'SYNCED', 'UNKNOWN']),
  requiredDevices: z.number().int().min(0),
  confirmedDevices: z.number().int().min(0),
  cloudState: syncCloudState,
  pendingItems: z.number().int().min(0),
});
export type SyncItemStatus = z.infer<typeof syncItemStatusSchema>;
/** Storage a folder's files use, every stored version included; a lower bound if incomplete. */
export const folderUsageSchema = z.object({
  itemId: id,
  bytes: z.number().int().min(0),
  files: z.number().int().min(0),
  complete: z.boolean(),
});
export type FolderUsage = z.infer<typeof folderUsageSchema>;
export const itemSchema = z.object({
  backupRootId: z.string().optional(),
  /** The caller's access to someone else's item, through a share; absent on their own items. */
  access: z.enum(['EDITOR', 'VIEWER']).optional(),
  syncRemovedAt: z.string().nullable().optional(),
  cloudState: syncCloudState.optional(),
  id: z.string(),
  ownerUserId: z.string(),
  parentId: z.string().nullable(),
  type: z.enum(['FILE', 'FOLDER']),
  name: z.string(),
  normalizedName: z.string(),
  mimeType: z.string().nullable(),
  sizeBytes: z.number(),
  currentVersionId: z.string().nullable(),
  revision: z.number(),
  favorite: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable(),
});
export const syncFolderSchema = itemSchema.extend({
  syncDevices: z.array(z.object({ id: z.string(), name: z.string() })),
});
export type SyncFolderItem = z.infer<typeof syncFolderSchema>;
export const versionSchema = z.object({
  cloudState: z.enum(['AVAILABLE', 'RELEASED']).optional(),
  id: z.string(),
  driveItemId: z.string(),
  storageObjectId: z.string(),
  versionNumber: z.number(),
  sizeBytes: z.number(),
  contentHash: hash,
  contentHashAlgorithm: z.literal('SHA256'),
  sourceDeviceId: z.string().nullable(),
  createdAt: z.string(),
});
export const deviceSchema = z.object({
  id: z.string(),
  userId: z.string(),
  name: z.string(),
  platform,
  appVersion: z.string().nullable(),
  devicePublicId: z.string().nullable(),
  // SHA-256 (base64url) of the installation's public key, once it has proven possession.
  keyFingerprint: z.string().nullable().default(null),
  lastSeenAt: z.string().nullable(),
  createdAt: z.string(),
  revokedAt: z.string().nullable(),
  // Signed out pauses sync and backups until the next sign-in; revoked removes the device.
  status: z.enum(['ACTIVE', 'SIGNED_OUT', 'REVOKED']).optional(),
});
// Installations hold an ECDSA P-256 key (Secure Enclave / Android Keystore / OS keychain)
// and sign a single-use, session-bound challenge to claim their devicePublicId.
export const deviceProofSchema = z
  .object({
    // SPKI DER, base64url.
    publicKey: z.string().min(1).max(512),
    challenge: z.string().min(1).max(128),
    // ECDSA signature over deviceProofMessage(), base64url: ASN.1 DER, or raw r‖s from browsers.
    signature: z.string().min(1).max(256),
  })
  .strict();
export type DeviceProof = z.infer<typeof deviceProofSchema>;
export const deviceProofMessage = (challenge: string, userId: string, devicePublicId: string) =>
  ['harbor0-device-v1', challenge, userId, devicePublicId].join('\n');
export const manifestEntrySchema = z.object({
  id: z.string(),
  sourceDriveItemId: z.string(),
  sourceVersionId: z.string().nullable(),
  displayName: z.string(),
  relativePath: z.string(),
  parentEntryId: z.string().nullable(),
  itemType: z.enum(['FILE', 'FOLDER']),
  sizeBytes: z.number(),
  mimeType: z.string().nullable(),
  contentHash: z.string().nullable(),
  storageObjectId: z.string().nullable(),
});
export const transferSchema = z.object({
  id: z.string(),
  senderUserId: z.string(),
  recipientUserId: z.string().nullable(),
  recipientEmail: z.string().nullable(),
  state: transferState,
  createdAt: z.string(),
  acceptedAt: z.string().nullable(),
  declinedAt: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  totalSizeBytes: z.number(),
  savedAt: z.string().nullable(),
  displayNames: z.array(z.string()).optional(),
  preparationState: z.enum(['BUILDING', 'READY', 'FAILED']).optional(),
  saveState: z.enum(['SAVING', 'SAVED', 'FAILED']).optional(),
  failure: z.string().optional(),
});
export const storageSchema = z.object({
  quotaBytes: z.number(),
  usedBytes: z.number(),
  reservedBytes: z.number(),
  availableBytes: z.number(),
});
// One stored file version, the unit storage is charged in. `countedBytes` is what the version
// adds to `usedBytes` (0 for legacy content held only on synced devices).
export const storageAuditRowSchema = z.object({
  itemId: z.string(),
  versionId: z.string(),
  path: z.string(),
  location: z.enum(['MY_DRIVE', 'BACKUP', 'SYNC', 'TRASH', 'DELETING']),
  locationDetail: z.string().nullable(),
  state: z.enum(['CURRENT', 'PREVIOUS_VERSION', 'RETAINED_FOR_TRANSFER', 'ON_DEVICES_ONLY']),
  versionNumber: z.number(),
  sizeBytes: z.number(),
  countedBytes: z.number(),
  contentHash: z.string(),
  uploadedAt: z.string(),
  uploadedFrom: z.string().nullable(),
});
export type StorageAuditRow = z.infer<typeof storageAuditRowSchema>;
export const storageAuditPageSchema = z.object({
  rows: z.array(storageAuditRowSchema),
  storage: storageSchema,
  nextCursor: z.string().nullable(),
});
export const changeSchema = z.object({
  sequence: z.number(),
  type: z.string(),
  entityId: z.string(),
  revision: z.number().nullable(),
  occurredAt: z.string(),
  item: itemSchema.optional(),
});
export const shareSchema = z.object({
  syncState: z.enum(['PENDING', 'ACCEPTED', 'DECLINED']).optional(),
  id: z.string(),
  driveItemId: z.string(),
  ownerUserId: z.string(),
  recipientUserId: z.string(),
  permission: z.enum(['VIEWER', 'EDITOR']),
  createdAt: z.string(),
  revokedAt: z.string().nullable(),
});
export const errorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string(),
    details: z.unknown().optional(),
  }),
});
export const mutation = z.object({ operationId, baseRevision: z.number().int().positive() });
export const uploadInput = z
  .object({
    operationId,
    parentId: id.nullable().default(null),
    name: filename,
    sizeBytes: z.number().int().min(0).max(5_000_000_000_000),
    mimeType: z.string().max(255).default('application/octet-stream'),
    deviceId: id.nullable().optional(),
    contentHash: hash.nullable().optional(),
    driveItemId: id.optional(),
    baseRevision: z.number().int().positive().optional(),
  })
  .strict();
export const completedPart = z
  .object({ partNumber: z.number().int().min(1).max(10000), etag: z.string().min(1).max(256) })
  .strict();
export type User = z.infer<typeof userSchema>;
export type DriveItem = z.infer<typeof itemSchema>;
export type FileVersion = z.infer<typeof versionSchema>;
export type Device = z.infer<typeof deviceSchema>;
export type Transfer = z.infer<typeof transferSchema>;
export type ManifestEntry = z.infer<typeof manifestEntrySchema>;
export type ShareGrant = z.infer<typeof shareSchema>;
export type StorageUsage = z.infer<typeof storageSchema>;
export type SyncChange = z.infer<typeof changeSchema>;
export type UploadInput = z.infer<typeof uploadInput>;
export type CompletedPart = z.infer<typeof completedPart>;
export type Identity = {
  id: string;
  email: string;
  emailVerified: boolean;
  username: string;
  displayName: string;
  deviceId?: string;
  sessionId?: string;
};
export const normalizeName = (v: string) => v.normalize('NFC').toLowerCase();
export const normalizeEmail = (v: string) => v.trim().toLowerCase();
const GMAIL = new Set(['gmail.com', 'googlemail.com']);
/**
 * The inbox an address delivers to, so one inbox gets one account: `+tags` are dropped, and
 * for Gmail so are dots (Gmail ignores both) and googlemail.com is gmail.com.
 */
export function canonicalEmail(v: string) {
  const email = normalizeEmail(v);
  const at = email.lastIndexOf('@');
  if (at < 1) return email;
  let local = email.slice(0, at).split('+')[0];
  let domain = email.slice(at + 1);
  if (GMAIL.has(domain)) {
    local = local.replace(/\./g, '');
    domain = 'gmail.com';
  }
  return `${local || email.slice(0, at)}@${domain}`;
}
/** New accounts one browser may create in `SIGNUP_DEVICE_WINDOW_MS` before sign-up is refused. */
export const SIGNUP_DEVICE_LIMIT = 2;
export const SIGNUP_DEVICE_WINDOW_MS = 7 * 86400_000;
/**
 * Whether sign-up needs a link from the beta, and whether a request for one gets it at once
 * (`open`) or joins the waitlist until the next wave.
 */
export const betaStatusSchema = z.object({ inviteRequired: z.boolean(), open: z.boolean() });
export const accessRequestResultSchema = z.object({
  status: z.enum(['INVITED', 'WAITLISTED', 'REGISTERED']),
});
/** Second sign-in steps: a code from an authenticator app, or one emailed at sign-in. */
export const twoFactorMethod = z.enum(['TOTP', 'EMAIL']);
/** Which second step the account uses; turning one on turns the other off. */
export const twoFactorStatusSchema = z.object({ totp: z.boolean(), email: z.boolean() });
/** Sign-in needs a second step before tokens are issued. */
export const twoFactorChallengeSchema = z.object({
  /** Opaque; send it back with the code. It expires a few minutes after the password step. */
  session: z.string(),
  /** Every method the account can finish signing in with. */
  methods: z.array(twoFactorMethod),
  /** The method this session is waiting for, or null while the user still has to choose. */
  method: twoFactorMethod.nullable(),
  /** Masked address the email code went to (EMAIL only). */
  destination: z.string().optional(),
});
export const totpSetupSchema = z.object({
  /** Base32 secret for apps that cannot scan a QR code. */
  secret: z.string(),
  /** otpauth:// URI to show as a QR code. */
  uri: z.string(),
});
export type TwoFactorMethod = z.infer<typeof twoFactorMethod>;
export type TwoFactorStatus = z.infer<typeof twoFactorStatusSchema>;
export type TwoFactorChallenge = z.infer<typeof twoFactorChallengeSchema>;
export type TotpSetup = z.infer<typeof totpSetupSchema>;
export type BetaStatus = z.infer<typeof betaStatusSchema>;
export type AccessRequestResult = z.infer<typeof accessRequestResultSchema>;
export const storageUsage = (u: User): StorageUsage => ({
  quotaBytes: u.storageQuotaBytes,
  usedBytes: u.storageUsedBytes,
  reservedBytes: u.storageReservedBytes,
  availableBytes: Math.max(0, u.storageQuotaBytes - u.storageUsedBytes - u.storageReservedBytes),
});

export const folderDownloadSchema = z.object({
  id: z.string(),
  name: z.string(),
  state: z.enum([
    'QUEUED',
    'LISTING',
    'BUILDING',
    'FINALIZING',
    'READY',
    'FAILED',
    'CANCELLED',
    'EXPIRED',
  ]),
  files: z.number(),
  bytes: z.number(),
  totalFiles: z.number(),
  totalBytes: z.number().nullable(),
  currentFile: z.string().nullable(),
  error: z.string().nullable(),
  expiresAt: z.string(),
  downloadUrl: z.string().optional(),
  sizeBytes: z.number().optional(),
  contentHash: z.string().optional(),
});
export type FolderDownload = z.infer<typeof folderDownloadSchema>;
export * from './flags';
