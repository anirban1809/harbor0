import { randomBytes } from 'node:crypto';

/**
 * A WebDAV server on this computer for My Drive, so Finder, Explorer and WebDAV apps can open
 * harbor0 without syncing (see drive-dav.ts). The app serves it with its own session; `harbor0
 * webdav` serves it from a terminal with an access token of its own.
 */
export const WEBDAV_USERNAME = 'harbor0';
/** The feature flag that turns on access tokens and WebDAV for an account. */
export const WEBDAV_FLAG = 'rclone';
export const WEBDAV_UNAVAILABLE = "WebDAV isn't available for your harbor0 account yet.";
/** `harbor0 webdav` uses an access token, which can't read an encrypted account's files. */
export const WEBDAV_ENCRYPTED =
  'Your harbor0 files are end-to-end encrypted, so harbor0 webdav can’t read them. Turn on the local WebDAV server in the harbor0 app’s Settings instead: it decrypts your files on this computer.';
export const DEFAULT_WEBDAV_PORT = 6810;

/** What the server needs to reach My Drive, stored sealed by the OS keychain. */
export type WebdavKey = {
  apiUrl: string;
  userId: string;
  email: string;
  /** The access token's device, used to revoke it. */
  tokenId: string;
  token: string;
};
export type WebdavCommand = { help: true } | { help: false; port: number; readOnly: boolean };
/** Arguments of `harbor0 webdav`; throws with a message for the user on a bad one. */
export function parseWebdavArgs(args: string[]): WebdavCommand {
  let port = DEFAULT_WEBDAV_PORT;
  let readOnly = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--read-only') readOnly = true;
    else if (arg === '--port' || arg.startsWith('--port=')) {
      const value = arg === '--port' ? args[++index] : arg.slice('--port='.length);
      port = Number(value);
      if (!Number.isInteger(port) || port < 1024 || port > 65535)
        throw new Error(`--port needs a number from 1024 to 65535, not ${value ?? 'nothing'}.`);
    } else throw new Error(`Unknown option ${arg}.`);
  }
  return { help: false, port, readOnly };
}

/** Where clients find My Drive; the server's top only lists it. */
export const webdavUrl = (port: number) => `http://127.0.0.1:${port}/harbor0/`;
export const newWebdavPassword = () => randomBytes(18).toString('base64url');

/** The account a token belongs to, or null when the token no longer works. */
export async function tokenOwner(apiUrl: string, token: string) {
  const response = await fetch(apiUrl + '/v1/users/me', {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (response.status === 401) return null;
  const data = await response.json().catch(() => undefined);
  if (!response.ok)
    throw new Error(data?.error?.message ?? `harbor0 answered ${response.status}. Try again.`);
  return {
    id: data.user.id as string,
    email: data.user.email as string,
    allowed: data.flags?.[WEBDAV_FLAG] === true,
    encrypted: !!data.user.e2ee,
  };
}

/**
 * Returns a working key for the account, reusing the saved one when it still works and
 * otherwise creating a new access token with `mint`. `userId` is the account the app is signed
 * in to; a key for another account is replaced.
 */
export async function ensureWebdavKey(options: {
  apiUrl: string;
  userId?: string;
  load: () => Promise<WebdavKey | undefined>;
  save: (key: WebdavKey) => Promise<void>;
  mint?: () => Promise<{ token: string; tokenId: string }>;
  owner?: typeof tokenOwner;
}): Promise<WebdavKey> {
  const owner = options.owner ?? tokenOwner;
  const saved = await options.load();
  const usable =
    saved &&
    saved.apiUrl === options.apiUrl &&
    (!options.userId || saved.userId === options.userId);
  if (usable) {
    const current = await owner(saved.apiUrl, saved.token);
    if (current?.id === saved.userId) {
      if (current.email !== saved.email) await options.save({ ...saved, email: current.email });
      return { ...saved, email: current.email };
    }
  }
  if (!options.mint) throw new MissingWebdavKey();
  const { token, tokenId } = await options.mint();
  const created = await owner(options.apiUrl, token);
  if (!created) throw new Error('The new WebDAV access token was rejected. Try again.');
  const key: WebdavKey = {
    apiUrl: options.apiUrl,
    userId: created.id,
    email: created.email,
    tokenId,
    token,
  };
  await options.save(key);
  return key;
}
export class MissingWebdavKey extends Error {
  constructor() {
    super('No WebDAV access key yet.');
  }
}
