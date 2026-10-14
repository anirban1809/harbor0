import { fetchTextPreview } from '../../../packages/api-client/src/preview';
import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  safeStorage,
  Tray,
  Menu,
  nativeImage,
  Notification,
  powerMonitor,
  clipboard,
} from 'electron';
import { Agent, setGlobalDispatcher } from 'undici';
import { createHash } from 'node:crypto';
import { writeFile, mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { watch } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { rendererRequestSchema } from './request-schema';
import { ApiClient, ApiError, createTransport, LiveUpdates } from '@harbor/api-client';
import { Journal, type Root } from './journal';
import { AccountProfiles } from './account-profiles';
import { DeviceKey } from './device-key';
import { SyncEngine } from './sync';
import { syncView } from './sync-view';
import { FolderDiskUsageCache } from './folder-disk-usage';
const folderDiskUsage = new FolderDiskUsageCache();
import { stickyIssue, type SyncRuntime } from './sync-state';
import {
  uploadFile,
  downloadFile,
  downloadFolderZip,
  transferKeys,
  type UploadState,
} from './transfers';
import { DesktopVault, type VaultStore } from './e2ee-vault';
import { openEncryptedFile, type PlainReader } from './e2ee-reader';
import { e2eeTransport } from '../../../packages/api-client/src/e2ee-transport';
import { E2eeError, parseRecoveryKey } from '../../../packages/api-client/src/e2ee';
import { TEXT_PREVIEW_BYTES } from '../../../packages/api-client/src/preview';
import { contained, safeSegment, safeParents } from './paths';
import type { FileUpload } from '../../web/lib/upload-activity';
import { prepareAppEnvironment } from './app-environment';
import { DesktopSession, isSessionError, requestRenewal } from './session';
import { readSavedSession, removeSealed, sessionFile, writeSealed } from './credentials';
import { retrying } from './retry';
import { cloudLocation, localDirectory } from './sync-mapping';
import { IncomingMonitor, type IncomingContent } from './incoming';
import { Updater, runningBundle } from './updater';
import {
  DEFAULT_WEBDAV_PORT,
  WEBDAV_FLAG,
  WEBDAV_UNAVAILABLE,
  WEBDAV_USERNAME,
  ensureWebdavKey,
  webdavUrl,
} from './webdav';
import {
  mintWebdavToken,
  readWebdavSettings,
  webdavCacheDir,
  webdavKeys,
  webdavMountPoint,
  webdavSecrets,
  writeWebdavSettings,
  type WebdavSettings,
} from './local-webdav';
import { isWebdavKeyRequest } from './webdav-cli';
import { DavHost } from './dav-host';
import type { AppUpload, DavUploadView } from './drive-dav';
import type { SyncDriveItem } from './sync-drive';
import {
  canMount,
  mapInExplorer,
  mountInFinder,
  revealMount,
  unmount,
  unmountNow,
  type WebdavMount,
} from './webdav-mount';
// fetch closes idle connections after 4s, so the first request after a quiet moment
// paid a fresh TCP + TLS handshake (about 0.6s far from the API region). Keeping them
// open longer lets a sync after a pause start immediately.
setGlobalDispatcher(new Agent({ keepAliveTimeout: 60_000, keepAliveMaxTimeout: 600_000 }));
const { development, apiUrl, webUrl, configured, configurationError } = prepareAppEnvironment();
let window: BrowserWindow;
let tray: Tray;
let journal: Journal;
let profiles: AccountProfiles;
let accountReady = false;
let authTransition = false;
let stoppingSync: Promise<void> = Promise.resolve();
const operations = new Set<Promise<unknown>>();
let engine: SyncEngine | undefined;
let quitting = false;
let updater: Updater | undefined;
let incomingMonitor: IncomingMonitor | undefined;
let live: LiveUpdates | undefined;
let incomingTimer: ReturnType<typeof setTimeout> | undefined;
const incomingNotifications = new Set<Notification>();
let notificationError: string | null = null;
const localSelections = new Map<string, string>();
const rendererPath = path.join(__dirname, 'renderer/index.html');
// Revoking this computer stops its sync and backups for good: the next sign-in starts fresh.
// Signing it out only pauses them, so its folders are kept for when it signs in again.
let revokedJournal: Journal | undefined;
// Why the session ended when the user did not sign out here; the sign-in screen says so.
let signedOutReason: string | null = null;
function noteRevoked(error: unknown) {
  if (error instanceof ApiError && error.code === 'DEVICE_REVOKED' && accountReady)
    revokedJournal = journal;
  if (isSessionError(error) && accountReady && !authTransition)
    signedOutReason =
      (error as ApiError).code === 'DEVICE_REVOKED'
        ? 'This computer was signed out from another device and removed from your account. Your local files were kept; sign in to set up sync again.'
        : /signed out/i.test((error as Error).message)
          ? 'This computer was signed out from another device. Sign in again to resume syncing; your local files were kept.'
          : 'Your session ended. Sign in again to continue.';
}
// The local WebDAV server (Settings → Local WebDAV server); one change at a time. It runs on a
// thread of its own with this app's session and keys, so encrypted accounts are decrypted on
// this computer and nothing the main thread waits on can stop it answering Finder.
const webdav = new DavHost({
  token: async (refresh) => {
    if (refresh) await session.refresh();
    return session.token();
  },
  vault: () => vault.current(),
  onError: (message) => console.error('WebDAV request failed:', message),
  onUploads(uploads) {
    davUploads = uploads;
    if (engine && accountReady)
      window?.webContents.send('harbor:status', statusView(journal, engine.state));
  },
  onExit(reason) {
    webdavError = reason;
    void disconnectWebdav().then(sendWebdav);
  },
});
let webdavPasswordShown: string | undefined;
let webdavMountSecret: string | undefined;
/** The server as a drive in Finder or File Explorer, while connected. */
let webdavMount: WebdavMount | undefined;
let webdavSettings: WebdavSettings = { enabled: false, port: DEFAULT_WEBDAV_PORT };
let webdavError: string | null = null;
let webdavQueue: Promise<unknown> = Promise.resolve();
let accountId: string | undefined;
async function stopWebdav() {
  await disconnectWebdav();
  await webdav.stop();
}
async function disconnectWebdav() {
  const mount = webdavMount;
  webdavMount = undefined;
  if (mount) await unmount(mount);
}
function webdavTask<T>(task: () => Promise<T>) {
  const run = webdavQueue.then(task, task);
  webdavQueue = run.catch(() => {});
  return run;
}
function webdavView() {
  const executable = process.execPath.includes(' ') ? `"${process.execPath}"` : process.execPath;
  const encrypted = accountReady && vault.current().enabled;
  return {
    enabled: webdavSettings.enabled,
    running: webdav.running,
    encrypted,
    url: webdavUrl(webdavSettings.port),
    username: WEBDAV_USERNAME,
    password: webdav.running ? (webdavPasswordShown ?? null) : null,
    // Finder on a Mac, File Explorer on Windows.
    mount: canMount() ? (webdavMount ?? null) : undefined,
    error:
      webdavError ??
      (webdav.running && vault.locked
        ? 'Unlock your encrypted files to open them over WebDAV.'
        : null),
    // `harbor0 webdav` uses an access token, which can't read encrypted files.
    command: encrypted
      ? null
      : app.isPackaged
        ? `${executable} webdav`
        : 'npm run dev:desktop -- webdav',
  };
}
function sendWebdav() {
  window?.webContents.send('harbor:webdav', webdavView());
}
/** For `harbor0 webdav`: the saved key when it still works for this account, otherwise a new access token. */
const currentWebdavKey = () =>
  ensureWebdavKey({
    apiUrl,
    userId: accountId,
    load: webdavKeys.load,
    save: webdavKeys.save,
    mint: () => mintWebdavToken(api),
  });
async function startWebdav() {
  await stopWebdav();
  if (!webdavSettings.enabled || !accountReady || !accountId) return sendWebdav();
  try {
    // Turned on earlier, but the account's flag may be off now.
    const { flags } = await api.me();
    if (!flags[WEBDAV_FLAG]) throw new Error(WEBDAV_UNAVAILABLE);
    const port = webdavSettings.port;
    const secrets = await webdavSecrets(accountId);
    webdavPasswordShown = secrets.password;
    // Only File Explorer uses the mount path without a password.
    webdavMountSecret = process.platform === 'win32' ? secrets.mountSecret : undefined;
    await webdav.start({
      apiUrl,
      username: WEBDAV_USERNAME,
      password: webdavPasswordShown,
      mountSecret: webdavMountSecret,
      // Live updates have listings read again as soon as something changes elsewhere.
      listingTtlMs: 60_000,
      port,
      tempDir: webdavCacheDir(port),
    });
    webdavError = null;
  } catch (error) {
    webdavError = (error as Error).message;
  }
  sendWebdav();
}
/** Signing out revokes the server's access token, which also stops `harbor0 webdav`. */
async function revokeWebdavKey() {
  await stopWebdav();
  const key = await webdavKeys.load().catch(() => undefined);
  if (key && key.apiUrl === apiUrl && key.userId === accountId) {
    try {
      await api.request(`/v1/tokens/${key.tokenId}`, { method: 'DELETE' });
    } catch {
      /* The device list still shows it, so it can be revoked there. */
    }
    await webdavKeys.remove();
  }
}
const session = new DesktopSession({
  persist: (saved) => writeSealed(sessionFile(), saved),
  clear: () => removeSealed(sessionFile()),
  signedOut() {
    live?.stop();
    live = undefined;
    incomingMonitor?.stop();
    incomingMonitor = undefined;
    for (const notification of incomingNotifications) notification.close();
    incomingNotifications.clear();
    const previous = engine;
    engine = undefined;
    accountReady = false;
    accountId = undefined;
    void webdavTask(stopWebdav).then(sendWebdav);
    localSelections.clear();
    stoppingSync = Promise.all([stoppingSync, previous?.stop()]).then(() => {});
    const revoked = revokedJournal;
    revokedJournal = undefined;
    if (revoked)
      // Forget the folders once the engine has stopped. Only bookkeeping goes; files stay.
      stoppingSync = stoppingSync.then(() => {
        for (const root of revoked.roots()) revoked.removeRoot(root.id);
      });
    window?.webContents.send('harbor:signed-out', signedOutReason);
  },
  async renew(refreshToken) {
    if (!configured) throw new Error(configurationError);
    try {
      return await requestRenewal(apiUrl, refreshToken);
    } catch (error) {
      noteRevoked(error);
      throw error;
    }
  },
});
const transport = retrying(
  createTransport(
    apiUrl,
    () => session.token(),
    () => session.refresh(),
  ),
);
/** This computer's copy of the account key, sealed by the OS keychain in the account's journal. */
const vaultStore = (active: Journal): VaultStore => ({
  load() {
    const sealed = active.get<string>('e2eeDevice');
    if (!sealed) return undefined;
    try {
      return JSON.parse(safeStorage.decryptString(Buffer.from(sealed, 'base64')));
    } catch {
      return undefined;
    }
  },
  save: (copy) =>
    active.set('e2eeDevice', safeStorage.encryptString(JSON.stringify(copy)).toString('base64')),
  clear: () => active.set('e2eeDevice', null),
});
const vault = new DesktopVault(
  () => (journal ? vaultStore(journal) : undefined),
  () => vaultChanged(),
);
transferKeys.upload = vault.uploadKeys;
transferKeys.read = vault.readKeys;
/** Unlocking resumes sync. */
function vaultChanged() {
  if (engine && accountReady) {
    window?.webContents.send('harbor:status', statusView(journal, engine.state));
    if (!vault.locked) engine.wake();
  }
  // The WebDAV thread decrypts with the same keys; the locked notice in Settings follows.
  webdav.updateVault();
  sendWebdav();
}
const e2eeView = () =>
  vault.current().enabled
    ? { locked: vault.locked, decrypting: !!vault.current().decrypting }
    : null;
/** Requests the server refuses for an encrypted account; one succeeding means it no longer is. */
const fileRequest = (endpoint: string) =>
  /^\/v1\/(drive|uploads|downloads|folder-downloads|sync|backups|search|transfers|shares|storage)(\/|\?|$)/.test(
    endpoint,
  );
let e2eeBlocked = false;
function setE2eeBlocked(blocked: boolean) {
  if (e2eeBlocked === blocked) return;
  e2eeBlocked = blocked;
  if (engine && accountReady)
    window?.webContents.send('harbor:status', statusView(journal, engine.state));
}
/** What Finder or File Explorer is uploading through the local WebDAV server. */
let davUploads: DavUploadView[] = [];
const davApp = process.platform === 'win32' ? 'File Explorer' : 'Finder';
/** Those uploads as rows in My Drive, until a listing has the stored file. */
const davDriveItems = (): SyncDriveItem[] =>
  davUploads.map((upload) => ({
    id: upload.id,
    parentId: upload.parentId,
    name: upload.name,
    type: 'FILE',
    sizeBytes: upload.size,
    location: 'Cloud',
    ...(upload.done
      ? {}
      : {
          localOnly: true,
          syncStatus: 'Syncing',
          syncDetail: `Uploading from ${davApp}`,
          syncProgress: upload.size ? Math.round((upload.loaded / upload.size) * 100) : 0,
        }),
  }));
/** Files this app is uploading, which the WebDAV server lists until they land. */
const appUploads = new Map<string, AppUpload>();
const sendAppUploads = () => webdav.appUploads([...appUploads.values()]);
const statusView = (activeJournal: Journal, state: SyncRuntime) => {
  const view = syncView(activeJournal, state);
  return {
    ...view,
    driveItems: [...view.driveItems, ...davDriveItems()],
    e2eeBlocked,
    e2ee: e2eeView(),
  };
};
// Names are encrypted on the way out and decrypted on the way back; while the account is
// locked, file requests are refused rather than handing sync encrypted names.
const sealed = e2eeTransport(transport, {
  vault: vault.current,
  onAccount: vault.setAccount,
  strict: true,
});
/** The account as stored, names and all: for converting backups, which must see both forms. */
const rawApi = new ApiClient(transport);
// Encryption turned on or off on the web reaches this app through the account's state.
setInterval(() => {
  if (accountReady && vault.current().enabled) void api.me().catch(() => {});
}, 60_000).unref();
const api = new ApiClient(async (endpoint, init) => {
  try {
    const result = await sealed(endpoint, init);
    if (e2eeBlocked && fileRequest(endpoint)) setE2eeBlocked(false);
    return result;
  } catch (error) {
    // This build is older than the server accepts for encrypted accounts.
    if (error instanceof ApiError && error.code === 'E2EE_UPDATE_REQUIRED') setE2eeBlocked(true);
    // Encryption was turned on or off elsewhere: the account's state tells the vault, and the
    // next attempt goes up the right way.
    if (error instanceof ApiError && ['E2EE_OFF', 'E2EE_REQUIRED'].includes(error.code))
      void api.me().catch(() => {});
    noteRevoked(error);
    if (isSessionError(error)) await session.invalidate();
    throw error;
  }
});
/**
 * Sync progress arrives up to ten times a second, and with a large queue building the status
 * takes long enough to stall the app. Sends wait so building them stays a small share of time;
 * the latest state is the one sent.
 */
let engineStatus: { journal: Journal; state: SyncRuntime } | undefined;
let engineStatusTimer: ReturnType<typeof setTimeout> | undefined;
let engineStatusSentAt = 0;
let engineStatusCost = 0;
function sendEngineStatus(activeJournal: Journal, state: SyncRuntime) {
  engineStatus = { journal: activeJournal, state };
  if (engineStatusTimer) return;
  const gap = Math.max(100, engineStatusCost * 5);
  engineStatusTimer = setTimeout(
    () => {
      engineStatusTimer = undefined;
      const pending = engineStatus;
      engineStatus = undefined;
      if (!pending || !accountReady || journal !== pending.journal) return;
      const started = performance.now();
      window?.webContents.send('harbor:status', statusView(pending.journal, pending.state));
      engineStatusCost = performance.now() - started;
      engineStatusSentAt = Date.now();
    },
    Math.max(0, engineStatusSentAt + gap - Date.now()),
  );
}
async function connected() {
  e2eeBlocked = false;
  const { user } = await api.me();
  journal = profiles.select(user.id);
  const deviceKey = DeviceKey.load(journal, {
    seal: (value) => safeStorage.encryptString(value).toString('base64'),
    open: (sealed) => safeStorage.decryptString(Buffer.from(sealed, 'base64')),
  });
  const { challenge }: { challenge: string } = await api.request('/v1/auth/session/challenge', {
    method: 'POST',
  });
  const response = await api.request('/v1/auth/session', {
    method: 'POST',
    body: {
      name: os.hostname(),
      platform:
        process.platform === 'darwin'
          ? 'MACOS'
          : process.platform === 'win32'
            ? 'WINDOWS'
            : 'LINUX',
      devicePublicId: deviceKey.devicePublicId,
      appVersion: app.getVersion(),
      proof: deviceKey.prove(challenge, user.id),
    },
  });
  signedOutReason = null;
  journal.set('deviceId', response.device.id);
  journal.set('deviceName', response.device.name ?? os.hostname());
  // An encrypted account opens with this computer's saved copy of the key, if it has one.
  if (vault.current().enabled) await vault.restore(api.request);
  for (const root of journal.roots()) {
    try {
      journal.root({ ...root, cloudPath: (await cloudLocation(api, root.remoteId)).path });
    } catch {
      /* Keep the last known cloud location while offline. */
    }
  }
  journal.set('publicId', response.device.devicePublicId);
  accountId = user.id;
  await engine?.stop();
  const activeJournal = journal;
  engine = new SyncEngine(
    api,
    activeJournal,
    response.device.id,
    (state) => sendEngineStatus(activeJournal, state as SyncRuntime),
    (title, body) => {
      if (accountReady && journal === activeJournal) notify(title, body);
    },
  );
  engine.hold = () =>
    vault.locked ? 'Unlock your files to sync. Nothing syncs until then.' : null;
  engine.backupConversion = {
    form: () =>
      vault.uploadKeys()
        ? 'encrypted'
        : vault.current().decrypting && vault.readKeys()
          ? 'plain'
          : null,
    raw: rawApi,
  };
  engine.state.paused = journal.get<boolean>('paused') ?? false;
  await engine.start();
  accountReady = true;
  incomingMonitor?.stop();
  const monitor: IncomingMonitor = new IncomingMonitor({
    seen: activeJournal.get<string[]>('incomingNotifications') ?? [],
    save: (seen) => activeJournal.set('incomingNotifications', seen),
    active: () => accountReady && !authTransition && journal === activeJournal && !quitting,
    request: async (endpoint) => {
      const operation = api.request(endpoint);
      operations.add(operation);
      try {
        return await operation;
      } finally {
        operations.delete(operation);
      }
    },
    notify: (content) => notifyIncoming(content, monitor),
  });
  incomingMonitor = monitor;
  setTimeout(() => void monitor.poll(), 0);
  live?.stop();
  const activeEngine = engine;
  live = new LiveUpdates({
    ticket: () => api.request('/v1/realtime/tickets', { method: 'POST' }),
    onMessage(message) {
      if (journal !== activeJournal) return;
      if (message.type === 'changes') {
        activeEngine.wake();
        webdav.forget();
      } else void monitor.poll();
      window?.webContents.send('harbor:live', { connected: true, type: message.type });
    },
    onConnected(connected) {
      if (journal !== activeJournal) return;
      activeEngine.setLive(connected);
      // Anything that happened while disconnected was not pushed.
      if (connected) {
        activeEngine.wake();
        webdav.forget();
        void monitor.poll();
      }
      window?.webContents.send('harbor:live', { connected });
    },
  });
  live.start();
  window?.webContents.send('harbor:authenticated');
  void webdavTask(startWebdav);
  return { user };
}
// Windows shows notifications only for the app ID the installer gave the Start menu shortcut.
// Electron registers that ID's toast activator to launch whichever executable last showed a
// notification, so an unpackaged electron.exe must use its own ID or clicks open Electron's
// default app. A fixed activator keeps toasts left in Action Center working after a restart.
if (process.platform === 'win32') {
  app.setAppUserModelId(app.isPackaged ? 'com.harbor.storage' : 'com.harbor.storage.dev');
  app.setToastActivatorCLSID(
    app.isPackaged
      ? '{97B05483-3DCF-41FC-997E-621F60D1B04E}'
      : '{AAA5958C-E20E-42C9-B684-193BD660A260}',
  );
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', (_event, _argv, _cwd, data) => {
    // `harbor0 webdav` asks for an access key while this app holds the account's session.
    if (isWebdavKeyRequest(data)) {
      // An encrypted account's files can't be read with an access token.
      if (accountReady && !authTransition && !vault.current().enabled)
        void webdavTask(currentWebdavKey).catch(() => {});
      return;
    }
    window?.show();
    window?.focus();
  });
}
// The login page uses these, so they work without an account.
const signedOutChannels = new Set([
  'status',
  'openAccountPage',
  'loginMethod',
  'updateStatus',
  'checkForUpdate',
  'installUpdate',
]);
/** Encrypted files being previewed, opened once and read a range at a time. */
const encryptedPreviews = new Map<string, Promise<PlainReader>>();
function encryptedPreview(driveItemId: string) {
  const keys = vault.readKeys();
  if (!keys) throw new ApiError('E2EE_LOCKED', 'Unlock your files to continue.', 423);
  let reader = encryptedPreviews.get(driveItemId);
  if (!reader) {
    reader = openEncryptedFile(api, driveItemId, keys);
    reader.catch(() => encryptedPreviews.delete(driveItemId));
    encryptedPreviews.set(driveItemId, reader);
    while (encryptedPreviews.size > 10)
      encryptedPreviews.delete(encryptedPreviews.keys().next().value!);
  }
  return reader;
}
/**
 * PDFs being previewed, read a range at a time because the renderer may not fetch: decrypted
 * ranges of an encrypted file, or ranges of its download link, signed again once it expires.
 */
const pdfPreviews = new Map<string, Promise<PlainReader>>();
function openPdfPreview(driveItemId: string) {
  const reader = (async (): Promise<PlainReader> => {
    let link: { downloadUrl: string; sizeBytes: number; encrypted?: boolean } = await api.download({
      driveItemId,
    });
    if (link.encrypted) {
      // Opened afresh, in case the file changed since an earlier preview.
      encryptedPreviews.delete(driveItemId);
      return encryptedPreview(driveItemId);
    }
    const read = async (begin: number, end: number, retry = true): Promise<Uint8Array> => {
      const response = await fetch(link.downloadUrl, {
        headers: { Range: `bytes=${begin}-${end - 1}` },
        signal: AbortSignal.timeout(60_000),
      });
      if ((response.status === 403 || response.status === 400) && retry) {
        await response.body?.cancel();
        link = await api.download({ driveItemId });
        return read(begin, end, false);
      }
      if (!response.ok) throw new Error(`Could not read the file (${response.status}).`);
      const data = new Uint8Array(await response.arrayBuffer());
      // Storage that ignores Range sends the whole file.
      return response.status === 206 ? data : data.slice(begin, end);
    };
    return { size: link.sizeBytes, read: (begin, end) => read(begin, end) };
  })();
  reader.catch(() => pdfPreviews.delete(driveItemId));
  pdfPreviews.delete(driveItemId);
  pdfPreviews.set(driveItemId, reader);
  while (pdfPreviews.size > 10) pdfPreviews.delete(pdfPreviews.keys().next().value!);
  return reader;
}
function ipc(name: string, schema: z.ZodType, handler: (input: any) => Promise<unknown>) {
  ipcMain.handle('harbor:' + name, async (event, input) => {
    if (
      event.sender !== window.webContents ||
      event.senderFrame?.url !== pathToFileURL(rendererPath).href
    )
      throw new Error('Untrusted IPC sender.');
    const authentication = name === 'login' || name === 'loginVerify' || name === 'logout';
    let operation: Promise<unknown> | undefined;
    let ownsTransition = false;
    try {
      const parsed = schema.parse(input);
      if (authentication) {
        if (authTransition) throw new Error('An account change is already in progress.');
        if ((name === 'login' || name === 'loginVerify') && accountReady)
          throw new Error('Sign out before using another account.');
        authTransition = true;
        ownsTransition = true;
        // Old requests and sync work must finish before credentials or journals change.
        await Promise.allSettled([...operations]);
        await stoppingSync;
      } else if (!signedOutChannels.has(name) && (authTransition || !accountReady)) {
        throw new Error('Sign in before continuing.');
      }
      operation = handler(parsed);
      if (!authentication) operations.add(operation);
      return { ok: true, data: await operation };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    } finally {
      if (operation) operations.delete(operation);
      if (ownsTransition) authTransition = false;
    }
  });
}
function notify(title: string, body: string) {
  if (Notification.isSupported()) {
    const notification = new Notification({ title, body });
    notification.on('click', () => window.show());
    void presentNotification(notification);
  }
}
function presentNotification(notification: Notification): Promise<boolean> {
  incomingNotifications.add(notification);
  notification.on('close', () => incomingNotifications.delete(notification));
  return new Promise((resolve) => {
    const timeout = setTimeout(
      () => finish('No response from the system notification service.'),
      10000,
    );
    const shown = () => finish(null);
    const failed = (_event: unknown, error: string) => finish(error);
    function finish(error: string | null) {
      clearTimeout(timeout);
      notification.removeListener('show', shown);
      notification.removeListener('failed', failed);
      notificationError = error;
      if (error) {
        incomingNotifications.delete(notification);
        console.error(JSON.stringify({ event: 'desktop_notification_failed', message: error }));
      }
      resolve(!error);
    }
    notification.once('show', shown);
    notification.once('failed', failed);
    try {
      notification.show();
    } catch (error) {
      finish((error as Error).message);
    }
  });
}
async function notifyIncoming(content: IncomingContent, monitor: IncomingMonitor) {
  if (!Notification.isSupported()) {
    notificationError = 'Desktop notifications are not supported on this computer.';
    return false;
  }
  const sender = content.kind === 'sync' ? content.item.owner : content.item.sender;
  const names =
    content.kind === 'sync'
      ? content.item.name
      : content.item.displayNames?.join(', ') ||
        content.item.items
          .filter((entry) => !entry.parentEntryId)
          .map((entry) => entry.displayName)
          .join(', ') ||
        'Files';
  const notification = new Notification({
    title: content.kind === 'sync' ? 'Sync folder received' : 'Content received',
    body: `${sender.displayName} sent ${names}. Open to accept or reject.`,
  });
  notification.on('click', () => {
    if (!accountReady || authTransition || incomingMonitor !== monitor) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    window.webContents.send('harbor:incoming', content);
  });
  return presentNotification(notification);
}
app
  .whenReady()
  .then(async () => {
    await mkdir(app.getPath('userData'), { recursive: true, mode: 0o700 });
    profiles = new AccountProfiles(app.getPath('userData'), apiUrl);
    journal = new Journal(':memory:');
    window = new BrowserWindow({
      width: 1140,
      height: 780,
      minWidth: 840,
      minHeight: 620,
      title: 'harbor0',
      icon: path.join(__dirname, 'icon.png'),
      backgroundColor: '#f4f5f7',
      autoHideMenuBar: true,
      ...(process.platform === 'darwin' && {
        titleBarStyle: 'hiddenInset' as const,
        trafficLightPosition: { x: 18, y: 18 },
      }),
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => {
      if (url !== pathToFileURL(rendererPath).href) event.preventDefault();
    });
    window.webContents.session.setPermissionRequestHandler((_, __, callback) => callback(false));
    window.on('close', (event) => {
      if (!quitting) {
        event.preventDefault();
        window.hide();
      }
    });
    const appIcon = nativeImage.createFromPath(path.join(__dirname, 'icon.png'));
    app.dock?.setIcon(appIcon);
    const icon =
      process.platform === 'darwin'
        ? nativeImage.createFromPath(path.join(__dirname, 'trayTemplate.png'))
        : appIcon.resize({ width: 24, height: 24 });
    if (process.platform === 'darwin') icon.setTemplateImage(true);
    tray = new Tray(icon);
    tray.setToolTip('harbor0');
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open harbor0', click: () => window.show() },
        {
          label: 'Send a file',
          click: () => {
            window.show();
            window.webContents.send('harbor:send');
          },
        },
        { label: 'Pause sync', type: 'checkbox', click: (item) => engine?.pause(item.checked) },
        { type: 'separator' },
        {
          label: 'Quit harbor0',
          click: () => {
            quitting = true;
            app.quit();
          },
        },
      ]),
    );
    tray.on('click', () => window.show());
    // Clicks on toasts from an earlier run, or after the Notification was collected, arrive here.
    // Windows starts the app hidden for a click while it is closed and waits for its activator,
    // which Electron registers only once its notification presenter exists; isSupported()
    // creates it.
    if (process.platform === 'win32' && Notification.isSupported())
      Notification.handleActivation(() => {
        if (window.isMinimized()) window.restore();
        window.show();
        window.focus();
      });
    ipc('status', z.undefined(), async () => {
      if (!authTransition && session.refreshToken) {
        try {
          await session.token();
        } catch (error) {
          if (!isSessionError(error))
            window.webContents.send('harbor:error', (error as Error).message);
        }
      }
      return {
        configured,
        configurationError,
        accountLinks: Boolean(webUrl),
        notificationError,
        development,
        signedIn: session.signedIn && accountReady,
        signedOutReason,
        live: live?.connected ?? false,
        e2ee: accountReady ? e2eeView() : null,
        roots: (accountReady ? journal.roots() : []).map((r) => ({
          ...r,
          ...journal.fileCounts(r.id),
          diskSizeBytes:
            r.mode === 'sync' ? folderDiskUsage.read(r.localPath, r.excluded) : undefined,
          localPathDisplayName: path.basename(r.localPath),
          localPathDisplay: r.localPath.startsWith(os.homedir() + path.sep)
            ? '~' + r.localPath.slice(os.homedir().length)
            : r.localPath,
        })),
        sync: engine ? statusView(journal, engine.state) : { message: 'Sign in to start syncing' },
        jobs: accountReady ? journal.jobSummary() : [],
        deviceName: journal.get('deviceName') ?? os.hostname(),
        deviceId: accountReady ? journal.get('deviceId') : undefined,
        accountId: accountReady ? journal.get('accountId') : null,
      };
    });
    const signInDevice = () => ({
      deviceName: os.hostname(),
      platform:
        process.platform === 'darwin'
          ? 'MACOS'
          : process.platform === 'win32'
            ? 'WINDOWS'
            : 'LINUX',
    });
    const authCall = async (path: string, body: Record<string, unknown>) => {
      if (!configured) throw new Error(configurationError);
      const response = await fetch(apiUrl + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { response, data: (await response.json()) as any };
    };
    /** Stores the tokens of a finished sign-in and connects this computer's account. */
    const finishSignIn = async (data: any) => {
      await session.signIn(data);
      try {
        return await connected();
      } catch (error) {
        await session.invalidate();
        throw error;
      }
    };
    const email = z.email().max(254);
    const twoFactorMethod = z.enum(['TOTP', 'EMAIL']);
    ipc(
      'login',
      z.object({ email, password: z.string().min(1).max(256) }).strict(),
      async (input) => {
        // Accounts with two-step verification answer with a challenge instead of tokens; the
        // renderer asks for the code and finishes with loginVerify.
        const { response, data } = await authCall('/v1/auth/login', {
          ...input,
          ...signInDevice(),
          twoFactor: true,
        });
        if (!response.ok)
          throw new Error(data.error?.message ?? 'Could not sign in. Please try again.');
        if (data.twoFactor) return { twoFactor: data.twoFactor };
        return finishSignIn(data);
      },
    );
    ipc(
      'loginMethod',
      z.object({ email, session: z.string().min(1).max(8192), method: twoFactorMethod }).strict(),
      async (input) => {
        const { response, data } = await authCall('/v1/auth/login/method', input);
        if (!response.ok)
          return {
            failed: {
              code: data.error?.code,
              message: data.error?.message ?? 'Could not send a code.',
            },
          };
        return { twoFactor: data.twoFactor };
      },
    );
    ipc(
      'loginVerify',
      z
        .object({
          email,
          session: z.string().min(1).max(8192),
          method: twoFactorMethod,
          code: z.string().regex(/^\d{6,8}$/),
        })
        .strict(),
      async (input) => {
        const { response, data } = await authCall('/v1/auth/login/verify', {
          ...input,
          ...signInDevice(),
        });
        // A wrong code keeps the sign-in going; the renderer needs the session it hands back.
        if (!response.ok)
          return {
            failed: {
              code: data.error?.code,
              message: data.error?.message ?? 'Could not sign in. Please try again.',
              session: data.error?.details?.session,
            },
          };
        return finishSignIn(data);
      },
    );
    ipc('request', rendererRequestSchema, async (input) =>
      api.request(input.path, { method: input.method, body: input.body }),
    );
    ipc('testNotification', z.undefined(), async () => {
      if (!Notification.isSupported())
        throw new Error('Desktop notifications are not supported on this computer.');
      const shown = await presentNotification(
        new Notification({
          title: 'harbor0 notifications',
          body: 'Notifications are working. Incoming files and sync invitations will appear here.',
        }),
      );
      if (!shown) throw new Error(notificationError ?? 'Could not show a desktop notification.');
      return { shown };
    });
    ipc(
      'openAccountPage',
      z.object({ page: z.enum(['signup', 'forgot', 'drive', 'settings']) }).strict(),
      async ({ page }) => {
        if (!webUrl) throw new Error('Set HARBOR_WEB_URL to open account pages.');
        await shell.openExternal(
          webUrl +
            { signup: '/signup', forgot: '/forgot-password', drive: '/', settings: '/settings' }[
              page as string
            ],
        );
      },
    );
    ipc('notificationSettings', z.undefined(), async () => {
      if (process.platform === 'darwin')
        await shell.openExternal(
          'x-apple.systempreferences:com.apple.Notifications-Settings.extension',
        );
      else if (process.platform === 'win32') await shell.openExternal('ms-settings:notifications');
      else throw new Error('Open Notifications in your desktop system settings.');
    });
    ipc(
      'previewText',
      z.object({ driveItemId: z.string().min(1).max(256) }).strict(),
      async (input) => {
        const result: { downloadUrl: string; sizeBytes: number; encrypted?: boolean } =
          await api.download(input);
        if (result.encrypted) {
          const reader = await encryptedPreview(input.driveItemId);
          const bytes = await reader.read(0, Math.min(reader.size, TEXT_PREVIEW_BYTES));
          const text = new TextDecoder().decode(bytes);
          if (text.includes('\0'))
            throw new Error('This file contains binary data and cannot be shown as text.');
          return { text, truncated: reader.size > TEXT_PREVIEW_BYTES };
        }
        return fetchTextPreview(result.downloadUrl, result.sizeBytes, AbortSignal.timeout(30_000));
      },
    );
    // The renderer may not fetch, so PDF previews read their bytes here, a range at a time.
    ipc(
      'previewPdf',
      z.object({ driveItemId: z.string().min(1).max(256) }).strict(),
      async ({ driveItemId }) => ({ size: (await openPdfPreview(driveItemId)).size }),
    );
    ipc(
      'previewRange',
      z
        .object({
          driveItemId: z.string().min(1).max(256),
          begin: z.number().int().min(0),
          end: z.number().int().positive(),
        })
        .strict()
        .refine((range) => range.end > range.begin && range.end - range.begin <= 16 * 1024 * 1024),
      async ({ driveItemId, begin, end }) =>
        (await (pdfPreviews.get(driveItemId) ?? openPdfPreview(driveItemId))).read(begin, end),
    );
    // pdf.js's fonts, CMaps and image decoders, which build.ts copies next to this file.
    ipc(
      'pdfAsset',
      z.object({ path: z.string().regex(/^(cmaps|standard_fonts|wasm)\/[\w.+-]+$/) }).strict(),
      async (input) => new Uint8Array(await readFile(path.join(__dirname, 'pdfjs', input.path))),
    );
    ipc('chooseRoot', z.object({ mode: z.enum(['sync', 'backup']) }).strict(), async (input) => {
      if (!engine) throw new Error('Sign in first.');
      if (input.mode === 'sync')
        throw new Error('Use Add folder to sync to choose both locations.');
      const selection = await dialog.showOpenDialog(window, {
        properties: ['openDirectory', 'createDirectory'],
        title:
          input.mode === 'sync' ? 'Choose your harbor0 sync folder' : 'Choose a folder to back up',
      });
      if (selection.canceled) return null;
      const localPath = await localDirectory(selection.filePaths[0], 'backup');
      profiles.assertAvailable(localPath, journal);
      let remoteId: string | null = null;
      let backupId: string | undefined;
      engine.validateRoot({
        id: crypto.randomUUID(),
        localPath,
        remoteId: null,
        mode: 'backup',
        paused: false,
        excluded: [],
      });
      if (input.mode === 'backup') {
        const response = await api.request('/v1/backups', {
          method: 'POST',
          body: {
            operationId: crypto.randomUUID(),
            deviceId: journal.get('deviceId'),
            name: path.basename(localPath),
          },
        });
        remoteId = response.root.remoteRootDriveItemId;
        backupId = response.root.id;
      }
      const root: Root = {
        id: crypto.randomUUID(),
        localPath,
        remoteId,
        mode: input.mode,
        backupId,
        paused: false,
        excluded: [],
      };
      await engine.addRoot(root);
      return { id: root.id };
    });
    ipc('disconnectBackup', z.object({ id: z.string() }).strict(), async ({ id }) => {
      if (!engine) throw new Error('Sign in first.');
      await engine.disconnectBackup(id);
      return { disconnected: true };
    });
    ipc(
      'archiveBackup',
      z.object({ id: z.string(), archived: z.boolean() }).strict(),
      async ({ id, archived }) => {
        if (!engine) throw new Error('Sign in first.');
        return engine.archiveBackup(id, archived);
      },
    );
    ipc('backupNow', z.object({ id: z.string() }).strict(), async ({ id }) => {
      if (!engine) throw new Error('Sign in first.');
      return engine.backupNow(id);
    });
    ipc('selectSyncLocal', z.undefined(), async () => {
      if (!engine) throw new Error('Sign in first.');
      const selection = await dialog.showOpenDialog(window, {
        properties: ['openDirectory', 'createDirectory'],
        title: 'Choose the local folder to sync',
      });
      if (selection.canceled || !selection.filePaths[0]) return null;
      const localPath = await localDirectory(selection.filePaths[0]);
      const selectionId = crypto.randomUUID();
      if (localSelections.size >= 10) localSelections.delete(localSelections.keys().next().value!);
      localSelections.set(selectionId, localPath);
      return { selectionId, path: localPath, name: path.basename(localPath) };
    });
    ipc(
      'syncCloudFolders',
      z.object({ parentId: z.string().nullable(), cursor: z.string().optional() }).strict(),
      async (input) => {
        const [location, page] = await Promise.all([
          cloudLocation(api, input.parentId),
          api.list(input.parentId, input.cursor),
        ]);
        return {
          location,
          items: page.items.filter((item) => item.type === 'FOLDER'),
          nextCursor: page.nextCursor,
        };
      },
    );
    ipc(
      'addSyncRoot',
      z
        .object({
          selectionId: z.string().optional(),
          rootId: z.string().optional(),
          cloudFolderId: z.string().nullable().optional(),
          newFolderName: z.string().min(1).max(200).optional(),
          shareId: z.string().optional(),
        })
        .strict(),
      async (input) => {
        if (!engine) throw new Error('Sign in first.');
        const existing = input.rootId
          ? journal.roots().find((root) => root.id === input.rootId && root.mode === 'sync')
          : undefined;
        if (input.rootId && !existing) throw new Error('Sync folder was not found.');
        const selected = input.selectionId
          ? localSelections.get(input.selectionId)
          : existing?.localPath;
        if (!selected) throw new Error('Choose your local folder again.');
        const localPath = await localDirectory(selected);
        profiles.assertAvailable(localPath, journal);
        const automatic = input.cloudFolderId === undefined;
        const remoteId = automatic ? (existing?.remoteId ?? null) : input.cloudFolderId;
        const newFolderName =
          automatic && !remoteId
            ? path.basename(localPath).slice(0, 200) || 'Synced folder'
            : input.newFolderName;
        const shared = input.shareId
          ? await api.request(`/v1/sync/shares/${encodeURIComponent(input.shareId)}/status`)
          : undefined;
        if (shared && (input.rootId || input.newFolderName || remoteId !== shared.item.id))
          throw new Error('Choose the invited folder to start shared sync.');
        // Remembered so a later "stopped sharing" notice can name the owner.
        const owner: { displayName?: string } | undefined = shared
          ? (await api.request('/v1/sync/shares').catch(() => null))?.items?.find(
              (item: { id: string }) => item.id === shared.share.id,
            )?.owner
          : undefined;
        const parent = shared
          ? { path: `Shared with me / ${shared.item.name}` }
          : await cloudLocation(api, remoteId);
        if (!automatic && !newFolderName && !remoteId)
          throw new Error('Choose a cloud folder. My Drive itself cannot be selected.');
        const root: Root = {
          id: existing?.id ?? crypto.randomUUID(),
          localPath,
          remoteId,
          cloudPath: parent.path,
          ...(shared
            ? {
                shareId: shared.share.id,
                sharedBy: shared.share.ownerUserId,
                ...(owner?.displayName ? { sharedByName: owner.displayName } : {}),
              }
            : {}),
          mode: 'sync',
          paused: false,
          excluded: existing?.excluded ?? [],
        };
        // Validate local overlap before creating a cloud folder.
        engine.validateRoot({ ...root, remoteId: newFolderName ? '__new__' : root.remoteId });
        if (newFolderName) {
          // Only metadata persists; the sync relay releases file bytes after delivery.
          const operationId = input.selectionId || root.id;
          const result = await api
            .createFolder(newFolderName, remoteId, operationId)
            .catch(async (error) => {
              if (!automatic || !(error instanceof ApiError) || error.code !== 'NAME_CONFLICT')
                throw error;
              // Number the folder like a file manager would. Each attempt uses its own stable
              // operation so retries remain safe.
              for (let number = 2; ; number++) {
                const hash = createHash('sha256')
                  .update(`sync-folder:${operationId}:${number}`)
                  .digest('hex');
                const fallbackId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
                try {
                  return await api.createFolder(
                    `${newFolderName.slice(0, 190)} ${number}`,
                    remoteId,
                    fallbackId,
                  );
                } catch (numbered) {
                  if (
                    number >= 50 ||
                    !(numbered instanceof ApiError) ||
                    numbered.code !== 'NAME_CONFLICT'
                  )
                    throw numbered;
                }
              }
            });
          const { item } = result;
          root.remoteId = item.id;
          root.cloudPath = parent.path + ' / ' + item.name;
        }
        if (existing) await engine.updateRoot(root);
        else await engine.addRoot(root);
        if (input.selectionId) localSelections.delete(input.selectionId);
        return { id: root.id };
      },
    );
    ipc('removeSyncFolder', z.object({ folderId: z.string() }).strict(), async (input) => {
      if (!engine) throw new Error('Sign in first.');
      await engine.removeSyncedFolder(input.folderId);
      return { stopped: true };
    });
    ipc('stopSyncRoot', z.object({ id: z.string() }).strict(), async (input) => {
      if (!engine) throw new Error('Sign in first.');
      if (!journal.roots().some((root) => root.id === input.id && root.mode === 'sync'))
        throw new Error('Sync folder was not found.');
      const root = journal.roots().find((root) => root.id === input.id)!;
      if (root.shareId) await engine.removeRoot(root.id);
      else await engine.removeSyncedFolder(root.remoteId!);
      return { stopped: true };
    });
    ipc(
      'changeSyncLocal',
      z.object({ id: z.string(), selectionId: z.string() }).strict(),
      async (input) => {
        if (!engine) throw new Error('Sign in first.');
        const root = journal.roots().find((root) => root.id === input.id && root.mode === 'sync');
        const selected = localSelections.get(input.selectionId);
        if (!root || !selected) throw new Error('Choose the local folder again.');
        const localPath = await localDirectory(selected);
        profiles.assertAvailable(localPath, journal);
        await engine.updateRoot({
          ...root,
          localPath,
          paused: false,
        });
        localSelections.delete(input.selectionId);
        return { saved: true };
      },
    );
    ipc('reviewSyncConflict', z.object({ id: z.string() }).strict(), async (input) => {
      const issue = engine?.state.issues.find(
        (issue) => issue.id === input.id && stickyIssue(issue),
      );
      // A folder that stopped syncing has no root left; its notice holds the local folder itself.
      if (issue?.code === 'SYNC_DETACHED' && issue.conflictPath) {
        await stat(issue.conflictPath);
        const failed = await shell.openPath(issue.conflictPath);
        if (failed) throw new Error(failed);
        return { opened: true };
      }
      const root = journal.roots().find((root) => root.id === issue?.rootId);
      if (!root || !issue?.conflictPath) throw new Error('The preserved copy was not found.');
      const filename = contained(root.localPath, issue.conflictPath);
      await stat(filename);
      shell.showItemInFolder(contained(root.localPath, issue.conflictPath));
      return { opened: true };
    });
    ipc('dismissSyncConflict', z.object({ id: z.string() }).strict(), async (input) => {
      engine?.dismissConflict(input.id);
      return { saved: true };
    });
    ipc(
      'rootSettings',
      z
        .object({
          id: z.string(),
          paused: z.boolean(),
          excluded: z
            .array(
              z.string().refine((s) => !s.split(/[\\/]/).includes('..') && !path.isAbsolute(s)),
            )
            .max(1000),
        })
        .strict(),
      async (input) => {
        const root = journal.roots().find((r) => r.id === input.id);
        if (!root) throw new Error('Folder was not found.');
        if (!engine) throw new Error('Sign in first.');
        await engine.updateRoot({ ...root, paused: input.paused, excluded: input.excluded });
        return { saved: true };
      },
    );
    ipc('pause', z.object({ paused: z.boolean() }).strict(), async (i) => {
      engine?.pause(i.paused);
      return { paused: i.paused };
    });
    ipc(
      'upload',
      z
        .object({
          parentId: z.string().nullable(),
          recipient: z.string().optional(),
          // Files dropped from Finder; `folders` is the path inside a dropped folder.
          dropped: z
            .array(
              z
                .object({
                  path: z.string().refine((value) => path.isAbsolute(value)),
                  folders: z
                    .array(
                      z
                        .string()
                        .min(1)
                        .max(255)
                        .refine((name) => !/[\\/]/.test(name) && name !== '.' && name !== '..'),
                    )
                    .max(64),
                })
                .strict(),
            )
            .min(1)
            .max(10_000)
            .optional(),
        })
        .strict(),
      async (input) => {
        let files: { path: string; folders: string[] }[] | undefined = input.dropped;
        if (!files) {
          const selection = await dialog.showOpenDialog(window, {
            properties: ['openFile', 'multiSelections'],
          });
          if (selection.canceled) return { items: [] };
          files = selection.filePaths.map((filename) => ({ path: filename, folders: [] }));
        }
        const sizes: number[] = [];
        for (const { path: filename } of files) {
          const info = await stat(filename);
          if (!info.isFile()) throw new Error('Only files can be uploaded.');
          sizes.push(info.size);
        }
        // Progress goes to the window's upload card; each update carries only what changed.
        const batch = crypto.randomUUID();
        const uploads: FileUpload[] = files.map(({ path: filename, folders }, i) => ({
          key: `${batch}/${i}`,
          name: path.basename(filename),
          size: sizes[i],
          loaded: 0,
          phase: 'queued',
          ...(folders.length ? { group: { key: `${batch}/${folders[0]}`, name: folders[0] } } : {}),
        }));
        const send = (changed: FileUpload[]) => {
          if (!window.isDestroyed()) window.webContents.send('harbor:upload-progress', changed);
        };
        send(uploads);
        // Files going straight into the target folder are listed over WebDAV at once; those in
        // dropped folders once their folder exists.
        for (const [i, { path: filename, folders }] of files.entries())
          if (!folders.length)
            appUploads.set(uploads[i].key, {
              parentId: input.parentId,
              name: uploads[i].name,
              size: uploads[i].size,
              path: filename,
            });
        sendAppUploads();
        const items = [];
        // Folders created for this drop, keyed by their path under the drop target. A folder
        // that can't be created fails every file in it without retrying.
        const folderIds = new Map<string, Promise<string>>();
        for (const [i, { path: filename, folders }] of files.entries()) {
          const upload = uploads[i];
          const report = (change: Partial<FileUpload>) => send([Object.assign(upload, change)]);
          try {
            let parentId = input.parentId;
            let folderPath = '';
            for (const name of folders) {
              folderPath += '/' + name;
              if (!folderIds.has(folderPath)) {
                const pending = api.createFolder(name, parentId).then(({ item }) => item.id);
                pending.catch(() => {});
                folderIds.set(folderPath, pending);
              }
              parentId = await folderIds.get(folderPath)!;
            }
            if (folders.length) {
              appUploads.set(upload.key, {
                parentId,
                name: upload.name,
                size: upload.size,
                path: filename,
              });
              sendAppUploads();
            }
            report({ phase: 'hashing' });
            const key = 'manual-upload:' + createHash('sha256').update(filename).digest('hex');
            const state = journal.get<UploadState>(key) ?? { operationId: crypto.randomUUID() };
            const item = await uploadFile(
              api,
              filename,
              path.basename(filename),
              parentId,
              state,
              () => journal.set(key, state),
              undefined,
              (loaded) => report({ phase: 'uploading', loaded }),
            );
            journal.set(key, null);
            items.push(item);
            appUploads.delete(upload.key);
            webdav.landed(item);
            report({ phase: 'done', loaded: upload.size });
          } catch (error) {
            report({ phase: 'failed', error: (error as Error).message });
          } finally {
            if (appUploads.delete(upload.key)) sendAppUploads();
          }
        }
        const failed = files.length - items.length;
        if (failed)
          throw new Error(
            `${failed} of ${files.length} ${files.length === 1 ? 'file' : 'files'} couldn’t be uploaded.`,
          );
        if (input.recipient) {
          await api.request('/v1/transfers', {
            method: 'POST',
            body: {
              operationId: crypto.randomUUID(),
              recipient: {
                type:
                  input.recipient.includes('@') && !input.recipient.startsWith('@')
                    ? 'EMAIL'
                    : 'USERNAME',
                value: input.recipient.replace(/^@/, ''),
              },
              items: items.map((item) => ({ driveItemId: item.id })),
            },
          });
          notify('Files sent', 'The transfer has been created.');
        }
        return { items };
      },
    );
    ipc(
      'download',
      z
        .object({
          name: z.string(),
          folder: z.boolean().optional(),
          driveItemId: z.string().optional(),
          versionId: z.string().optional(),
          transferId: z.string().optional(),
          entryId: z.string().optional(),
        })
        .strict(),
      async (input) => {
        if (
          input.folder &&
          (!input.driveItemId || input.versionId || input.transferId || input.entryId)
        )
          throw new Error('Choose a folder from your drive to download.');
        const selection = await dialog.showSaveDialog(window, {
          defaultPath: input.folder
            ? path.join(
                app.getPath('downloads'),
                safeSegment(input.name, crypto.randomUUID()) + '.zip',
              )
            : safeSegment(input.name, crypto.randomUUID()),
          title: input.folder ? 'Save folder as ZIP' : 'Save file',
          ...(input.folder ? { filters: [{ name: 'ZIP archive', extensions: ['zip'] }] } : {}),
        });
        if (selection.canceled || !selection.filePath) return null;
        const { name: _, folder: _folder, ...download } = input;
        if (input.folder) {
          try {
            await downloadFolderZip(
              api,
              { id: input.driveItemId!, name: input.name },
              selection.filePath,
              (progress) => {
                if (!window.isDestroyed())
                  window.webContents.send('harbor:zip-progress', { name: input.name, ...progress });
              },
            );
          } finally {
            if (!window.isDestroyed()) window.webContents.send('harbor:zip-progress', null);
          }
        } else await downloadFile(api, download, selection.filePath);
        return { saved: true };
      },
    );
    ipc('openSyncedItem', z.object({ itemId: z.string() }).strict(), async (input) => {
      for (const root of journal.roots().filter((r) => r.mode === 'sync')) {
        const file = journal.fileByItem(root.id, input.itemId);
        if (!file) continue;
        const full = await safeParents(root.localPath, file.relativePath);
        const error = await shell.openPath(full);
        if (error) throw new Error(error);
        return {};
      }
      throw new Error(
        'This device does not have a local copy yet. Link the folder and wait for syncing to finish.',
      );
    });
    ipc('reveal', z.object({ rootId: z.string() }).strict(), async (input) => {
      const root = journal.roots().find((r) => r.id === input.rootId);
      if (!root) throw new Error('Unknown folder.');
      const error = await shell.openPath(root.localPath);
      if (error) throw new Error(error);
      return {};
    });
    ipc('diagnostics', z.undefined(), async () => {
      const selection = await dialog.showSaveDialog(window, {
        defaultPath: 'harbor-diagnostics.json',
      });
      if (selection.canceled || !selection.filePath) return null;
      await writeFile(
        selection.filePath,
        JSON.stringify(
          {
            version: app.getVersion(),
            platform: process.platform,
            sync: engine?.state
              ? {
                  running: engine.state.running,
                  paused: engine.state.paused,
                  online: engine.state.online,
                  lastSync: engine.state.lastSync,
                }
              : null,
            queued: journal.jobCount(),
            failing: journal.jobSummary().filter((j) => j.error).length,
            roots: (accountReady ? journal.roots() : []).map((r) => ({
              mode: r.mode,
              paused: r.paused,
            })),
          },
          null,
          2,
        ),
      );
      return { saved: true };
    });
    updater = new Updater({
      current: app.getVersion(),
      bundle: runningBundle(app.isPackaged, process.platform, process.execPath),
      arch: process.arch,
      onChange: (status) => {
        if (!window.isDestroyed()) window.webContents.send('harbor:update', status);
      },
      // Sync stops cleanly first so the journal is saved before the app is replaced.
      quit: async () => {
        quitting = true;
        await engine?.stop();
        setImmediate(() => app.quit());
      },
    });
    updater.start();
    ipc('webdav', z.undefined(), async () => webdavView());
    ipc('setWebdav', z.object({ enabled: z.boolean() }).strict(), async ({ enabled }) => {
      webdavSettings = { ...webdavSettings, enabled };
      await writeWebdavSettings(webdavSettings);
      webdavError = null;
      await webdavTask(enabled ? startWebdav : stopWebdav);
      return webdavView();
    });
    ipc('openWebdavDrive', z.undefined(), async () => {
      await webdavTask(async () => {
        if (!webdav.running || !webdavPasswordShown) throw new Error('Turn on the server first.');
        const url = webdavUrl(webdavSettings.port);
        webdavMount =
          process.platform === 'win32'
            ? await mapInExplorer(url.replace('/harbor0/', `/${webdavMountSecret}/harbor0/`))
            : await mountInFinder({
                url,
                username: WEBDAV_USERNAME,
                password: webdavPasswordShown,
                mountPoint: webdavMountPoint(),
              });
      });
      sendWebdav();
      revealMount(webdavMount!);
      return webdavView();
    });
    ipc('disconnectWebdavDrive', z.undefined(), async () => {
      await webdavTask(disconnectWebdav);
      return webdavView();
    });
    ipc('copyText', z.object({ text: z.string().max(10_000) }).strict(), async ({ text }) => {
      clipboard.writeText(text);
    });
    ipc('updateStatus', z.undefined(), async () => updater!.status);
    ipc('checkForUpdate', z.undefined(), () => updater!.check());
    ipc('installUpdate', z.undefined(), async () => {
      await updater!.install();
      return { restarting: true };
    });
    ipc(
      'e2eeUnlock',
      z.union([
        z.object({ passphrase: z.string().min(1).max(1024) }).strict(),
        z
          .object({
            recovery: z.string().min(1).max(200),
            passphrase: z.string().min(12).max(1024),
          })
          .strict(),
      ]),
      async (input: { passphrase: string; recovery?: string }) => {
        try {
          if (input.recovery !== undefined) {
            const recovery = parseRecoveryKey(input.recovery);
            if (!recovery) throw new Error('Enter all 8 groups of your recovery key.');
            await vault.unlockWithRecovery(api.request, recovery, input.passphrase);
          } else await vault.unlockWithPassphrase(api.request, input.passphrase);
        } catch (error) {
          if (error instanceof E2eeError && error.code === 'WRONG_KEY')
            throw new Error(
              input.recovery !== undefined
                ? 'That recovery key isn’t right. Check it and try again.'
                : 'That passphrase isn’t right. Check it and try again.',
            );
          throw error;
        }
        return { unlocked: true };
      },
    );
    // The account's encryption for Settings; the wrapped keys stay out of the window.
    ipc('e2eeDetails', z.undefined(), async () => {
      const { e2ee } = await api.request('/v1/e2ee');
      const { passphrase: _passphrase, recovery, ...details } = e2ee;
      return {
        ...details,
        recoveryKey: !!recovery,
        thisDevice: vault.deviceRecord ?? null,
        locked: vault.locked,
      };
    });
    ipc('e2eeLock', z.undefined(), async () => {
      await vault.lock(api.request);
      return { locked: true };
    });
    ipc('logout', z.undefined(), async () => {
      await engine?.stop();
      await webdavTask(revokeWebdavKey);
      // Signing out removes this computer's copy of the encryption key, here and on the server.
      await vault.lock(api.request).catch(() => {});
      vault.reset();
      encryptedPreviews.clear();
      pdfPreviews.clear();
      try {
        await api.request('/v1/auth/logout', {
          method: 'POST',
          body: { refreshToken: session.refreshToken },
        });
      } finally {
        await session.invalidate();
      }
      return { loggedOut: true };
    });
    // Incoming transfers and invitations: every 10s while the window is focused,
    // every 60s in the background, and immediately on focus or wake.
    const pollIncoming = async () => {
      clearTimeout(incomingTimer);
      await incomingMonitor?.poll();
      // A focus during the request also reschedules; keep a single timer.
      clearTimeout(incomingTimer);
      if (!quitting)
        incomingTimer = setTimeout(() => void pollIncoming(), window.isFocused() ? 10_000 : 60_000);
    };
    void pollIncoming();
    const wake = () => {
      engine?.wake();
      void pollIncoming();
    };
    powerMonitor.on('resume', wake);
    window.on('focus', wake);
    app.on('activate', () => window.show());
    await window.loadFile(rendererPath);
    // `npm run dev` touches this stamp after each renderer rebuild.
    if (!app.isPackaged && process.env.HARBOR_DEV_RELOAD)
      watch(__dirname, (_, file) => {
        if (file === '.reload') window.webContents.reloadIgnoringCache();
      });
    webdavSettings = await readWebdavSettings();
    authTransition = true;
    try {
      const saved = await readSavedSession();
      if (saved) {
        await session.restore(saved);
        await connected();
      }
    } catch (error) {
      if (error instanceof SyntaxError || isSessionError(error)) await session.invalidate();
      // Missing or unreadable credentials leave the app on its login page.
      // Network failures preserve the saved session so renewal can be retried.
    } finally {
      authTransition = false;
    }
  })
  .catch((error) => {
    console.error(
      JSON.stringify({ event: 'desktop_start_failed', message: (error as Error).message }),
    );
    app.quit();
  });
app.on('before-quit', () => {
  quitting = true;
  updater?.stop();
  clearTimeout(incomingTimer);
  live?.stop();
  incomingMonitor?.stop();
  void engine?.stop();
  // Finder would otherwise wait on a server that's gone.
  if (webdavMount) unmountNow(webdavMount);
  webdav.kill();
});
app.on('window-all-closed', () => {
  /* The tray keeps sync alive. */
});
