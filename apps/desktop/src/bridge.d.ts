export {};
declare global {
  interface Window {
    harbor: {
      openSyncedItem: (input: { itemId: string }) => Promise<unknown>;
      status: () => Promise<any>;
      login: (input: { email: string; password: string }) => Promise<any>;
      request: (input: { path: string; method?: string; body?: unknown }) => Promise<any>;
      backupNow: (input: { id: string }) => Promise<{ queued: boolean }>;
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
      uploadDropped: (input: { files: File[]; parentId: string | null }) => Promise<any>;
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
      onSignedOut: (callback: () => void) => () => void;
    };
  }
}
