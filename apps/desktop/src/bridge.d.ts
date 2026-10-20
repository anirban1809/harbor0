export {};
/** A two-step sign-in either moves on or fails with a message; a wrong code returns its session. */
type TwoFactorStep = {
  twoFactor?: import('@harbor/contracts').TwoFactorChallenge;
  failed?: { code?: string; message: string; session?: string };
};
/** The local WebDAV server, as Settings shows it. */
type WebdavState = {
  enabled: boolean;
  running: boolean;
  /** End-to-end encrypted: served from inside the app, which decrypts on this computer. */
  encrypted: boolean;
  url: string;
  username: string;
  /** Shown only while the server runs. */
  password: string | null;
  /** Connected in Finder or File Explorer; undefined where neither exists. */
  mount?: { kind: 'finder' | 'explorer'; location: string } | null;
  error: string | null;
  /** How to start it from a terminal; null for encrypted accounts, which can't. */
  command: string | null;
};
declare global {
  interface Window {
    harbor: {
      openSyncedItem: (input: { itemId: string }) => Promise<unknown>;
      status: () => Promise<any>;
      testNotification: () => Promise<{ shown: boolean }>;
      notificationSettings: () => Promise<void>;
      /** Unlocks an encrypted account here: the passphrase, or the recovery key and a new one. */
      e2eeUnlock: (
        input: { passphrase: string } | { recovery: string; passphrase: string },
      ) => Promise<{ unlocked: true }>;
      openAccountPage: (input: {
        page: 'signup' | 'forgot' | 'drive' | 'settings';
      }) => Promise<void>;
      /** The account's encryption for Settings, without its wrapped keys. */
      e2eeDetails: () => Promise<
        Omit<import('@harbor/contracts').E2eeState, 'passphrase' | 'recovery'> & {
          recoveryKey: boolean;
          thisDevice: string | null;
          locked: boolean;
        }
      >;
      /** Forgets the key on this computer; it needs the passphrase again. */
      e2eeLock: () => Promise<{ locked: true }>;
      /** Signs in, or returns the account's two-step challenge to finish with loginVerify. */
      login: (input: {
        email: string;
        password: string;
      }) => Promise<{ twoFactor?: import('@harbor/contracts').TwoFactorChallenge }>;
      loginMethod: (input: {
        email: string;
        session: string;
        method: import('@harbor/contracts').TwoFactorMethod;
      }) => Promise<TwoFactorStep>;
      loginVerify: (input: {
        email: string;
        session: string;
        method: import('@harbor/contracts').TwoFactorMethod;
        code: string;
      }) => Promise<TwoFactorStep>;
      request: (input: { path: string; method?: string; body?: unknown }) => Promise<any>;
      disconnectBackup: (input: { id: string }) => Promise<{ disconnected: boolean }>;
      backupNow: (input: { id: string }) => Promise<{ queued: boolean; changes: number }>;
      archiveBackup: (input: { id: string; archived: boolean }) => Promise<{ queued: boolean }>;
      chooseRoot: (input: { mode: 'sync' | 'backup' }) => Promise<any>;
      rootSettings: (input: { id: string; paused: boolean; excluded: string[] }) => Promise<any>;
      selectSyncLocal: () => Promise<{ selectionId: string; path: string; name: string } | null>;
      syncCloudFolders: (input: { parentId: string | null; cursor?: string }) => Promise<{
        location: import('./sync-mapping').CloudLocation;
        items: import('@harbor/contracts').DriveItem[];
        nextCursor: string | null;
      }>;
      addSyncRoot: (input: {
        selectionId?: string;
        rootId?: string;
        cloudFolderId?: string | null;
        newFolderName?: string;
        shareId?: string;
      }) => Promise<any>;
      removeSyncFolder: (input: { folderId: string }) => Promise<unknown>;
      stopSyncRoot: (input: { id: string }) => Promise<any>;
      changeSyncLocal: (input: { id: string; selectionId: string }) => Promise<any>;
      reviewSyncConflict: (input: { id: string }) => Promise<any>;
      dismissSyncConflict: (input: { id: string }) => Promise<any>;
      pause: (input: { paused: boolean }) => Promise<any>;
      uploadDropped: (input: {
        entries: { file: File; folders: string[] }[];
        parentId: string | null;
      }) => Promise<any>;
      upload: (input: { parentId: string | null; recipient?: string }) => Promise<any>;
      previewText: (input: {
        driveItemId: string;
      }) => Promise<{ text: string; truncated: boolean }>;
      previewPdf: (input: { driveItemId: string }) => Promise<{ size: number }>;
      previewRange: (input: {
        driveItemId: string;
        begin: number;
        end: number;
      }) => Promise<Uint8Array>;
      pdfAsset: (input: { path: string }) => Promise<Uint8Array>;
      download: (input: {
        name: string;
        folder?: boolean;
        driveItemId?: string;
        versionId?: string;
        transferId?: string;
        entryId?: string;
      }) => Promise<any>;
      reveal: (input: { rootId: string }) => Promise<any>;
      diagnostics: () => Promise<any>;
      logout: () => Promise<any>;
      updateStatus: () => Promise<import('./updater').UpdateStatus>;
      checkForUpdate: () => Promise<import('./updater').UpdateStatus>;
      /** Downloads and installs the available update, then restarts the app. */
      installUpdate: () => Promise<{ restarting: boolean }>;
      /** Restarts into the update downloaded in the background. */
      restartToUpdate: () => Promise<{ restarting: boolean }>;
      webdav: () => Promise<WebdavState>;
      setWebdav: (input: { enabled: boolean }) => Promise<WebdavState>;
      /** Connects the server as a drive in Finder or File Explorer and opens it. */
      openWebdavDrive: () => Promise<WebdavState>;
      disconnectWebdavDrive: () => Promise<WebdavState>;
      copyText: (input: { text: string }) => Promise<void>;
      /** The folder the window shows, so the sync status lists only its pending items. */
      viewFolder: (input: { id: string | null }) => Promise<void>;
      onWebdav: (callback: (state: WebdavState) => void) => () => void;
      onUpdate: (callback: (status: import('./updater').UpdateStatus) => void) => () => void;
      onStatus: (callback: (state: any) => void) => () => void;
      /** Live updates connection changes and pushed hints to refresh. */
      onLive: (
        callback: (event: { connected: boolean; type?: 'changes' | 'notification' }) => void,
      ) => () => void;
      onIncoming: (callback: (content: import('./incoming').IncomingContent) => void) => () => void;
      onUploadProgress: (
        callback: (uploads: import('../../web/lib/upload-activity').FileUpload[]) => void,
      ) => () => void;
      onZipProgress: (
        callback: (
          progress:
            | (import('../../../packages/api-client/src/archive-download').FolderDownloadProgress & {
                name: string;
              })
            | null,
        ) => void,
      ) => () => void;
      onSend: (callback: () => void) => () => void;
      onAuthenticated: (callback: () => void) => () => void;
      onSignedOut: (callback: (reason: string | null) => void) => () => void;
    };
  }
}
