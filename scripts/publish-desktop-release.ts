import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
const web = JSON.parse(await readFile('.cloud/web-outputs.json', 'utf8')).HarborWeb;
const version = JSON.parse(await readFile('apps/desktop/package.json', 'utf8')).version;
const validation = JSON.parse(await readFile('.cloud/desktop-release-validation.json', 'utf8'));
const live = JSON.parse(await readFile('.cloud/shared-sync-validation.json', 'utf8'));
if (!validation.passed || validation.version !== version || !live.passed)
  throw new Error('Complete packaged and live validation before publishing.');
const name = `harbor0-${version}-mac-arm64.dmg`;
const file = path.join('apps/desktop/release', name);
const bytes = (await stat(file)).size;
const hasher = createHash('sha256');
for await (const chunk of createReadStream(file)) hasher.update(chunk);
const sha256 = hasher.digest('hex');
const key = `downloads/${name}`;
const s3 = new S3Client({ region: process.env.AWS_REGION });
let existing;
try {
  existing = await s3.send(new HeadObjectCommand({ Bucket: web.WebBucketName, Key: key }));
} catch (error) {
  if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode !== 404)
    throw error;
}
if (existing && existing.Metadata?.sha256 !== sha256)
  throw new Error(
    'This release version already exists with different bytes. Choose a new version.',
  );
if (!existing)
  await s3.send(
    new PutObjectCommand({
      Bucket: web.WebBucketName,
      Key: key,
      Body: createReadStream(file),
      ContentLength: bytes,
      ContentType: 'application/x-apple-diskimage',
      ContentDisposition: `attachment; filename="${name}"`,
      CacheControl: 'public,max-age=31536000,immutable',
      Metadata: { sha256, version, signing: 'unsigned' },
    }),
  );
const manifest = {
  version,
  platform: 'macOS',
  architecture: 'arm64',
  signed: false,
  notarized: false,
  sha256,
  bytes,
  url: `${web.WebUrl}/${key}`,
  publishedAt: new Date().toISOString(),
};
await s3.send(
  new PutObjectCommand({
    Bucket: web.WebBucketName,
    Key: `downloads/harbor0-${version}-mac-arm64.json`,
    Body: JSON.stringify(manifest, null, 2),
    ContentType: 'application/json',
    CacheControl: 'public,max-age=31536000,immutable',
  }),
);
const response = await fetch(manifest.url, { method: 'HEAD' });
if (!response.ok || Number(response.headers.get('content-length')) !== bytes)
  throw new Error('Public installer verification failed.');
await writeFile('.cloud/desktop-release.json', JSON.stringify(manifest, null, 2));
console.log('Desktop installer published and verified:', manifest.url);
console.log('SHA-256:', sha256);
