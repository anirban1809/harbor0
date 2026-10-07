import type {
  DriveItem,
  StorageUsage,
  FlagStates,
  User,
  UploadInput,
  CompletedPart,
  SyncChange,
  StorageAuditRow,
} from '@harbor/contracts';
export type { paths } from './generated';
export { proxyBrowserRequest } from './session-proxy';
export { SESSION_DURATION_SECONDS } from './session';
export { LiveUpdates, LIVE_PING_MS, type LiveMessage } from './live-updates';
export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
    public requestId?: string,
    public details?: unknown,
  ) {
    super(message);
  }
}
export type Transport = (
  path: string,
  init?: { method?: string; body?: unknown; signal?: AbortSignal },
) => Promise<any>;
export function createTransport(
  baseUrl: string,
  token?: () => Promise<string>,
  refresh?: () => Promise<void>,
): Transport {
  return async (path, init = {}) => {
    const call = async () =>
      fetch(baseUrl + path, {
        method: init.method ?? 'GET',
        headers: {
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          ...(token ? { Authorization: `Bearer ${await token()}` } : {}),
        },
        body: init.body ? JSON.stringify(init.body) : undefined,
        signal: init.signal,
      });
    let response = await call();
    if (response.status === 401 && refresh) {
      await refresh();
      response = await call();
    }
    // A gateway or proxy in front of the API can answer with an HTML error page instead.
    const text = await response.text();
    let json: any;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = undefined;
    }
    const error = json?.error;
    if (!response.ok && error?.code)
      throw new ApiError(
        error.code,
        error.message ?? 'The request failed.',
        response.status,
        error.requestId,
        error.details,
      );
    if (!response.ok && response.status < 500)
      throw new ApiError('REQUEST_FAILED', 'The request failed.', response.status);
    if (!response.ok || json === undefined)
      throw new ApiError(
        'BACKEND_UNAVAILABLE',
        'harbor0 is temporarily unavailable. Try again in a moment.',
        response.ok ? 502 : response.status,
      );
    return json;
  };
}
export class ApiClient {
  constructor(public request: Transport) {}
  me(): Promise<{ user: User; storage: StorageUsage; flags: FlagStates }> {
    return this.request('/v1/users/me');
  }
  storageAuditPage(
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<{ rows: StorageAuditRow[]; storage: StorageUsage; nextCursor: string | null }> {
    return this.request(
      `/v1/storage/audit?limit=200${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`,
      { signal },
    );
  }
  list(
    parentId: string | null = null,
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<{ items: DriveItem[]; nextCursor: string | null }> {
    return this.request(
      `/v1/drive/folders/${parentId ? encodeURIComponent(parentId) : 'root'}/children${cursor ? '?cursor=' + encodeURIComponent(cursor) : ''}`,
      { signal },
    );
  }
  createFolder(
    name: string,
    parentId: string | null = null,
    operationId: string = crypto.randomUUID(),
  ): Promise<{ item: DriveItem }> {
    return this.request('/v1/drive/folders', {
      method: 'POST',
      body: { name, parentId, operationId },
    });
  }
  async emptyTrash(): Promise<void> {
    let cursor: string | undefined;
    do {
      const page: { nextCursor: string | null } = await this.request('/v1/drive/trash/empty', {
        method: 'POST',
        body: { ...operation(), ...(cursor ? { cursor } : {}) },
      });
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
  }
  createUpload(input: UploadInput): Promise<{
    upload: { id: string; state: string; partSizeBytes: number; expiresAt: string };
    storage: StorageUsage;
  }> {
    return this.request('/v1/uploads', { method: 'POST', body: input });
  }
  parts(
    id: string,
    partNumbers: number[],
  ): Promise<{ parts: { partNumber: number; uploadUrl: string; expiresAt: string }[] }> {
    return this.request(`/v1/uploads/${id}/parts`, { method: 'POST', body: { partNumbers } });
  }
  complete(id: string, parts: CompletedPart[], contentHash: string): Promise<{ item: DriveItem }> {
    return this.request(`/v1/uploads/${id}/complete`, {
      method: 'POST',
      body: { parts, contentHash },
    });
  }
  download(
    input: {
      folderDownloadId?: string;
      driveItemId?: string;
      versionId?: string;
      transferId?: string;
      entryId?: string;
    },
    signal?: AbortSignal,
  ): Promise<{ downloadUrl: string; sizeBytes: number; contentHash: string }> {
    return this.request('/v1/downloads', { method: 'POST', body: input, signal });
  }
  changes(
    cursor: number,
  ): Promise<{ changes: SyncChange[]; nextCursor: number; hasMore: boolean }> {
    return this.request(`/v1/sync/changes?cursor=${cursor}`);
  }
}
export const operation = () => ({ operationId: crypto.randomUUID() });
