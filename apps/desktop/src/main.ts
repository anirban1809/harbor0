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
} from 'electron';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, chmod, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { rendererRequestSchema } from './request-schema';
import { ApiClient, ApiError, createTransport, SESSION_DURATION_SECONDS } from '@harbor/api-client';
import { Journal, type Root } from './journal';
import { AccountProfiles } from './account-profiles';
import { SyncEngine } from './sync';
import { syncView } from './sync-view';
import type { SyncRuntime } from './sync-state';
import { uploadFile, downloadFile, downloadFolderZip, type UploadState } from './transfers';
import { contained, safeSegment, safeParents } from './paths';
import {
  desktopConfiguration,
  loadDesktopEnvironment,
  loadBundledDesktopConfiguration,
} from './config';
import { DesktopSession, isSessionError } from './session';
import { cloudLocation, localDirectory } from './sync-mapping';
// Keep existing credentials and sync state when the display name changes.
const legacyDataPath = app.isPackaged
  ? path.join(app.getPath('appData'), 'Harbor')
  : app.getPath('userData');
const userDataPath = existsSync(legacyDataPath) ? legacyDataPath : app.getPath('userData');
app.setName('harbor0');
app.setPath('userData', userDataPath);
// Development launches load public connection settings beside package.json.
// Packaged applications load public release settings, with shell overrides.
if (!app.isPackaged) loadDesktopEnvironment(path.resolve(__dirname, '..'), process.env);
else loadBundledDesktopConfiguration(__dirname, process.env);
const { development, apiUrl, configured, configurationError } = desktopConfiguration(
  process.env,
  app.isPackaged,
);
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
const localSelections = new Map<string, string>();
const rendererPath = path.join(__dirname, 'renderer/index.html');
const securePath = () => path.join(app.getPath('userData'), 'credentials.bin');
const session = new DesktopSession({
  async persist(saved) {
    if (
      !safeStorage.isEncryptionAvailable() ||
      (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')
    )
      throw new Error(
        'Enable an OS keychain before signing in. harbor0 will not store unencrypted credentials.',
      );
    await writeFile(securePath(), safeStorage.encryptString(JSON.stringify(saved)), {
      mode: 0o600,
    });
    await chmod(securePath(), 0o600);
  },
  clear: () => rm(securePath(), { force: true }),
  signedOut() {
    const previous = engine;
    engine = undefined;
    accountReady = false;
    localSelections.clear();
    stoppingSync = Promise.all([stoppingSync, previous?.stop()]).then(() => {});
    window?.webContents.send('harbor:signed-out');
  },
  async renew(refreshToken) {
    if (!configured) throw new Error(configurationError);
    const response = await fetch(apiUrl + '/v1/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    const data = await response.json();
    if (!response.ok)
      throw new ApiError(
        data.error?.code ?? 'REQUEST_FAILED',
        data.error?.message ?? 'Could not renew your session. Try again.',
        response.status,
      );
    return data;
  },
});
const transport = createTransport(
  apiUrl,
  () => session.token(),
  () => session.refresh(),
);
const api = new ApiClient(async (endpoint, init) => {
  try {
    return await transport(endpoint, init);
  } catch (error) {
    if (isSessionError(error)) await session.invalidate();
    throw error;
  }
});
async function connected() {
  const { user } = await api.me();
  journal = profiles.select(user.id);
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
      devicePublicId: journal.devicePublicId(),
      appVersion: app.getVersion(),
    },
  });
  journal.set('deviceId', response.device.id);
  journal.set('deviceName', response.device.name ?? os.hostname());
  for (const root of journal.roots()) {
    try {
      journal.root({ ...root, cloudPath: (await cloudLocation(api, root.remoteId)).path });
    } catch {
      /* Keep the last known cloud location while offline. */
    }
  }
  journal.set('publicId', response.device.devicePublicId);
  await engine?.stop();
  const activeJournal = journal;
  engine = new SyncEngine(api, activeJournal, response.device.id, (state) => {
    if (accountReady && journal === activeJournal)
      window?.webContents.send('harbor:status', syncView(activeJournal, state as SyncRuntime));
  });
  engine.state.paused = journal.get<boolean>('paused') ?? false;
  await engine.start();
  accountReady = true;
  window?.webContents.send('harbor:authenticated');
  return { user };
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    window?.show();
    window?.focus();
  });
}
function ipc(name: string, schema: z.ZodType, handler: (input: any) => Promise<unknown>) {
  ipcMain.handle('harbor:' + name, async (event, input) => {
    if (
      event.sender !== window.webContents ||
      event.senderFrame?.url !== pathToFileURL(rendererPath).href
    )
      throw new Error('Untrusted IPC sender.');
    const authentication = name === 'login' || name === 'logout';
    let operation: Promise<unknown> | undefined;
    let ownsTransition = false;
    try {
      const parsed = schema.parse(input);
      if (authentication) {
        if (authTransition) throw new Error('An account change is already in progress.');
        if (name === 'login' && accountReady)
          throw new Error('Sign out before using another account.');
        authTransition = true;
        ownsTransition = true;
        // Old requests and sync work must finish before credentials or journals change.
        await Promise.allSettled([...operations]);
        await stoppingSync;
      } else if (name !== 'status' && (authTransition || !accountReady)) {
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
    notification.show();
  }
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
      backgroundColor: '#f8faf9',
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
        development,
        signedIn: session.signedIn && accountReady,
        roots: (accountReady ? journal.roots() : []).map((r) => ({
          ...r,
          ...journal.fileCounts(r.id),
          localPathDisplayName: path.basename(r.localPath),
          localPathDisplay: r.localPath.startsWith(os.homedir() + path.sep)
            ? '~' + r.localPath.slice(os.homedir().length)
            : r.localPath,
        })),
        sync: engine ? syncView(journal, engine.state) : { message: 'Sign in to start syncing' },
        jobs: (accountReady ? journal.jobs() : []).map((j) => ({
          id: j.id,
          rootId: j.rootId,
          relativePath: j.relativePath,
          kind: j.kind,
          error: j.error,
          attempts: j.attempts,
        })),
        deviceName: journal.get('deviceName') ?? os.hostname(),
        deviceId: accountReady ? journal.get('deviceId') : undefined,
        accountId: accountReady ? journal.get('accountId') : null,
      };
    });
    ipc(
      'login',
      z.object({ email: z.email(), password: z.string().min(1).max(256) }).strict(),
      async (input) => {
        if (!configured) throw new Error(configurationError);
        const response = await fetch(apiUrl + '/v1/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...input,
            deviceName: os.hostname(),
            platform:
              process.platform === 'darwin'
                ? 'MACOS'
                : process.platform === 'win32'
                  ? 'WINDOWS'
                  : 'LINUX',
          }),
        });
        const data = (await response.json()) as any;
        if (!response.ok)
          throw new Error(data.error?.message ?? 'Could not sign in. Please try again.');
        await session.signIn(data);
        try {
          return await connected();
        } catch (error) {
          await session.invalidate();
          throw error;
        }
      },
    );
    ipc('request', rendererRequestSchema, async (input) =>
      api.request(input.path, { method: input.method, body: input.body }),
    );
    ipc(
      'previewText',
      z.object({ driveItemId: z.string().min(1).max(256) }).strict(),
      async (input) => {
        const result = await api.download(input);
        return fetchTextPreview(result.downloadUrl, result.sizeBytes, AbortSignal.timeout(30_000));
      },
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
      const localPath = await localDirectory(selection.filePaths[0]);
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
          ...(shared ? { shareId: shared.share.id, sharedBy: shared.share.ownerUserId } : {}),
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
              // Use a separate, stable operation for the collision fallback so retries remain safe.
              const hash = createHash('sha256').update(`sync-folder:${operationId}`).digest('hex');
              const fallbackId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
              return api.createFolder(
                `${newFolderName.slice(0, 155)} (${operationId})`,
                remoteId,
                fallbackId,
              );
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
        (issue) => issue.id === input.id && issue.code === 'CONFLICT',
      );
      const root = journal.roots().find((root) => root.id === issue?.rootId);
      if (!root || !issue?.conflictPath) throw new Error('Conflict was not found.');
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
          paths: z
            .array(z.string().refine((value) => path.isAbsolute(value)))
            .min(1)
            .max(1000)
            .optional(),
        })
        .strict(),
      async (input) => {
        const selection = input.paths
          ? { canceled: false, filePaths: input.paths }
          : await dialog.showOpenDialog(window, {
              properties: ['openFile', 'multiSelections'],
            });
        if (selection.canceled) return { items: [] };
        const items = [];
        for (const filename of selection.filePaths) {
          if (!(await stat(filename)).isFile())
            throw new Error('Drop individual files, or use Sync to upload a folder.');
          const key = 'manual-upload:' + createHash('sha256').update(filename).digest('hex');
          const state = journal.get<UploadState>(key) ?? { operationId: crypto.randomUUID() };
          const item = await uploadFile(
            api,
            filename,
            path.basename(filename),
            input.parentId,
            state,
            () => journal.set(key, state),
          );
          journal.set(key, null);
          items.push(item);
        }
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
      await shell.openPath(root.localPath);
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
            queued: journal.jobs().map((j) => ({ kind: j.kind, attempts: j.attempts })),
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
    ipc('logout', z.undefined(), async () => {
      await engine?.stop();
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
    powerMonitor.on('resume', () => void engine?.tick());
    app.on('activate', () => window.show());
    await window.loadFile(rendererPath);
    authTransition = true;
    try {
      if (safeStorage.isEncryptionAvailable()) {
        const saved = JSON.parse(safeStorage.decryptString(await readFile(securePath())));
        // Older installations stored only the refresh token. Keep its provider
        // expiry and bound the migrated local session by the file's timestamp.
        const expiresAt =
          saved.expiresAt ?? (await stat(securePath())).mtimeMs + SESSION_DURATION_SECONDS * 1000;
        await session.restore({ refreshToken: saved.refreshToken, expiresAt });
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
  void engine?.stop();
});
app.on('window-all-closed', () => {
  /* The tray keeps sync alive. */
});
