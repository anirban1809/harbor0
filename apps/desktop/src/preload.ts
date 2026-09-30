import { contextBridge, ipcRenderer, webUtils } from 'electron';
const channels = [
  'status',
  'testNotification',
  'notificationSettings',
  'login',
  'request',
  'chooseRoot',
  'backupNow',
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
contextBridge.exposeInMainWorld('harbor', {
  ...bridge,
  onIncoming: (callback: (content: unknown) => void) => {
    const listener = (_: unknown, content: unknown) => callback(content);
    ipcRenderer.on('harbor:incoming', listener);
    return () => ipcRenderer.removeListener('harbor:incoming', listener);
  },
  uploadDropped: async ({ files, parentId }: { files: File[]; parentId: string | null }) => {
    const paths = files.map((file) => webUtils.getPathForFile(file)).filter(Boolean);
    if (!paths.length) throw new Error('Drop files from your computer to upload them.');
    const result = await ipcRenderer.invoke('harbor:upload', { parentId, paths });
    if (!result.ok) throw new Error(result.error);
    return result.data;
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
