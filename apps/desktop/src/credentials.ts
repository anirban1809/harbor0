import { app, safeStorage } from 'electron';
import { chmod, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SESSION_DURATION_SECONDS } from '@harbor/api-client';
import type { SavedSession } from './session';

/** Whether secrets can be stored encrypted; harbor0 never stores them in plain text. */
export function keychainReady() {
  return (
    safeStorage.isEncryptionAvailable() &&
    !(process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')
  );
}
/** Why harbor0 can't sign in on this computer, or undefined when it can. */
export function keychainProblem() {
  if (keychainReady()) return undefined;
  return process.platform === 'linux'
    ? 'harbor0 couldn’t reach a keyring to store your sign-in securely. Install and unlock GNOME Keyring, KWallet or another Secret Service keyring, then restart harbor0. harbor0 will not store unencrypted credentials.'
    : 'Enable an OS keychain before signing in. harbor0 will not store unencrypted credentials.';
}
const keychainMissing = () => new Error(keychainProblem());

/** Writes a value encrypted with the OS keychain, readable only by this user. */
export async function writeSealed(file: string, value: unknown) {
  if (!keychainReady()) throw keychainMissing();
  await writeFile(file, safeStorage.encryptString(JSON.stringify(value)), { mode: 0o600 });
  await chmod(file, 0o600);
}
/** A value written by writeSealed, or undefined when there is none. */
export async function readSealed<T>(file: string): Promise<T | undefined> {
  if (!safeStorage.isEncryptionAvailable()) return undefined;
  let sealed: Buffer;
  try {
    sealed = await readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  return JSON.parse(safeStorage.decryptString(sealed)) as T;
}
export const removeSealed = (file: string) => rm(file, { force: true });

/** The signed-in session: only the refresh credential is persisted. */
export const sessionFile = () => path.join(app.getPath('userData'), 'credentials.bin');
export async function readSavedSession(): Promise<SavedSession | undefined> {
  const saved = await readSealed<{ refreshToken: string; expiresAt?: number }>(sessionFile());
  if (!saved) return undefined;
  // Older installations stored only the refresh token. Keep its provider
  // expiry and bound the migrated local session by the file's timestamp.
  const expiresAt =
    saved.expiresAt ?? (await stat(sessionFile())).mtimeMs + SESSION_DURATION_SECONDS * 1000;
  return { refreshToken: saved.refreshToken, expiresAt };
}
