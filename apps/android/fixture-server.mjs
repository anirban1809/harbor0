/* global console, Buffer, URL */
// Disposable loopback API/storage fixtures for Android tests. No cloud credentials or data.
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';

const port = 18989;
const base = `http://127.0.0.1:${port}`;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const welcome = Buffer.from('Welcome to harbor0. Your files, within reach.\n');
const items = new Map();
const bytes = new Map();
const uploads = new Map();
const sessions = new Map();
let appearance = { preference: 'system', preset: 'default', palettes: { light: {}, dark: {} } };
let profile = { displayName: 'Android test account', username: 'androidtest' };
const now = () => new Date().toISOString();
const later = () => new Date(Date.now() + 7 * 86400000).toISOString();
const transfers = [
  {
    id: 'transfer-one',
    state: 'PENDING',
    createdAt: now(),
    expiresAt: later(),
    totalSizeBytes: 46,
    savedAt: null,
    recipientEmail: null,
    preparationState: 'READY',
    items: [{ id: 'entry-one', displayName: 'Fixture brief.txt', relativePath: 'Fixture brief.txt', itemType: 'FILE', sizeBytes: 46, mimeType: 'text/plain' }],
    nextEntryCursor: null,
    sender: { displayName: 'Bob Chen', username: 'bob' },
    recipient: { displayName: 'Android test account', username: 'androidtest' },
  },
];
const makeItem = (id, name, type, parentId = null, sizeBytes = 0) => ({
  id,
  name,
  type,
  parentId,
  sizeBytes,
  mimeType: type === 'FILE' ? 'text/plain' : null,
  updatedAt: new Date().toISOString(),
  backupRootId: null,
  cloudState: 'AVAILABLE',
  revision: 1,
  deletedAt: null,
  favorite: false,
  createdAt: new Date().toISOString(),
  ownerUserId: 'android-test',
  currentVersionId: `${id}-v1`,
});
items.set('documents', makeItem('documents', 'Documents', 'FOLDER'));
items.set('welcome', makeItem('welcome', 'Welcome.txt', 'FILE', null, welcome.length));
bytes.set('welcome', welcome);
items.set('sync-root', makeItem('sync-root', 'Studio assets', 'FOLDER'));
items.set(
  'sync-file',
  makeItem('sync-file', 'Shared brief.txt', 'FILE', 'sync-root', welcome.length),
);
bytes.set('sync-file', welcome);
items.set('backup-folder', {
  ...makeItem('backup-folder', 'Design archive', 'FOLDER'),
  backupRootId: 'backup-root',
});
items.set('backup-file', {
  ...makeItem('backup-file', 'Saved brief.txt', 'FILE', 'backup-folder', welcome.length),
  backupRootId: 'backup-root',
});
bytes.set('backup-file', welcome);
items.set('archive-folder', { ...makeItem('archive-folder', 'Old projects', 'FOLDER'), backupRootId: 'archive-root' });
items.set('orphan-folder', { ...makeItem('orphan-folder', 'Tax records', 'FOLDER'), backupRootId: 'orphan-root' });
items.set('trash-note', {
  ...makeItem('trash-note', 'Old notes.txt', 'FILE', null, 123),
  deletedAt: new Date().toISOString(),
  revision: 2,
});
// Backups and Archives in My Drive group roots by device: by device key, by session id, or (here) a device that is gone.
const backups = [
  {
    id: 'backup-root',
    deviceId: 'mac-session',
    deviceName: 'Studio Mac',
    devicePublicId: 'mac-key',
    localPathDisplayName: 'Design archive',
    remoteRootDriveItemId: 'backup-folder',
    state: 'ACTIVE',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'archive-root',
    deviceId: 'mac',
    deviceName: 'Studio Mac',
    localPathDisplayName: 'Old projects',
    remoteRootDriveItemId: 'archive-folder',
    state: 'ARCHIVED',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'orphan-root',
    deviceId: 'retired-session',
    deviceName: 'Old laptop',
    localPathDisplayName: 'Tax records',
    remoteRootDriveItemId: 'orphan-folder',
    state: 'ARCHIVED',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
];
const issue = () => {
  const accessToken = randomUUID(),
    refreshToken = randomUUID();
  sessions.set(accessToken, refreshToken);
  return { accessToken, refreshToken, expiresIn: 3600 };
};
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, base);
  const path = url.pathname;
  const reply = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const fail = (status, message) => reply(status, { error: { message } });
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    const data =
      req.headers['content-type']?.includes('application/json') && raw.length
        ? JSON.parse(raw)
        : {};
    if (path === '/health') return reply(200, { ok: true });
    if (path === '/v1/auth/login') {
      if (data.email !== 'android-test@example.test' || data.password !== 'fixture-password')
        return fail(401, 'Email or password is incorrect.');
      if (data.platform !== 'ANDROID') return fail(400, 'Expected an Android device registration.');
      return reply(200, issue());
    }
    if (path === '/v1/auth/refresh') {
      const found = [...sessions].find(([, refresh]) => refresh === data.refreshToken);
      if (!found) return fail(401, 'Your session expired.');
      sessions.delete(found[0]);
      return reply(200, issue());
    }
    if (path.startsWith('/storage/')) {
      if (req.headers.authorization)
        return fail(400, 'Credentials must not be sent to file storage.');
      const [, , id, part] = path.split('/');
      if (req.method === 'PUT') {
        const upload = uploads.get(id);
        if (!upload) return fail(404, 'Upload not found.');
        // Deliberately fail the first part once to exercise retry and URL renewal.
        if (!upload.retried) {
          upload.retried = true;
          return fail(503, 'Transient storage failure.');
        }
        upload.parts.set(Number(part), raw);
        res.writeHead(200, { ETag: `"${hash(raw)}"` });
        res.end();
        return;
      }
      const body = id === 'corrupt' ? Buffer.from('bad') : bytes.get(id);
      if (!body) return fail(404, 'File not found.');
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': body.length });
      res.end(body);
      return;
    }
    const access = req.headers.authorization?.replace(/^Bearer /, '');
    if (!sessions.has(access)) return fail(401, 'Sign in to continue.');
    // Device identity: the app signs a challenge once per sign-in. The fixture only checks its shape.
    if (path === '/v1/auth/session/challenge')
      return reply(200, { challenge: randomUUID(), userId: 'android-test' });
    if (path === '/v1/auth/session') {
      if (!data.proof?.signature || !data.devicePublicId) return fail(400, 'Missing device proof.');
      return reply(200, { device: { id: 'android-device', name: data.name, platform: data.platform } });
    }
    if (path === '/v1/notifications')
      return reply(200, {
        items: [{ id: 'notice-one', type: 'TRANSFER_RECEIVED', data: {}, readAt: null, createdAt: now() }],
        nextCursor: null,
      });
    if (path === '/v1/devices')
      return reply(200, {
        items: [
          { id: 'android-device', name: 'Android emulator', platform: 'ANDROID', status: 'ACTIVE', lastSeenAt: now(), createdAt: now(), revokedAt: null },
          { id: 'mac', name: 'Studio Mac', platform: 'MACOS', status: 'ACTIVE', devicePublicId: 'mac-key', lastSeenAt: now(), createdAt: now(), revokedAt: null },
          { id: 'web', name: 'Chrome', platform: 'WEB', status: 'ACTIVE', lastSeenAt: now(), createdAt: now(), revokedAt: null },
        ],
      });
    if (path === '/v1/transfers/received') return reply(200, { items: transfers, nextCursor: null });
    if (path === '/v1/transfers/sent') return reply(200, { items: [], nextCursor: null });
    const transferAction = path.match(/^\/v1\/transfers\/([^/]+)\/(accept|decline|save)$/);
    if (transferAction) {
      const transfer = transfers.find((t) => t.id === transferAction[1]);
      if (!transfer || !data.operationId) return fail(400, 'Invalid transfer action.');
      if (transferAction[2] === 'accept') transfer.state = 'ACCEPTED';
      if (transferAction[2] === 'decline') transfer.state = 'DECLINED';
      if (transferAction[2] === 'save') transfer.savedAt = now();
      return reply(200, { transfer });
    }
    if (path === '/v1/shares/received' || path === '/v1/shares/sent') return reply(200, { items: [] });
    if (path === '/v1/drive/usage') {
      const ids = (url.searchParams.get('ids') ?? '').split(',').filter(Boolean);
      if (ids.length > 50) return fail(400, 'Too many ids.');
      // Every stored version of every non-trashed file in the subtree; one version per fixture file.
      const usage = (id) => {
        let bytes = 0, files = 0;
        for (const item of items.values()) {
          if (item.parentId !== id || item.deletedAt) continue;
          if (item.type === 'FOLDER') { const inner = usage(item.id); bytes += inner.bytes; files += inner.files; }
          else { bytes += item.sizeBytes; files += 1; }
        }
        return { bytes, files };
      };
      return reply(200, {
        items: ids.filter((id) => items.has(id)).map((id) => ({ itemId: id, ...usage(id), complete: id !== 'orphan-folder' })),
      });
    }
    const versions = path.match(/^\/v1\/drive\/items\/([^/]+)\/versions$/);
    if (versions) {
      const item = items.get(versions[1]);
      if (!item) return fail(404, 'File not found.');
      return reply(200, {
        items: [{ id: `${item.id}-v1`, driveItemId: item.id, versionNumber: 1, sizeBytes: item.sizeBytes, contentHash: 'a'.repeat(64), contentHashAlgorithm: 'SHA256', sourceDeviceId: null, createdAt: item.updatedAt }],
      });
    }
    const favorite = path.match(/^\/v1\/drive\/items\/([^/]+)\/favorite$/);
    if (favorite) {
      const item = items.get(favorite[1]);
      if (!item) return fail(404, 'File not found.');
      if (data.baseRevision !== item.revision || !data.operationId) return fail(409, 'Refresh this file before changing it.');
      item.favorite = req.method === 'PUT';
      item.revision++;
      return reply(200, { item });
    }
    const move = path.match(/^\/v1\/drive\/items\/([^/]+)\/move$/);
    if (move) {
      const item = items.get(move[1]);
      if (!item) return fail(404, 'File not found.');
      if (data.baseRevision !== item.revision || !data.operationId) return fail(409, 'Refresh this file before changing it.');
      item.parentId = data.parentId ?? null;
      item.revision++;
      return reply(200, { item });
    }
    if (path === '/v1/backups/backup-root/restores') return reply(200, { items: [], nextCursor: null });
    if (path === '/v1/backups/backup-root/runs/run-one/files')
      return reply(200, {
        items: [{ relativePath: 'Saved brief.txt', itemId: 'backup-file', versionId: 'backup-file-v1', sizeBytes: welcome.length, modifiedAt: now(), savedAt: now() }],
        nextCursor: null,
      });
    if (path === '/v1/auth/logout') {
      sessions.delete(access);
      return reply(200, { loggedOut: true });
    }
    if (path === '/v1/users/me' && req.method === 'PATCH') {
      if (!data.operationId) return fail(400, 'Missing operation.');
      if (data.appearance) {
        if (!['default', 'ocean', 'forest', 'violet', 'sunset'].includes(data.appearance.preset))
          return fail(400, 'Invalid appearance.');
        appearance = data.appearance;
      }
      if (data.displayName) profile.displayName = data.displayName;
      if (data.username) profile.username = data.username;
    }
    if (path === '/v1/users/me')
      return reply(200, {
        user: {
          id: 'android-test',
          email: 'android-test@example.test',
          displayName: profile.displayName,
          username: profile.username,
          emailVerified: true,
          appearance,
        },
        storage: {
          quotaBytes: 100_000_000_000,
          usedBytes: [...bytes.values()].reduce((sum, b) => sum + b.length, 0),
          reservedBytes: 0,
        },
      });
    // On-device sync: register this phone and report an empty change feed and no invitations.
    if (path === '/v1/sync/devices/register' && req.method === 'POST')
      return reply(200, {
        device: { id: 'android-device', userId: 'android-test', name: 'Android test', platform: 'ANDROID', appVersion: null,
          devicePublicId: null, keyFingerprint: null, lastSeenAt: null, createdAt: new Date().toISOString(), revokedAt: null },
      });
    if (path === '/v1/sync/folders' && req.method === 'PUT') return reply(200, { ok: true, removedFolderIds: [] });
    if (path === '/v1/sync/shares') return reply(200, { items: [] });
    if (path === '/v1/sync/changes') return reply(200, { changes: [], nextCursor: 0, hasMore: false });
    if (path === '/v1/sync/checkpoints') return reply(200, {});
    if (/^\/v1\/sync\/items\/[^/]+\/acknowledge$/.test(path)) return reply(200, { ok: true, requiredDevices: 1, confirmedDevices: 1 });
    if (path === '/v1/sync/folders') return reply(200, { items: [{ ...items.get('sync-root'), syncDevices: [{ id: 'mac', name: 'Studio Mac' }] }] });
    if (path === '/v1/sync/status')
      return reply(200, {
        items: [
          {
            itemId: 'sync-root',
            state: 'SYNCED',
            cloudState: 'AVAILABLE',
            requiredDevices: 2,
            confirmedDevices: 2,
          },
        ],
      });
    if (path === '/v1/backups') return reply(200, { items: backups });
    if (path === '/v1/backups/backup-root/runs')
      return reply(200, {
        items: [
          {
            id: 'run-one',
            state: 'COMPLETED',
            trigger: 'AUTOMATIC',
            startedAt: new Date().toISOString(),
            fileCount: 18,
            sizeBytes: 48200000,
            error: null,
          },
        ],
        nextCursor: null,
      });
    if (path === '/v1/search') {
      const q = url.searchParams.get('q')?.toLowerCase();
      const trash = url.searchParams.get('trash') === 'true';
      return reply(200, {
        items: [...items.values()].filter(
          (i) => !!i.deletedAt === trash && (!q || i.name.toLowerCase().includes(q)),
        ),
        nextCursor: null,
      });
    }
    if (path === '/v1/drive/trash/empty') {
      let count = 0;
      for (const item of items.values())
        if (item.deletedAt) {
          items.delete(item.id);
          bytes.delete(item.id);
          count++;
        }
      return reply(200, { count, nextCursor: null });
    }
    const mutation = path.match(/^\/v1\/drive\/items\/([^/]+)(?:\/(restore|permanent))?$/);
    if (mutation) {
      const item = items.get(mutation[1]);
      if (!item) return fail(404, 'File not found.');
      if (req.method === 'GET') return reply(200, { item });
      if (data.baseRevision !== item.revision || !data.operationId)
        return fail(409, 'Refresh this file before changing it.');
      if (req.method === 'PATCH') {
        if (!data.name?.trim() || /[\\/]/.test(data.name)) return fail(400, 'Choose a valid name.');
        item.name = data.name;
        item.revision++;
        return reply(200, { item });
      }
      if (mutation[2] === 'permanent') {
        items.delete(item.id);
        bytes.delete(item.id);
        return reply(200, { ok: true });
      }
      item.deletedAt = mutation[2] === 'restore' ? null : new Date().toISOString();
      item.revision++;
      return reply(200, { item });
    }
    const folder = path.match(/^\/v1\/drive\/folders\/([^/]+)\/children$/);
    if (folder)
      return reply(200, {
        items: [...items.values()].filter(
          (i) => !i.deletedAt && i.parentId === (folder[1] === 'root' ? null : folder[1]),
        ),
        nextCursor: null,
      });
    if (path === '/v1/drive/folders' && req.method === 'POST') {
      if (!data.name?.trim() || /[\\/]/.test(data.name))
        return fail(400, 'Choose a valid folder name.');
      const item = makeItem(randomUUID(), data.name, 'FOLDER', data.parentId);
      items.set(item.id, item);
      return reply(200, { item });
    }
    if (path === '/v1/uploads' && req.method === 'POST') {
      const id = randomUUID();
      uploads.set(id, { ...data, parts: new Map(), partSizeBytes: 1024 * 1024 });
      return reply(200, { upload: { id, partSizeBytes: 1024 * 1024 } });
    }
    const uploadRoute = path.match(/^\/v1\/uploads\/([^/]+)(?:\/(parts|complete))?$/);
    if (uploadRoute) {
      const [, id, action] = uploadRoute;
      const upload = uploads.get(id);
      if (!upload) return fail(404, 'Upload not found.');
      if (req.method === 'DELETE') {
        uploads.delete(id);
        return reply(200, { aborted: true });
      }
      if (action === 'parts')
        return reply(200, {
          parts: data.partNumbers.map((n) => ({
            partNumber: n,
            uploadUrl: `${base}/storage/${id}/${n}`,
          })),
        });
      if (action === 'complete') {
        const count = Math.max(1, Math.ceil(upload.sizeBytes / upload.partSizeBytes));
        if (data.parts.length !== count) return fail(400, 'Incomplete multipart upload.');
        const parts = data.parts.map((p, index) => {
          const chunk = upload.parts.get(p.partNumber);
          if (p.partNumber !== index + 1 || !chunk || p.etag !== `"${hash(chunk)}"`)
            throw new Error('Invalid completed part.');
          return chunk;
        });
        const body = Buffer.concat(parts);
        if (
          body.length !== upload.sizeBytes ||
          hash(body) !== data.contentHash ||
          hash(body) !== upload.contentHash
        )
          return fail(400, 'Upload checksum mismatch.');
        const item = makeItem(id, upload.name, 'FILE', upload.parentId, body.length);
        items.set(id, item);
        bytes.set(id, body);
        uploads.delete(id);
        return reply(200, { item });
      }
    }
    if (path === '/v1/downloads') {
      const id = data.driveItemId;
      const body = id === 'corrupt' ? Buffer.from('abc') : bytes.get(id);
      if (!body) return fail(404, 'File not found.');
      return reply(200, {
        downloadUrl: `${base}/storage/${id}`,
        sizeBytes: body.length,
        contentHash: hash(body),
      });
    }
    fail(404, 'Unknown fixture route.');
  } catch (error) {
    fail(500, error.message);
  }
});
server.listen(port, '127.0.0.1', () => console.log(`Android fixture API listening on ${base}`));
