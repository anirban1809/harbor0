export {};
/** A two-step sign-in either moves on or fails with a message; a wrong code returns its session. */
type TwoFactorStep = {
  twoFactor?: import('@harbor/contracts').TwoFactorChallenge;
  failed?: { code?: string; message: string; session?: string };
};
declare global {
  interface Window {
    harbor: {
      openSyncedItem: (input: { itemId: string }) => Promise<unknown>;
      status: () => Promise<any>;
      testNotification: () => Promise<{ shown: boolean }>;
      notificationSettings: () => Promise<void>;
      openAccountPage: (input: { page: 'signup' | 'forgot' }) => Promise<void>;
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
      onAuthenticated: (callback: () => void) => () => void;
      onSignedOut: (callback: (reason: string | null) => void) => () => void;
    };
  }
}
