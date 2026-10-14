import { normalizeName } from '@harbor/contracts';
import { ApiError, type Transport } from './index';
import { decryptName, encryptName, isEncryptedName, plainSize, type AccountKeys } from './e2ee';

/** What the transport needs to know about the signed-in account's encryption. */
export type E2eeVaultView = {
  userId?: string;
  /** The account is encrypted. */
  enabled: boolean;
  /** Encryption is being turned off: new names go up unencrypted, stored ones are still read. */
  decrypting?: boolean;
  /** Present once this app has unlocked the account. */
  keys?: AccountKeys;
};
export type E2eeTransportOptions = {
  vault: () => E2eeVaultView;
  /** Called with each /v1/users/me answer, so the vault follows the account. */
  onAccount: (userId: string, enabled: boolean, decrypting: boolean) => void;
  /**
   * Refuse file requests while the account is encrypted but locked, and answers that turn out
   * to hold encrypted items before the app knew. For apps that act on names by themselves, such
   * as desktop sync, which would otherwise create files named after ciphertext.
   */
  strict?: boolean;
};

/** Requests whose answers name the account's files. */
const fileRoute = /^\/v1\/(drive|uploads|downloads|sync|backups|search)(\/|\?|$)/;
const locked = () => new ApiError('E2EE_LOCKED', 'Unlock your files to continue.', 423);

/**
 * Makes end-to-end encryption invisible to the rest of the app. On an encrypted account, names
 * going to the server for the account's own items are encrypted, and every answer comes back
 * with names decrypted, sizes as the original files and a MIME type guessed from the name.
 * Search runs here too, as the server can't read names. Signed download links keep the stored
 * size and hash: they describe the bytes as stored, which the app checks before decrypting.
 */
export function e2eeTransport(inner: Transport, options: E2eeTransportOptions): Transport {
  const { vault, onAccount, strict } = options;
  const owners = new Map<string, string>();
  const names = new Map<string, string>();
  const ownerOf = async (id: string) => {
    if (!owners.has(id)) {
      const { item } = await inner(`/v1/drive/items/${encodeURIComponent(id)}`);
      owners.set(id, item.ownerUserId);
    }
    return owners.get(id)!;
  };
  /** Whether a name under `id` (an item, or a folder for new items) is the account's own. */
  const mine = async (id: string | null | undefined) =>
    !id || id === 'root' || (await ownerOf(id)) === vault().userId;
  const keys = () => {
    const k = vault().keys;
    if (!k) throw locked();
    return k;
  };
  /** When strict mode last asked the server whether the account is encrypted. */
  let checkedAt = 0;
  const sealName = async (name: unknown) =>
    typeof name === 'string' && !isEncryptedName(name) ? encryptName(keys(), name) : name;

  async function outgoing(path: string, init: Parameters<Transport>[1] = {}) {
    const method = (init.method ?? 'GET').toUpperCase();
    const body = init.body as Record<string, unknown> | undefined;
    const [route, query] = path.split('?');
    if (body && typeof body.name === 'string') {
      const item = route.match(/^\/v1\/drive\/items\/([^/]+)(?:\/move)?$/)?.[1];
      const backupRun =
        /^\/v1\/backups\/[^/]+\/runs\/[^/]+\/(folders|uploads|items\/[^/]+\/name)$/.exec(
          route,
        )?.[1];
      const encrypt =
        (method === 'POST' &&
          route === '/v1/drive/folders' &&
          (await mine(body.parentId as string))) ||
        (item && ['PATCH', 'POST'].includes(method) && (await mine(decodeURIComponent(item)))) ||
        (method === 'POST' && route === '/v1/uploads' && body.encrypted === true) ||
        // Backup folders always belong to the account backing up.
        (method === 'POST' && (backupRun === 'folders' || !!backupRun?.startsWith('items/'))) ||
        (method === 'POST' && backupRun === 'uploads' && body.encrypted === true);
      if (encrypt) return { ...init, body: { ...body, name: await sealName(body.name) } };
    }
    // A backed up file's path, which the server keeps with the backup run.
    if (
      method === 'POST' &&
      /^\/v1\/backups\/[^/]+\/runs\/[^/]+\/files$/.test(route) &&
      typeof body?.relativePath === 'string'
    ) {
      const segments = await Promise.all(body.relativePath.split('/').map(sealName));
      return { ...init, body: { ...body, relativePath: segments.join('/') } };
    }
    // A batch of small files from a synced folder or a backup run: each encrypted upload's name,
    // and each path a backup records.
    const batch =
      route === '/v1/uploads/batch'
        ? 'uploads'
        : /^\/v1\/backups\/[^/]+\/runs\/[^/]+\/(uploads|files)\/batch$/.exec(route)?.[1];
    if (method === 'POST' && batch === 'uploads' && Array.isArray(body?.uploads)) {
      const uploads = await Promise.all(
        (body.uploads as { name?: unknown; encrypted?: unknown }[]).map(async (upload) =>
          upload.encrypted === true ? { ...upload, name: await sealName(upload.name) } : upload,
        ),
      );
      return { ...init, body: { ...body, uploads } };
    }
    if (method === 'POST' && batch === 'files' && Array.isArray(body?.files)) {
      const files = await Promise.all(
        (body.files as { relativePath?: unknown }[]).map(async (file) =>
          typeof file.relativePath === 'string'
            ? {
                ...file,
                relativePath: (await Promise.all(file.relativePath.split('/').map(sealName))).join(
                  '/',
                ),
              }
            : file,
        ),
      );
      return { ...init, body: { ...body, files } };
    }
    if (method === 'POST' && route === '/v1/sync/operations' && Array.isArray(body?.operations)) {
      const operations = await Promise.all(
        (body.operations as { entityId: string; payload?: { name?: unknown } }[]).map(async (o) =>
          typeof o.payload?.name === 'string' && (await mine(o.entityId))
            ? { ...o, payload: { ...o.payload, name: await sealName(o.payload.name) } }
            : o,
        ),
      );
      return { ...init, body: { ...body, operations } };
    }
    const lookup = route.match(/^\/v1\/drive\/folders\/([^/]+)\/lookup$/)?.[1];
    if (lookup && (await mine(decodeURIComponent(lookup)))) {
      const params = new URLSearchParams(query);
      params.set('name', (await sealName(params.get('name'))) as string);
      return { ...init, path: `${route}?${params}` };
    }
    return init;
  }

  async function reveal(k: AccountKeys, token: string) {
    if (!names.has(token)) {
      try {
        names.set(token, await decryptName(k, token));
      } catch {
        // Lower-cased copies (normalizedName) and damaged names stay as they are.
        return token;
      }
      if (names.size > 50_000) names.clear();
    }
    return names.get(token)!;
  }
  async function incoming(value: unknown, k: AccountKeys): Promise<unknown> {
    if (Array.isArray(value)) return Promise.all(value.map((v) => incoming(v, k)));
    if (typeof value === 'string') {
      // Signed links name the file too; changing them would break their signature.
      if (!value.includes('h0e1.') || /^https?:\/\//.test(value)) return value;
      if (isEncryptedName(value)) return reveal(k, value);
      // Paths and messages that name encrypted items.
      const tokens = [...new Set(value.match(/h0e1\.[A-Za-z0-9_-]+/g) ?? [])];
      let out = value;
      for (const t of tokens) out = out.split(t).join(await reveal(k, t));
      return out;
    }
    if (!value || typeof value !== 'object') return value;
    const o = value as Record<string, unknown>;
    if (typeof o.id === 'string' && typeof o.ownerUserId === 'string')
      owners.set(o.id, o.ownerUserId);
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(o)) out[key] = await incoming(v, k);
    if (typeof o.name === 'string' && isEncryptedName(o.name) && 'normalizedName' in o)
      out.normalizedName = normalizeName(out.name as string);
    if (o.encrypted === true && typeof o.sizeBytes === 'number' && !('downloadUrl' in o)) {
      out.sizeBytes = plainSize(o.sizeBytes);
      if (
        typeof out.name === 'string' &&
        (!o.mimeType || o.mimeType === 'application/octet-stream')
      )
        out.mimeType = guessMime(out.name);
    }
    return out;
  }

  /** Name search and type filters, applied to decrypted names a page at a time. */
  async function search(path: string, init: Parameters<Transport>[1], k: AccountKeys) {
    const params = new URLSearchParams(path.split('?')[1]);
    const q = normalizeName(params.get('q') ?? '');
    const extension = params.get('extension')?.toLowerCase();
    const mimeType = params.get('mimeType');
    for (const key of ['q', 'extension', 'mimeType']) params.delete(key);
    const limit = Number(params.get('limit') ?? 100);
    const items: { normalizedName: string; mimeType: string | null }[] = [];
    let cursor = params.get('cursor');
    for (let pages = 0; pages < 20; pages++) {
      if (cursor) params.set('cursor', cursor);
      const page = (await incoming(await inner(`/v1/search?${params}`, init), k)) as {
        items: typeof items;
        nextCursor: string | null;
      };
      items.push(
        ...page.items.filter(
          (i) =>
            (!q || i.normalizedName.includes(q)) &&
            (!extension || i.normalizedName.endsWith('.' + extension)) &&
            (!mimeType || i.mimeType === mimeType),
        ),
      );
      cursor = page.nextCursor;
      if (!cursor || items.length >= limit) break;
    }
    return { items, nextCursor: cursor };
  }

  return async (path, init) => {
    const before = vault();
    const files = fileRoute.test(path);
    if (strict && files && before.enabled && !before.keys) throw locked();
    let target = path;
    if (before.enabled && before.keys) {
      if (/^\/v1\/search\?/.test(path) && /[?&](q|extension|mimeType)=/.test(path))
        return search(path, init, before.keys);
      // While turning off, new names go up unencrypted; stored ones are still read here.
      if (!before.decrypting) {
        const changed = (await outgoing(path, init)) as Parameters<Transport>[1] & {
          path?: string;
        };
        if (changed?.path) target = changed.path;
        init = changed;
      }
    } else if (before.enabled && !before.decrypting) await outgoing(path, init);
    const result = await inner(target, init);
    if (path === '/v1/users/me' && result?.user?.id)
      onAccount(result.user.id, !!result.user.e2ee, !!result.user.e2ee?.decryptingSince);
    const now = vault();
    if (now.enabled && now.keys) return incoming(result, now.keys);
    if (strict && files && !now.enabled && Date.now() - checkedAt > 60_000) {
      // Encryption may have been turned on elsewhere since this app last asked: find out, and
      // stop before anything acts on encrypted names or bytes. Older changes can still name
      // encrypted items after encryption was turned off, so only the account's state counts.
      const text = JSON.stringify(result) ?? '';
      if (text.includes('"h0e1.') || text.includes('"encrypted":true')) {
        checkedAt = Date.now();
        const me = await inner('/v1/users/me').catch(() => null);
        if (me?.user?.id) onAccount(me.user.id, !!me.user.e2ee, !!me.user.e2ee?.decryptingSince);
        if (vault().enabled) throw locked();
      }
    }
    return result;
  };
}

const mimes: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  heic: 'image/heic',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  html: 'text/html',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  zip: 'application/zip',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
/** The MIME type the browser would give a file of this name; uploads of encrypted files hide it. */
export const guessMime = (name: string) =>
  mimes[name.toLowerCase().split('.').at(-1) ?? ''] ?? 'application/octet-stream';
