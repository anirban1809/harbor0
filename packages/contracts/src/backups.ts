import { z } from 'zod';
export const backupRootSchema = z.object({
  id: z.string(),
  userId: z.string(),
  deviceId: z.string(),
  deviceName: z.string().optional(),
  localPathDisplayName: z.string(),
  remoteRootDriveItemId: z.string(),
  state: z.enum(['ACTIVE', 'PAUSED', 'ERROR', 'ARCHIVED', 'REMOVED']),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const backupRunSchema = z.object({
  id: z.string(),
  rootId: z.string(),
  deviceId: z.string(),
  trigger: z.enum(['AUTOMATIC', 'MANUAL']),
  state: z.enum(['RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED']),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
  fileCount: z.number(),
  sizeBytes: z.number(),
  error: z.string().optional(),
});
export const backupEntrySchema = z.object({
  relativePath: z.string().min(1).max(4096),
  itemId: z.string(),
  versionId: z.string(),
  sizeBytes: z.number().nonnegative(),
  modifiedAt: z.string(),
  savedAt: z.string(),
});
export const backupRestoreSchema = z.object({
  id: z.string(),
  rootId: z.string(),
  itemId: z.string(),
  versionId: z.string(),
  relativePath: z.string(),
  state: z.enum(['PENDING', 'COMPLETED', 'FAILED']),
  requestedAt: z.string(),
  completedAt: z.string().nullable(),
  error: z.string().optional(),
});
export type BackupRoot = z.infer<typeof backupRootSchema>;
export type BackupRun = z.infer<typeof backupRunSchema>;
export type BackupEntry = z.infer<typeof backupEntrySchema>;
export type BackupRestore = z.infer<typeof backupRestoreSchema>;
