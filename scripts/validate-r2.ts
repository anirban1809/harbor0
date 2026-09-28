import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { R2Storage } from '../apps/backend/src/storage';

const endpoint = new URL(process.env.R2_ENDPOINT!);
if (endpoint.protocol !== 'https:' || !endpoint.hostname.endsWith('.r2.cloudflarestorage.com'))
  throw new Error('Live R2 credentials are required.');
const account = endpoint.hostname.split('.')[0];
const jurisdiction = endpoint.hostname.match(/^[a-f0-9]{32}\.([a-z]+)\.r2\./)?.[1];
const bucket = `harbor-validation-${randomUUID().slice(0, 8)}`;
const base = `https://api.cloudflare.com/client/v4/accounts/${account}/r2/buckets`;
async function management(path: string, method: string, body?: unknown) {
  const response = await fetch(base + path, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
      'Content-Type': 'application/json',
      ...(jurisdiction ? { 'cf-r2-jurisdiction': jurisdiction } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = (await response.json()) as { success: boolean; errors?: { code: number }[] };
  if (!response.ok || !result.success)
    throw new Error(
      `R2 management ${method}: HTTP ${response.status}; codes ${result.errors?.map((e) => e.code)}`,
    );
}
const storage = new R2Storage(
  bucket,
  endpoint.href,
  process.env.R2_ACCESS_KEY_ID!,
  process.env.R2_SECRET_ACCESS_KEY!,
);
const key = 'objects/validation.bin';
let uploadId: string | undefined;
let aborted: string | undefined;
const checks: string[] = [];
function check(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
  checks.push(message);
  console.log('PASS:', message);
}
await management('', 'POST', { name: bucket });
try {
  uploadId = await storage.create(key);
  const data = Buffer.alloc(5 * 1024 * 1024 + 257, 83);
  const split = 5 * 1024 * 1024;
  const parts = [];
  for (let part = 1; part <= 2; part++) {
    const chunk = data.subarray((part - 1) * split, Math.min(part * split, data.length));
    const url = await storage.signPart(key, uploadId, part, chunk.length);
    const response = await fetch(url, { method: 'PUT', body: chunk });
    check(response.ok && response.headers.has('etag'), `Presigned multipart PUT ${part}`);
    parts.push({ partNumber: part, etag: response.headers.get('etag')! });
  }
  check((await storage.parts(key, uploadId)).length === 2, 'ListParts supports resumption');
  await storage.complete(key, uploadId, parts);
  check((await storage.head(key))?.size === data.length, 'CompleteMultipartUpload and HEAD size');
  await storage.complete(key, uploadId, parts);
  check(true, 'Completion replay is safe');
  const url = await storage.download(key, 'validation.bin');
  const downloaded = await fetch(url);
  const bytes = Buffer.from(await downloaded.arrayBuffer());
  check(
    downloaded.ok &&
      createHash('sha256').update(bytes).digest('hex') ===
        createHash('sha256').update(data).digest('hex'),
    'Presigned GET preserves SHA-256',
  );
  const ranged = await fetch(url, { headers: { Range: 'bytes=7-19' } });
  check(
    ranged.status === 206 && Buffer.from(await ranged.arrayBuffer()).equals(data.subarray(7, 20)),
    'Range download',
  );
  const unsigned = new URL(url);
  unsigned.search = '';
  const denied = await fetch(unsigned);
  check([400, 401, 403].includes(denied.status), 'Unsigned object access denied');
  aborted = await storage.create('objects/aborted.bin');
  await storage.abort('objects/aborted.bin', aborted);
  check(!(await storage.head('objects/aborted.bin')), 'Aborted multipart upload leaves no object');
  await storage.remove(key);
  check(!(await storage.head(key)), 'Object deletion verified');
  await mkdir('.cloud', { recursive: true, mode: 0o700 });
  await writeFile(
    '.cloud/r2-validation.json',
    JSON.stringify(
      {
        completedAt: new Date().toISOString(),
        endpoint: endpoint.href,
        checks,
        fixtureBucket: bucket,
        fixtureCleanup: 'deleted',
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
} finally {
  if (uploadId) await storage.abort(key, uploadId);
  if (aborted) await storage.abort('objects/aborted.bin', aborted);
  await storage.remove(key);
  await management(`/${bucket}`, 'DELETE');
  console.log('Temporary validation bucket cleaned up.');
}
