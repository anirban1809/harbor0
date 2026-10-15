import { z } from 'zod';

/**
 * Public links let anyone with the link view and download a file, or a folder's files, without
 * an account. Pages for them are served from their own domain (harbor0content.online), so if a
 * shared file gets that domain flagged, harbor0.com and the app are unaffected.
 */

/** Accounts younger than this can't link to executables and installers. */
export const PUBLIC_LINK_EXECUTABLE_MIN_AGE_DAYS = 30;
/** Links that still work, per account. */
export const PUBLIC_LINK_LIMIT = { free: 20, paid: 500 } as const;
/** Free accounts' links all expire; paid accounts may also choose a link that never expires. */
export const publicLinkExpiry = z.union([z.literal(1), z.literal(7), z.literal(30)]);
export const PUBLIC_LINK_DEFAULT_EXPIRY_DAYS = 7;
/** Requests a minute to one link, from everyone, and from one visitor across all links. */
export const PUBLIC_LINK_RATE = { link: 120, visitor: 60 } as const;
/** Wrong passwords a link accepts an hour before it asks the visitor to wait. */
export const PUBLIC_LINK_PASSWORD_ATTEMPTS = 10;

/**
 * Files people use to spread malware: programs, installers, scripts and disk images. Young
 * accounts can't link to them, and the public page warns before anyone downloads one.
 */
export const EXECUTABLE_EXTENSIONS = [
  'exe',
  'msi',
  'msix',
  'appx',
  'scr',
  'com',
  'bat',
  'cmd',
  'ps1',
  'vbs',
  'vbe',
  'js',
  'jse',
  'wsf',
  'hta',
  'cpl',
  'jar',
  'apk',
  'xapk',
  'aab',
  'ipa',
  'dmg',
  'pkg',
  'app',
  'deb',
  'rpm',
  'appimage',
  'sh',
  'run',
  'bin',
  'lnk',
  'iso',
  'img',
  'reg',
  'dll',
  'sys',
  'docm',
  'xlsm',
  'pptm',
] as const;
const executables = new Set<string>(EXECUTABLE_EXTENSIONS);
export const isExecutableName = (name: string) => {
  const dot = name.lastIndexOf('.');
  return dot > 0 && executables.has(name.slice(dot + 1).toLowerCase());
};

/** 16 random bytes, base64url: the whole secret of a link. */
export const publicLinkToken = z.string().regex(/^[A-Za-z0-9_-]{22}$/);

export const publicLinkSchema = z.object({
  id: z.string(),
  driveItemId: z.string(),
  itemType: z.enum(['FILE', 'FOLDER']),
  /** The item's name now; null once it is deleted, when the link stops working. */
  itemName: z.string().nullable(),
  /** The address to share. The owner can copy it again at any time. */
  url: z.string(),
  hasPassword: z.boolean(),
  createdAt: z.string(),
  /** Null when the link never expires. */
  expiresAt: z.string().nullable(),
  /** Set by staff when the link was taken down; the owner can't turn it back on. */
  disabledAt: z.string().nullable(),
});
export type PublicLink = z.infer<typeof publicLinkSchema>;

export const publicLinkInput = z
  .object({
    driveItemId: z.string().min(1).max(128),
    /** Days until the link stops working; null for no end (paid storage only). */
    expiresInDays: publicLinkExpiry.nullable().default(PUBLIC_LINK_DEFAULT_EXPIRY_DAYS),
    /** Visitors must enter this before they see what the link shares. */
    password: z.string().min(4).max(128).nullable().default(null),
  })
  .strict();

/** Changes to a link that works: a new end (counted from now) and/or password; null removes it. */
export const publicLinkUpdate = z
  .object({
    expiresInDays: publicLinkExpiry.nullable().optional(),
    password: z.string().min(4).max(128).nullable().optional(),
  })
  .strict();

/** What the owner may make right now, for the create dialog. */
export const publicLinkAllowanceSchema = z.object({
  /** Null when the account can make links; otherwise why not, ready to show. */
  blockedReason: z.string().nullable(),
  /** Whether links that never expire are offered. */
  neverExpires: z.boolean(),
  active: z.number().int(),
  limit: z.number().int(),
});

/** A file or folder as a visitor sees it: no ids of the owner's account, no hashes. */
export const publicItemSchema = z.object({
  id: z.string(),
  type: z.enum(['FILE', 'FOLDER']),
  name: z.string(),
  mimeType: z.string().nullable(),
  sizeBytes: z.number(),
  updatedAt: z.string(),
  /** A program or installer: the page warns before downloading it. */
  executable: z.boolean(),
});
export type PublicItem = z.infer<typeof publicItemSchema>;

export const publicLinkViewSchema = z.object({
  /** Who shared it, as their account shows it, and since when they've had the account. */
  sharedBy: z.object({ displayName: z.string(), memberSince: z.string() }),
  expiresAt: z.string().nullable(),
  /** The visitor must send the password first; `item` is withheld until then. */
  passwordRequired: z.boolean(),
  item: publicItemSchema.nullable(),
});
export type PublicLinkView = z.infer<typeof publicLinkViewSchema>;

export const publicFolderPageSchema = z.object({
  /** The folder listed, and its folders down from the linked one, for a breadcrumb. */
  path: z.array(z.object({ id: z.string(), name: z.string() })),
  items: z.array(publicItemSchema),
  nextCursor: z.string().nullable(),
});
export type PublicFolderPage = z.infer<typeof publicFolderPageSchema>;

/** Header a visitor sends with the pass a correct password returns. */
export const PUBLIC_LINK_PASS_HEADER = 'X-Harbor-Link-Pass';
