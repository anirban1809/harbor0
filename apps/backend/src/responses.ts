import { z } from 'zod';
import * as c from '@harbor/contracts';
import { backupRootSchema } from '../../../packages/contracts/src/backups';
const page = (item: z.ZodType) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() });
const identity = z.object({ username: z.string(), displayName: z.string() });
const tokens = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresIn: z.number(),
});
const publicUpload = z.object({
  id: z.string(),
  state: c.uploadState,
  multipart: z.boolean(),
  partSizeBytes: z.number(),
  expectedSizeBytes: z.number(),
  expiresAt: z.string(),
  failure: z.string().optional(),
  item: c.itemSchema.optional(),
});
const entry = c.manifestEntrySchema.omit({ storageObjectId: true });
const notification = z.object({
  id: z.string(),
  type: z.string(),
  data: z.record(z.string(), z.unknown()),
  readAt: z.string().nullable(),
  createdAt: z.string(),
});

const schemas: Record<string, z.ZodType> = {
  'post /v1/auth/signup': z.object({ verificationRequired: z.boolean() }),
  'post /v1/auth/confirm': z.object({ verified: z.boolean() }),
  'post /v1/auth/resend': z.object({ sent: z.boolean() }),
  'post /v1/auth/login': z.union([
    tokens.extend({ device: c.deviceSchema }),
    // The account has two-step verification: finish with /v1/auth/login/verify.
    z.object({ twoFactor: c.twoFactorChallengeSchema }),
  ]),
  'post /v1/auth/login/verify': tokens.extend({ device: c.deviceSchema }),
  'post /v1/auth/refresh': tokens,
  'post /v1/auth/logout': z.object({ loggedOut: z.boolean() }),
  'post /v1/auth/forgot': z.object({ sent: z.boolean() }),
  'post /v1/auth/reset': z.object({ reset: z.boolean() }),
  'get /v1/users/lookup': z.object({
    users: z.array(identity.extend({ id: z.string(), avatarUrl: z.string().nullable() })),
  }),
  'delete /v1/drive/items/:id/permanent': z.object({
    deleted: z.boolean(),
    jobId: z.string().optional(),
  }),
  'post /v1/uploads': z.object({ upload: publicUpload, storage: c.storageSchema }),
  'get /v1/uploads/:id': z.object({ upload: publicUpload, parts: z.array(c.completedPart) }),
  'post /v1/uploads/:id/parts': z.object({
    parts: z.array(
      z.object({ partNumber: z.number(), uploadUrl: z.string(), expiresAt: z.string() }),
    ),
  }),
  'delete /v1/uploads/:id': z.object({ upload: publicUpload }),
  'get /v1/transfers/received': page(
    c.transferSchema.extend({
      items: z.array(entry),
      nextEntryCursor: z.string().nullable(),
      sender: identity,
      recipient: identity.nullable(),
    }),
  ),
  'get /v1/transfers/sent': page(
    c.transferSchema.extend({
      items: z.array(entry),
      nextEntryCursor: z.string().nullable(),
      sender: identity,
      recipient: identity.nullable(),
    }),
  ),
  'get /v1/transfers/:id/items': page(entry),
  'get /v1/shares/received': z.object({
    items: z.array(c.shareSchema.extend({ item: c.itemSchema })),
  }),
  'get /v1/shares/sent': z.object({ items: z.array(c.shareSchema.extend({ item: c.itemSchema })) }),
  'post /v1/sync/checkpoints': z.object({ cursor: z.number() }),
  'post /v1/sync/operations': z.object({
    results: z.array(
      z.object({
        operationId: z.string(),
        status: z.enum(['APPLIED', 'ALREADY_APPLIED', 'CONFLICT', 'REJECTED']),
        revision: z.number().optional(),
        serverItem: c.itemSchema.optional(),
        serverRevision: z.number().optional(),
        error: z.object({ code: z.string(), message: z.string() }).optional(),
      }),
    ),
  }),
  'get /v1/notifications': page(notification),
  'post /v1/notifications/:id/read': z.object({ notification }),
  'get /v1/backups': z.object({ items: z.array(backupRootSchema) }),
  'post /v1/backups': z.object({ root: backupRootSchema }),
  'get /v1/billing/plans': z.object({
    items: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        storageBytes: z.number(),
        priceMinorUnits: z.number(),
        currency: z.string(),
        billingPeriod: z.enum(['MONTH', 'YEAR']),
      }),
    ),
    checkoutAvailable: z.boolean(),
  }),
  'get /v1/billing/subscription': z.object({
    planId: z.string(),
    entitlement: z.object({
      userId: z.string(),
      baseFreeBytes: z.number(),
      paidBytes: z.number(),
      totalQuotaBytes: z.number(),
    }),
  }),
  'get /ready': z.object({ status: z.string() }),
};
export function responseSchema(method: string, path: string, fallback: z.ZodType) {
  return schemas[`${method.toLowerCase()} ${path}`] ?? fallback;
}
export function queryParameters(path: string) {
  const query: Record<string, z.ZodType> = {};
  if (
    path.endsWith('/children') ||
    path.startsWith('/v1/backups/:id/') ||
    path === '/v1/search' ||
    path === '/v1/notifications' ||
    path === '/v1/storage/audit' ||
    (path.startsWith('/v1/transfers/') && !path.endsWith('/save'))
  ) {
    query.cursor = z.string();
    query.limit = z.number().int().min(1).max(500);
  }
  if (path === '/v1/search')
    for (const name of [
      'q',
      'type',
      'mimeType',
      'extension',
      'parentId',
      'createdAfter',
      'createdBefore',
      'updatedAfter',
      'updatedBefore',
      'favorite',
      'trash',
      'recent',
    ])
      query[name] = z.string();
  if (path === '/v1/users/lookup') query.q = z.string().min(3).max(32);
  if (path === '/v1/drive/usage') query.ids = z.string();
  if (path === '/v1/sync/changes') {
    query.cursor = z.number().int().min(0);
    query.limit = z.number().int().min(1).max(500);
  }
  if (path === '/v1/transfers/received') query.state = c.transferState;
  // The signed token from an unsubscribe link.
  if (path.startsWith('/v1/email/')) query.t = z.string();
  return Object.entries(query).map(([name, schema]) => ({
    name,
    in: 'query',
    required: false,
    schema: z.toJSONSchema(schema),
  }));
}
