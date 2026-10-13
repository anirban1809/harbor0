import { app } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ApiClient } from '@harbor/api-client';
import { readSealed, removeSealed, writeSealed } from './credentials';
import { DEFAULT_WEBDAV_PORT, newWebdavPassword, type WebdavKey } from './webdav';

/** The window app and `harbor0 webdav` share these files in the app's data folder. */
const keyFile = () => path.join(app.getPath('userData'), 'webdav-key.bin');
const settingsFile = () => path.join(app.getPath('userData'), 'webdav.json');
const passwordFile = () => path.join(app.getPath('userData'), 'webdav-password.bin');
/** Uploads wait here while they go up; one folder per port, so two servers never share one. */
export const webdavCacheDir = (port: number) =>
  path.join(app.getPath('userData'), 'webdav-cache', String(port));

export const webdavKeys = {
  load: () => readSealed<WebdavKey>(keyFile()),
  save: (key: WebdavKey) => writeSealed(keyFile(), key),
  remove: () => removeSealed(keyFile()),
};

/**
 * The password WebDAV clients use, shared by the app and `harbor0 webdav`, and the secret in the
 * path File Explorer maps instead; one of each per account.
 */
export async function webdavSecrets(userId: string) {
  type Secrets = { userId: string; password: string; mountSecret?: string };
  const saved = await readSealed<Secrets>(passwordFile()).catch(() => undefined);
  if (saved?.userId === userId && saved.mountSecret)
    return { password: saved.password, mountSecret: saved.mountSecret };
  const secrets = {
    password: saved?.userId === userId ? saved.password : newWebdavPassword(),
    mountSecret: newWebdavPassword(),
  };
  await writeSealed(passwordFile(), { userId, ...secrets });
  return secrets;
}
/** Where Finder mounts the server; the folder's name is the drive's name. */
export const webdavMountPoint = () => path.join(app.getPath('userData'), 'WebDAV', 'harbor0');

export type WebdavSettings = { enabled: boolean; port: number };
export async function readWebdavSettings(): Promise<WebdavSettings> {
  try {
    const saved = JSON.parse(await readFile(settingsFile(), 'utf8'));
    return {
      enabled: saved.enabled === true,
      port: validPort(saved.port) ? saved.port : DEFAULT_WEBDAV_PORT,
    };
  } catch {
    return { enabled: false, port: DEFAULT_WEBDAV_PORT };
  }
}
export const writeWebdavSettings = (settings: WebdavSettings) =>
  writeFile(settingsFile(), JSON.stringify(settings) + '\n', { mode: 0o600 });
export const validPort = (port: unknown): port is number =>
  Number.isInteger(port) && (port as number) >= 1024 && (port as number) <= 65535;

/** Creates the access token the server uses; it shows on the Devices page under this name. */
export async function mintWebdavToken(api: ApiClient) {
  const host = os.hostname().replace(/\.local$/, '');
  const name = `WebDAV on ${host}`.slice(0, 60);
  const { token, item }: { token: string; item: { id: string } } = await api.request('/v1/tokens', {
    method: 'POST',
    body: { name, scope: 'FULL', expiresInDays: 365 },
  });
  return { token, tokenId: item.id };
}
