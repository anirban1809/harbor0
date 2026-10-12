import { z } from 'zod';

/**
 * End-to-end encryption is per account and permanent: once on, every file and file name the
 * account stores is encrypted by its devices before upload. The server only ever holds the
 * account's master key wrapped by secrets it never sees (the passphrase, the recovery key and
 * each unlocked device's own secret), so it cannot read files, names or the key.
 */

/** Encrypted names are `h0e1.` and base64url; see `packages/api-client/src/e2ee.ts`. */
export const ENCRYPTED_NAME_PREFIX = 'h0e1.';
/** Longest encrypted name the server keeps; plaintext names stay within `filename`'s 240. */
export const ENCRYPTED_NAME_MAX = 400;
const encryptedNamePattern = /^h0e1\.[A-Za-z0-9_-]{38,395}$/;
export const isEncryptedName = (name: string) => encryptedNamePattern.test(name);

/**
 * Apps that encrypt. An encrypted account refuses every other app, so an older build can never
 * upload a file unencrypted or write ciphertext to a device as if it were the file. A platform
 * is listed with the oldest build that encrypts; the web app is always current.
 */
export const E2EE_CLIENTS: Partial<Record<string, string>> = { WEB: '0' };

const b64 = z
  .string()
  .min(1)
  .max(2048)
  .regex(/^[A-Za-z0-9_-]+$/);
/** The master key wrapped by a key derived from the passphrase with Argon2id. */
export const passphraseEnvelopeSchema = z
  .object({
    v: z.literal(1),
    kdf: z.literal('argon2id'),
    salt: b64,
    memoryKiB: z.number().int().min(19_456).max(1_048_576),
    iterations: z.number().int().min(2).max(20),
    parallelism: z.number().int().min(1).max(8),
    iv: b64,
    ciphertext: b64,
  })
  .strict();
/** The master key wrapped by a key derived from the high-entropy recovery key with HKDF. */
export const recoveryEnvelopeSchema = z
  .object({ v: z.literal(1), kdf: z.literal('hkdf'), salt: b64, iv: b64, ciphertext: b64 })
  .strict();
export type PassphraseEnvelope = z.infer<typeof passphraseEnvelopeSchema>;
export type RecoveryEnvelope = z.infer<typeof recoveryEnvelopeSchema>;
/**
 * Shows the caller holds the master key: a value derived from it. The server keeps only its
 * SHA-256, so it can check a later change to the account's keys came from an unlocked device.
 */
export const keyProof = b64;

/** A device that keeps its own wrapped copy of the key, so it unlocks without the passphrase. */
export const e2eeDeviceSchema = z.object({
  id: z.string(),
  /** The sign-in session that unlocked it, to name it from the device list. */
  deviceId: z.string().nullable(),
  name: z.string(),
  platform: z.string(),
  /** False for a browser unlocked for one session; it locks when the tab closes. */
  remember: z.boolean(),
  createdAt: z.string(),
  lastUsedAt: z.string(),
});
export type E2eeDevice = z.infer<typeof e2eeDeviceSchema>;

/** Progress of re-encrypting files stored before encryption was turned on. */
export const e2eeMigrationSchema = z.object({
  totalFiles: z.number().int().min(0),
  doneFiles: z.number().int().min(0),
  totalBytes: z.number().int().min(0),
  doneBytes: z.number().int().min(0),
  /** Files the browser cannot re-encrypt, such as backups owned by the desktop app. */
  skippedFiles: z.number().int().min(0),
  complete: z.boolean(),
  /** The device running it and when it last reported. */
  deviceName: z.string().nullable(),
  updatedAt: z.string().nullable(),
});
export type E2eeMigration = z.infer<typeof e2eeMigrationSchema>;

export const e2eeStateSchema = z.object({
  enabled: z.boolean(),
  enabledAt: z.string().nullable(),
  passphrase: passphraseEnvelopeSchema.nullable(),
  recovery: recoveryEnvelopeSchema.nullable(),
  recoveryCreatedAt: z.string().nullable(),
  passphraseChangedAt: z.string().nullable(),
  devices: z.array(e2eeDeviceSchema),
  migration: e2eeMigrationSchema.nullable(),
});
export type E2eeState = z.infer<typeof e2eeStateSchema>;

export const e2eeEnrollInput = z
  .object({
    passphrase: passphraseEnvelopeSchema,
    recovery: recoveryEnvelopeSchema,
    proof: keyProof,
  })
  .strict();
export const e2eeDeviceInput = z
  .object({
    proof: keyProof,
    /** Half of the device's key; the other half never leaves the device. 32 bytes, base64url. */
    serverSecret: b64,
    remember: z.boolean(),
  })
  .strict();
export const e2eeMigrationInput = z
  .object({
    totalFiles: z.number().int().min(0),
    doneFiles: z.number().int().min(0),
    totalBytes: z.number().int().min(0),
    doneBytes: z.number().int().min(0),
    skippedFiles: z.number().int().min(0),
    complete: z.boolean(),
  })
  .strict();
