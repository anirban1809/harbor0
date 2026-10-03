// Disposable loopback API/storage fixtures for iOS tests. No cloud credentials or data.
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';

const port = 18987;
const base = `http://127.0.0.1:${port}`;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const now = () => new Date().toISOString();
const daysAgo = (days) => new Date(Date.now() - days * 86400_000).toISOString();
const welcome = Buffer.from('Welcome to harbor0. Your files, within reach.\n');
const items = new Map();
const bytes = new Map();
const uploads = new Map();
const sessions = new Map();
const versions = new Map();
const zips = new Map();
let appearance = { preference: 'system', preset: 'default', palettes: { light: {}, dark: {} } };
const profile = { displayName: 'Alex Rivera', username: 'alex' };
// Reported usage beyond the fixture bytes, so storage screens look like a real account.
const baseUsage = 12_400_000_000;
const makeItem = (id, name, type, parentId = null, sizeBytes = 0, extra = {}) => ({
  id, name, type, parentId, sizeBytes, mimeType: type === 'FILE' ? 'text/plain' : null,
  ownerUserId: 'ios-test', createdAt: daysAgo(1), updatedAt: daysAgo(1), backupRootId: null, cloudState: 'AVAILABLE',
  revision: 1, deletedAt: null, favorite: false, currentVersionId: type === 'FILE' ? `${id}-v1` : null, ...extra,
});
const add = (item, body) => {
  items.set(item.id, item);
  if (body) bytes.set(item.id, body);
  if (item.type === 'FILE') versions.set(item.id, [{ id: `${item.id}-v1`, versionNumber: 1, sizeBytes: item.sizeBytes, createdAt: item.updatedAt, cloudState: 'AVAILABLE' }]);
};
add(makeItem('documents', 'Documents', 'FOLDER'));
add(makeItem('photos', 'Photos', 'FOLDER'));
add(makeItem('dusk', 'Harbor at dusk.jpg', 'FILE', null, 4_200_000, { mimeType: 'image/jpeg' }), welcome);
add(makeItem('notes', 'Meeting notes.md', 'FILE', null, 12_000, { mimeType: 'text/markdown' }), welcome);
add(makeItem('brief', 'Project brief.pdf', 'FILE', null, 2_500_000, { mimeType: 'application/pdf', favorite: true }), welcome);
add(makeItem('welcome', 'Welcome.txt', 'FILE', null, welcome.length, { updatedAt: daysAgo(3) }), welcome);
add(makeItem('sync-root', 'Studio assets', 'FOLDER'));
add(makeItem('sync-file', 'Shared brief.txt', 'FILE', 'sync-root', welcome.length), welcome);
add({ ...makeItem('backup-folder', 'Design archive', 'FOLDER'), backupRootId: 'backup-root' });
add({ ...makeItem('backup-file', 'Saved brief.txt', 'FILE', 'backup-folder', welcome.length), backupRootId: 'backup-root' }, welcome);
add({ ...makeItem('archive-folder', 'Old projects', 'FOLDER'), backupRootId: 'archive-root' });
add({ ...makeItem('archive-file', 'Plan.txt', 'FILE', 'archive-folder', welcome.length), backupRootId: 'archive-root' }, welcome);
add({ ...makeItem('gone-folder', 'Tax records', 'FOLDER'), backupRootId: 'gone-root' });
add({ ...makeItem('gone-file', 'Return.pdf', 'FILE', 'gone-folder', 4_200_000, { mimeType: 'application/pdf' }), backupRootId: 'gone-root' }, welcome);
add({ ...makeItem('trash-note', 'Old notes.txt', 'FILE', null, 123), deletedAt: now(), revision: 2 });
versions.get('brief').unshift({ id: 'brief-v2', versionNumber: 2, sizeBytes: 2_500_000, createdAt: now(), cloudState: 'AVAILABLE' });
items.get('brief').currentVersionId = 'brief-v2';
const backups = [{ id: 'backup-root', deviceName: 'MacBook Pro', deviceId: 'mac', localPathDisplayName: 'Design archive', remoteRootDriveItemId: 'backup-folder', state: 'ACTIVE', createdAt: daysAgo(10), updatedAt: now() },
  // Archived on the Mac; and a backup whose device is gone (grouped by its saved device name).
  { id: 'archive-root', deviceName: 'MacBook Pro', deviceId: 'mac', localPathDisplayName: 'Old projects', remoteRootDriveItemId: 'archive-folder', state: 'ARCHIVED', createdAt: daysAgo(40), updatedAt: daysAgo(20) },
  { id: 'gone-root', deviceName: 'Old PC', deviceId: 'gone-pc', localPathDisplayName: 'Tax records', remoteRootDriveItemId: 'gone-folder', state: 'ACTIVE', createdAt: daysAgo(90), updatedAt: daysAgo(60) }];
const restores = [];
const people = { sam: { displayName: 'Sam Lee', username: 'sam' }, jo: { displayName: 'Jo Park', username: 'jo' }, me: profile };
const entry = (id, name, size, mimeType = 'application/octet-stream') => ({
  id, sourceDriveItemId: id, sourceVersionId: null, displayName: name, relativePath: name, parentEntryId: null,
  itemType: 'FILE', sizeBytes: size, mimeType, contentHash: hash(welcome),
});
const transfers = [
  { id: 'transfer-q3', direction: 'received', state: 'PENDING', createdAt: daysAgo(0.1), expiresAt: new Date(Date.now() + 7 * 86400_000).toISOString(), totalSizeBytes: 8_200_000, savedAt: null, preparationState: 'READY', items: [entry('entry-q3', 'Q3 report.pdf', 8_200_000, 'application/pdf')], sender: people.sam, recipient: profile },
  { id: 'transfer-logo', direction: 'received', state: 'ACCEPTED', createdAt: daysAgo(0.2), expiresAt: new Date(Date.now() + 7 * 86400_000).toISOString(), totalSizeBytes: 1_200_000, savedAt: null, preparationState: 'READY', items: [entry('entry-logo', 'Logo.svg', welcome.length, 'image/svg+xml')], sender: people.jo, recipient: profile },
  { id: 'transfer-sent', direction: 'sent', state: 'PENDING', createdAt: daysAgo(1), expiresAt: new Date(Date.now() + 6 * 86400_000).toISOString(), totalSizeBytes: 2_500_000, savedAt: null, preparationState: 'READY', items: [entry('entry-brief', 'Project brief.pdf', 2_500_000, 'application/pdf')], sender: profile, recipient: people.sam },
];
const shares = [];
const devices = [
  { id: 'mac', name: 'MacBook Pro', platform: 'MACOS', status: 'ACTIVE', lastSeenAt: now(), createdAt: daysAgo(30), revokedAt: null },
  { id: 'phone', name: 'iPhone', platform: 'IOS', status: 'ACTIVE', lastSeenAt: now(), createdAt: daysAgo(2), revokedAt: null },
];
const notifications = [{ id: 'notice-1', type: 'TRANSFER_RECEIVED', data: {}, readAt: null, createdAt: daysAgo(0.1) }];
const issue = () => {
  const accessToken = randomUUID(), refreshToken = randomUUID();
  sessions.set(accessToken, refreshToken);
  return { accessToken, refreshToken, expiresIn: 3600 };
};
const visible = (item) => !item.deletedAt;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, base);
  const path = url.pathname;
  const reply = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const fail = (status, message, code) => reply(status, { error: { message, ...(code ? { code } : {}) } });
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    const data = req.headers['content-type']?.includes('application/json') && raw.length ? JSON.parse(raw) : {};
    if (path === '/health') return reply(200, { ok: true });
    if (path === '/v1/auth/login') {
      if (data.email !== 'ios-test@example.test' || data.password !== 'fixture-password') return fail(401, 'Email or password is incorrect.');
      if (data.platform !== 'IOS') return fail(400, 'Expected an iOS device registration.');
      return reply(200, issue());
    }
    if (path === '/v1/auth/refresh') {
      const found = [...sessions].find(([, refresh]) => refresh === data.refreshToken);
      if (!found) return fail(401, 'Your session expired.');
      sessions.delete(found[0]);
      return reply(200, issue());
    }
    if (path === '/v1/auth/signup') {
      if (!data.email || !data.password || data.password.length < 12) return fail(400, 'Choose a password with at least 12 characters.');
      return reply(200, { verificationRequired: true });
    }
    if (path === '/v1/auth/confirm') return data.code === '123456' ? reply(200, { confirmed: true }) : fail(400, 'That code is incorrect.');
    if (path === '/v1/auth/resend' || path === '/v1/auth/forgot') return reply(200, { sent: true });
    if (path === '/v1/auth/reset') return data.code === '123456' ? reply(200, { reset: true }) : fail(400, 'That code is incorrect.');
    if (path.startsWith('/storage/')) {
      if (req.headers.authorization) return fail(400, 'Credentials must not be sent to file storage.');
      const [, , id, part] = path.split('/');
      if (req.method === 'PUT') {
        const upload = uploads.get(id);
        if (!upload) return fail(404, 'Upload not found.');
        // Deliberately fail the first part once to exercise retry and URL renewal.
        if (!upload.retried) { upload.retried = true; return fail(503, 'Transient storage failure.'); }
        upload.parts.set(Number(part), raw);
        res.writeHead(200, { ETag: `"${hash(raw)}"` }); res.end(); return;
      }
      const body = id === 'corrupt' ? Buffer.from('bad') : bytes.get(id) ?? (id.startsWith('zip-') || id.startsWith('entry-') ? welcome : undefined);
      if (!body) return fail(404, 'File not found.');
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length }); res.end(body); return;
    }
    const access = req.headers.authorization?.replace(/^Bearer /, '');
    if (!sessions.has(access)) return fail(401, 'Sign in to continue.');
    if (path === '/v1/auth/logout') { sessions.delete(access); return reply(200, { loggedOut: true }); }
    if (path === '/v1/auth/session/challenge') return reply(200, { challenge: randomUUID(), userId: 'ios-test', expiresAt: new Date(Date.now() + 300_000).toISOString() });
    if (path === '/v1/auth/session') return reply(200, { registered: true });
    if (path === '/v1/users/me/delete') {
      if (data.email !== 'ios-test@example.test') return fail(400, 'Type your account email to confirm.');
      return reply(200, { deletedAt: now(), purgeAt: now() });
    }
    if (path === '/v1/users/me' && req.method === 'PATCH') {
      if (data.appearance) {
        if (!['default', 'ocean', 'forest', 'violet', 'sunset'].includes(data.appearance?.preset)) return fail(400, 'Invalid appearance.');
        appearance = data.appearance;
      }
      if (data.displayName) profile.displayName = data.displayName;
      if (data.username) profile.username = data.username;
    }
    if (path === '/v1/users/me') {
      const used = baseUsage + [...bytes.values()].reduce((sum, b) => sum + b.length, 0);
      return reply(200, {
        user: { id: 'ios-test', email: 'ios-test@example.test', emailVerified: true, ...profile, appearance },
        storage: { quotaBytes: 100_000_000_000, usedBytes: used, reservedBytes: 0, availableBytes: 100_000_000_000 - used },
      });
    }
    if (path === '/v1/sync/folders') return reply(200, { items: [{ ...items.get('sync-root'), syncDevices: [{ id: 'mac', name: 'MacBook Pro' }] }], nextCursor: null });
    if (path === '/v1/sync/status') {
      const ids = (url.searchParams.get('ids') ?? '').split(',');
      return reply(200, { items: ids.filter((id) => ['sync-root', 'sync-file'].includes(id)).map((itemId) => ({ itemId, state: 'SYNCED', cloudState: 'AVAILABLE', requiredDevices: 2, confirmedDevices: 2, pendingItems: 0 })) });
    }
    if (path === '/v1/drive/usage') {
      // Every stored version of every non-trashed file in each folder's subtree; 'gone-folder' reports a partial count.
      const ids = (url.searchParams.get('ids') ?? '').split(',').filter(Boolean);
      if (ids.length > 50) return fail(400, 'At most 50 ids.');
      const usage = (id) => {
        let bytes = 0, files = 0;
        for (const child of items.values()) {
          if (child.parentId !== id || child.deletedAt) continue;
          if (child.type === 'FOLDER') { const sub = usage(child.id); bytes += sub.bytes; files += sub.files; }
          else { files += 1; bytes += (versions.get(child.id) ?? []).reduce((sum, v) => sum + v.sizeBytes, 0); }
        }
        return { bytes, files };
      };
      return reply(200, { items: ids.filter((id) => items.has(id)).map((itemId) => ({ itemId, ...usage(itemId), complete: itemId !== 'gone-folder' })) });
    }
    if (/^\/v1\/sync\/folders\/[^/]+$/.test(path) && req.method === 'DELETE') return reply(200, { removed: true });
    if (/^\/v1\/sync\/items\/[^/]+\/request-content$/.test(path)) return reply(200, { item: items.get(path.split('/')[4]) });
    if (path === '/v1/backups') return reply(200, { items: backups });
    const backup = path.match(/^\/v1\/backups\/([^/]+)(?:\/(runs|restores|forget)(?:\/([^/]+)\/files)?)?$/);
    if (backup) {
      const [, id, section, run] = backup;
      const root = backups.find((b) => b.id === id);
      if (!root) return fail(404, 'Backup not found.');
      if (!section && req.method === 'DELETE') { root.state = 'REMOVED'; return reply(200, { root }); }
      if (section === 'forget') { backups.splice(backups.indexOf(root), 1); return reply(200, { forgotten: true }); }
      if (section === 'runs' && run) return reply(200, { items: [{ relativePath: 'Saved brief.txt', itemId: 'backup-file', versionId: 'backup-file-v1', sizeBytes: welcome.length, modifiedAt: daysAgo(1), savedAt: daysAgo(1) }], nextCursor: null });
      if (section === 'runs') return reply(200, { items: [{ id: 'run-one', rootId: id, deviceId: 'mac', state: 'COMPLETED', trigger: 'AUTOMATIC', startedAt: daysAgo(0.05), completedAt: daysAgo(0.04), fileCount: 18, sizeBytes: 48200000, error: null }], nextCursor: null });
      if (section === 'restores' && req.method === 'POST') {
        restores.unshift({ id: data.id, rootId: id, itemId: data.itemId, versionId: data.versionId, relativePath: items.get(data.itemId)?.name ?? 'File', state: 'PENDING', requestedAt: now(), completedAt: null });
        return reply(200, { restore: restores[0] });
      }
      if (section === 'restores') return reply(200, { items: restores, nextCursor: null });
    }
    if (path === '/v1/search') {
      const q = url.searchParams.get('q')?.toLowerCase();
      const trash = url.searchParams.get('trash') === 'true';
      return reply(200, { items: [...items.values()].filter((i) => (trash ? !!i.deletedAt : visible(i)) && (!q || i.name.toLowerCase().includes(q))), nextCursor: null });
    }
    if (path === '/v1/drive/trash/empty') {
      let count = 0;
      for (const item of items.values()) if (item.deletedAt) { items.delete(item.id); bytes.delete(item.id); count++; }
      return reply(200, { count, nextCursor: null });
    }
    const versionRoute = path.match(/^\/v1\/drive\/items\/([^/]+)\/versions(?:\/([^/]+)\/restore)?$/);
    if (versionRoute) {
      const item = items.get(versionRoute[1]);
      if (!item) return fail(404, 'File not found.');
      if (versionRoute[2]) {
        if (data.baseRevision !== item.revision) return fail(409, 'Refresh this file before changing it.');
        item.currentVersionId = versionRoute[2]; item.revision++;
        return reply(200, { item });
      }
      return reply(200, { items: versions.get(item.id) ?? [], nextCursor: null });
    }
    const mutation = path.match(/^\/v1\/drive\/items\/([^/]+)(?:\/(restore|permanent|move|favorite))?$/);
    if (mutation) {
      const item = items.get(mutation[1]);
      if (!item) return fail(404, 'File not found.');
      if (req.method === 'GET') return reply(200, { item });
      if (data.baseRevision !== item.revision || !data.operationId) return fail(409, 'Refresh this file before changing it.');
      if (mutation[2] === 'permanent') { items.delete(item.id); bytes.delete(item.id); return reply(200, { ok: true }); }
      if (mutation[2] === 'favorite') item.favorite = req.method === 'PUT';
      else if (mutation[2] === 'move') item.parentId = data.parentId ?? null;
      else if (req.method === 'PATCH') {
        if (!data.name?.trim() || /[\\/]/.test(data.name)) return fail(400, 'Choose a valid name.');
        item.name = data.name;
      } else item.deletedAt = mutation[2] === 'restore' ? null : now();
      item.revision++;
      item.updatedAt = now();
      return reply(200, { item });
    }
    const folder = path.match(/^\/v1\/drive\/folders\/([^/]+)\/children$/);
    if (folder) return reply(200, { items: [...items.values()].filter(i => visible(i) && i.parentId === (folder[1] === 'root' ? null : folder[1])), nextCursor: null });
    if (path === '/v1/drive/folders' && req.method === 'POST') {
      if (!data.name?.trim() || /[\\/]/.test(data.name)) return fail(400, 'Choose a valid folder name.');
      const item = makeItem(randomUUID(), data.name, 'FOLDER', data.parentId, 0, { createdAt: now(), updatedAt: now() });
      items.set(item.id, item); return reply(200, { item });
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
      if (req.method === 'DELETE') { uploads.delete(id); return reply(200, { aborted: true }); }
      if (action === 'parts') return reply(200, { parts: data.partNumbers.map(n => ({ partNumber: n, uploadUrl: `${base}/storage/${id}/${n}` })) });
      if (action === 'complete') {
        const count = Math.max(1, Math.ceil(upload.sizeBytes / upload.partSizeBytes));
        if (data.parts.length !== count) return fail(400, 'Incomplete multipart upload.');
        const parts = data.parts.map((p, index) => {
          const chunk = upload.parts.get(p.partNumber);
          if (p.partNumber !== index + 1 || !chunk || p.etag !== `"${hash(chunk)}"`) throw new Error('Invalid completed part.');
          return chunk;
        });
        const body = Buffer.concat(parts);
        if (body.length !== upload.sizeBytes || hash(body) !== data.contentHash || hash(body) !== upload.contentHash) return fail(400, 'Upload checksum mismatch.');
        const item = makeItem(id, upload.name, 'FILE', upload.parentId, body.length, { mimeType: upload.mimeType, createdAt: now(), updatedAt: now() });
        add(item, body); uploads.delete(id);
        return reply(200, { item });
      }
    }
    if (path === '/v1/downloads') {
      if (data.transferId) return reply(200, { downloadUrl: `${base}/storage/${data.entryId}`, sizeBytes: welcome.length, contentHash: hash(welcome), contentHashAlgorithm: 'SHA256' });
      const id = data.driveItemId;
      const body = id === 'corrupt' ? Buffer.from('abc') : bytes.get(id);
      if (!body) return fail(404, 'File not found.');
      return reply(200, { downloadUrl: `${base}/storage/${id}`, sizeBytes: body.length, contentHash: hash(body), contentHashAlgorithm: 'SHA256' });
    }
    if (path === '/v1/folder-downloads' && req.method === 'POST') {
      const item = items.get(data.driveItemId);
      if (!item) return fail(404, 'Folder not found.');
      const job = { id: randomUUID(), name: item.name, state: 'QUEUED', files: 0, bytes: 0, totalFiles: 1, totalBytes: welcome.length, currentFile: null, error: null, expiresAt: now(), polls: 0 };
      zips.set(job.id, job);
      return reply(200, job);
    }
    const zip = path.match(/^\/v1\/folder-downloads\/([^/]+)$/);
    if (zip) {
      const job = zips.get(zip[1]);
      if (!job) return fail(404, 'Download not found.');
      if (req.method === 'DELETE') { job.state = 'CANCELLED'; return reply(200, job); }
      job.polls++;
      if (job.polls >= 2) Object.assign(job, { state: 'READY', files: 1, bytes: welcome.length, downloadUrl: `${base}/storage/zip-${job.id}`, sizeBytes: welcome.length, contentHash: hash(welcome) });
      else Object.assign(job, { state: 'BUILDING', files: 0, bytes: 0, currentFile: `${job.name}/Shared brief.txt` });
      return reply(200, job);
    }
    const transferList = path.match(/^\/v1\/transfers\/(received|sent)$/);
    if (transferList) return reply(200, { items: transfers.filter((t) => t.direction === transferList[1]), nextCursor: null });
    if (path === '/v1/transfers' && req.method === 'POST') {
      const recipient = data.recipient?.value;
      if (!recipient || !data.items?.length) return fail(400, 'Choose a recipient.');
      const sent = data.items.map((i) => items.get(i.driveItemId)).filter(Boolean);
      transfers.push({ id: randomUUID(), direction: 'sent', state: data.recipient.type === 'EMAIL' ? 'PENDING_RECIPIENT_SIGNUP' : 'PENDING', createdAt: now(), expiresAt: new Date(Date.now() + 7 * 86400_000).toISOString(), totalSizeBytes: sent.reduce((n, i) => n + i.sizeBytes, 0), savedAt: null, preparationState: 'READY', items: sent.map((i) => entry(`entry-${i.id}`, i.name, i.sizeBytes, i.mimeType ?? undefined)), sender: profile, recipient: data.recipient.type === 'EMAIL' ? null : { displayName: recipient, username: recipient }, recipientEmail: data.recipient.type === 'EMAIL' ? recipient : null });
      return reply(200, { transfer: transfers.at(-1) });
    }
    const transferAction = path.match(/^\/v1\/transfers\/([^/]+)\/(accept|decline|cancel|save|items)$/);
    if (transferAction) {
      const transfer = transfers.find((t) => t.id === transferAction[1]);
      if (!transfer) return fail(404, 'Transfer not found.');
      const action = transferAction[2];
      if (action === 'items') return reply(200, { items: [], nextCursor: null });
      if (action === 'accept') transfer.state = 'ACCEPTED';
      if (action === 'decline') transfer.state = 'DECLINED';
      if (action === 'cancel') transfer.state = 'CANCELLED';
      if (action === 'save') transfer.savedAt = now();
      return reply(200, { transfer, items: [] });
    }
    const shareList = path.match(/^\/v1\/shares\/(received|sent)$/);
    if (shareList) return reply(200, { items: shares.filter((s) => s.direction === shareList[1] && !s.revokedAt) });
    if (path === '/v1/shares' && req.method === 'POST') {
      const item = items.get(data.driveItemId);
      if (!item) return fail(404, 'File not found.');
      shares.push({ id: randomUUID(), direction: 'sent', driveItemId: item.id, ownerUserId: 'ios-test', recipientUserId: 'sam', permission: data.permission ?? 'VIEWER', createdAt: now(), revokedAt: null, item });
      return reply(200, { share: shares.at(-1) });
    }
    const shareRoute = path.match(/^\/v1\/shares\/([^/]+)$/);
    if (shareRoute && req.method === 'DELETE') {
      const share = shares.find((s) => s.id === shareRoute[1]);
      if (share) share.revokedAt = now();
      return reply(200, { revoked: true });
    }
    if (path === '/v1/devices') return reply(200, { items: devices });
    const device = path.match(/^\/v1\/devices\/([^/]+)$/);
    if (device && req.method === 'DELETE') {
      const found = devices.find((d) => d.id === device[1]);
      if (found) found.revokedAt = now();
      return reply(200, { revoked: true });
    }
    if (path === '/v1/notifications') return reply(200, { items: notifications, nextCursor: null });
    const notice = path.match(/^\/v1\/notifications\/([^/]+)\/read$/);
    if (notice) {
      const found = notifications.find((n) => n.id === notice[1]);
      if (found) found.readAt = now();
      return reply(200, { notification: found });
    }
    fail(404, 'Unknown fixture route.');
  } catch (error) { fail(500, error.message); }
});
server.listen(port, '127.0.0.1', () => console.log(`iOS fixture API listening on ${base}`));
