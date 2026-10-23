import { app } from 'electron';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ApiClient, createTransport } from '@harbor/api-client';
import { prepareAppEnvironment } from './app-environment';
import { keychainReady, readSavedSession, sessionFile, writeSealed } from './credentials';
import { DesktopSession, requestRenewal } from './session';
import { DriveDav } from './drive-dav';
import { apiDrive } from './drive-dav-api';
import { apiCatalog, placesDrive } from './drive-dav-places';
import {
  MissingWebdavKey,
  WEBDAV_ENCRYPTED,
  WEBDAV_UNAVAILABLE,
  WEBDAV_USERNAME,
  ensureWebdavKey,
  parseWebdavArgs,
  tokenOwner,
  webdavUrl,
  type WebdavKey,
} from './webdav';
import { mintWebdavToken, webdavCacheDir, webdavKeys, webdavSecrets } from './local-webdav';

const WEBDAV_KEY_REQUEST = 'harbor0-webdav-key';
/** The message `harbor0 webdav` sends a running app that should create its access key. */
export const isWebdavKeyRequest = (data: unknown) =>
  (data as { request?: unknown } | null)?.request === WEBDAV_KEY_REQUEST;

const usage = `Usage: harbor0 webdav [--port <port>] [--read-only]

Serves your harbor0 My Drive over WebDAV on this computer until you press Ctrl+C.
It uses the account the harbor0 app is signed in to.

  --port <port>   Port on 127.0.0.1 to listen on (default 6810)
  --read-only     Don't allow changes`;

function fail(message: string, code = 1): never {
  console.error(message);
  process.exit(code);
}

/** `harbor0 webdav`: runs the WebDAV server in the foreground, without a window. */
export async function runWebdavCli(args: string[]) {
  let command;
  try {
    command = parseWebdavArgs(args);
  } catch (error) {
    fail(`${(error as Error).message}\n\n${usage}`, 2);
  }
  if (command.help) {
    console.log(usage);
    process.exit(0);
  }
  const { apiUrl, configured, configurationError } = prepareAppEnvironment();
  // Chromium keeps its own caches in the data folder; a running app has those open.
  app.setPath('sessionData', path.join(app.getPath('userData'), 'webdav-cli'));
  app.dock?.hide();
  await app.whenReady();
  if (!configured) fail(configurationError);
  if (!keychainReady())
    fail('harbor0 needs an OS keychain to keep the WebDAV access key. Enable one and try again.');

  const key = await webdavKey(apiUrl);
  try {
    const owner = await tokenOwner(key.apiUrl, key.token);
    if (owner?.encrypted) fail(WEBDAV_ENCRYPTED);
    if (!owner?.allowed) fail(WEBDAV_UNAVAILABLE);
  } catch (error) {
    fail((error as Error).message);
  }
  const { password } = await webdavSecrets(key.userId);
  const api = new ApiClient(createTransport(key.apiUrl, async () => key.token));
  const server = new DriveDav({
    drive: placesDrive(apiDrive(api), apiCatalog(api)),
    username: WEBDAV_USERNAME,
    password,
    port: command.port,
    readOnly: command.readOnly,
    tempDir: webdavCacheDir(command.port),
    onError: (error) => console.error((error as Error).message),
  });
  const stop = async () => {
    await server.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
  console.log(`Starting the WebDAV server for ${key.email}…`);
  try {
    await server.start();
  } catch (error) {
    fail((error as Error).message);
  }
  console.log(
    [
      '',
      `harbor0 WebDAV server for ${key.email}`,
      `  Address:   ${webdavUrl(command.port)}`,
      `  Username:  ${WEBDAV_USERNAME}`,
      `  Password:  ${password}`,
      `  Access:    ${command.readOnly ? 'read-only' : 'read and write'}`,
      '',
      process.platform === 'darwin'
        ? 'In Finder, choose Go → Connect to Server (⌘K) and enter the address.'
        : 'Enter the address in your file manager or WebDAV app.',
      'Press Ctrl+C to stop.',
      '',
    ].join('\n'),
  );
}

/**
 * The saved key if it still works. Otherwise the app makes one: the running app when it is
 * open, since it owns the session, or this process with the app's saved session when it isn't.
 */
async function webdavKey(apiUrl: string): Promise<WebdavKey> {
  const saved = { apiUrl, load: webdavKeys.load, save: webdavKeys.save };
  try {
    return await ensureWebdavKey(saved);
  } catch (error) {
    if (!(error instanceof MissingWebdavKey)) fail((error as Error).message);
  }
  if (app.requestSingleInstanceLock({ request: WEBDAV_KEY_REQUEST })) {
    try {
      const signedIn = await readSavedSession();
      if (!signedIn) fail('Sign in to the harbor0 app first, then run this again.');
      const session = new DesktopSession({
        renew: (refreshToken) => requestRenewal(apiUrl, refreshToken),
        persist: (value) => writeSealed(sessionFile(), value),
        // Signing out is the app's decision; it notices an ended session on its next start.
        clear: async () => {},
        signedOut() {},
      });
      await session.restore(signedIn);
      const api = new ApiClient(
        createTransport(
          apiUrl,
          () => session.token(),
          () => session.refresh(),
        ),
      );
      const { user } = await api.me();
      if (user.e2ee) fail(WEBDAV_ENCRYPTED);
      return await ensureWebdavKey({ ...saved, userId: user.id, mint: () => mintWebdavToken(api) });
    } catch (error) {
      fail(`Couldn't create a WebDAV access key: ${(error as Error).message}`);
    } finally {
      // The app can start again once the key exists.
      app.releaseSingleInstanceLock();
    }
  }
  // The running app received the request; wait for the key it saves.
  console.log('Asking the harbor0 app for a WebDAV access key…');
  const stale = (await webdavKeys.load().catch(() => undefined))?.token;
  for (let waited = 0; waited < 20_000; waited += 500) {
    await delay(500);
    const current = await webdavKeys.load().catch(() => undefined);
    if (current && current.token !== stale)
      try {
        return await ensureWebdavKey(saved);
      } catch (error) {
        if (!(error instanceof MissingWebdavKey)) fail((error as Error).message);
      }
  }
  fail(
    "The harbor0 app didn't create a WebDAV access key. Check that it's signed in, then try again. If your files are end-to-end encrypted, turn on the local WebDAV server in the app's Settings instead.",
  );
}
