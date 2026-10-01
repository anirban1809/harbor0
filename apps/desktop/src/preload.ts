import { contextBridge, ipcRenderer, webUtils } from 'electron';
const channels = [
  'status',
  'testNotification',
  'notificationSettings',
  'openAccountPage',
  'login',
  'request',
  'chooseRoot',
  'backupNow',
  'archiveBackup',
  'disconnectBackup',
  'selectSyncLocal',
  'syncCloudFolders',
  'addSyncRoot',
  'stopSyncRoot',
  'removeSyncFolder',
  'changeSyncLocal',
  'reviewSyncConflict',
  'dismissSyncConflict',
  'rootSettings',
  'pause',
  'upload',
  'download',
  'previewText',
  'reveal',
  'openSyncedItem',
  'diagnostics',
  'logout',
] as const;
const bridge = Object.fromEntries(
  channels.map((name) => [
    name,
    async (input?: unknown) => {
      const result = await ipcRenderer.invoke('harbor:' + name, input);
      if (!result.ok) throw new Error(result.error);
      return result.data;
    },
  ]),
);
window.addEventListener('DOMContentLoaded', () => {
  document.documentElement.classList.add(`platform-${process.platform}`);
});
contextBridge.exposeInMainWorld('harbor', {
  ...bridge,
  onIncoming: (callback: (content: unknown) => void) => {
    const listener = (_: unknown, content: unknown) => callback(content);
    ipcRenderer.on('harbor:incoming', listener);
    return () => ipcRenderer.removeListener('harbor:incoming', listener);
  },
  uploadDropped: async ({
    entries,
    parentId,
  }: {
    entries: { file: File; folders: string[] }[];
    parentId: string | null;
  }) => {
    const dropped = entries
      .map(({ file, folders }) => ({ path: webUtils.getPathForFile(file), folders }))
      .filter((entry) => entry.path);
    if (!dropped.length) throw new Error('Drop files from your computer to upload them.');
    const result = await ipcRenderer.invoke('harbor:upload', { parentId, dropped });
    if (!result.ok) throw new Error(result.error);
    return result.data;
  },
  onUploadProgress: (callback: (uploads: unknown) => void) => {
    const listener = (_: unknown, uploads: unknown) => callback(uploads);
    ipcRenderer.on('harbor:upload-progress', listener);
    return () => ipcRenderer.removeListener('harbor:upload-progress', listener);
  },
  onZipProgress: (callback: (progress: unknown) => void) => {
    const listener = (_: unknown, progress: unknown) => callback(progress);
    ipcRenderer.on('harbor:zip-progress', listener);
    return () => ipcRenderer.removeListener('harbor:zip-progress', listener);
  },
  onStatus: (callback: (state: unknown) => void) => {
    const listener = (_: unknown, state: unknown) => callback(state);
    ipcRenderer.on('harbor:status', listener);
    return () => ipcRenderer.removeListener('harbor:status', listener);
  },
  onLive: (callback: (event: unknown) => void) => {
    const listener = (_: unknown, event: unknown) => callback(event);
    ipcRenderer.on('harbor:live', listener);
    return () => ipcRenderer.removeListener('harbor:live', listener);
  },
  onAuthenticated: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('harbor:authenticated', listener);
    return () => ipcRenderer.removeListener('harbor:authenticated', listener);
  },
  onSignedOut: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('harbor:signed-out', listener);
    return () => ipcRenderer.removeListener('harbor:signed-out', listener);
  },
});
