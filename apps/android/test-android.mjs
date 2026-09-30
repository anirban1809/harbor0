/* global console, process, fetch, setTimeout */
// Runs Android tests with disposable local services and cleans up only its own resources.
import { mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { DynamoDBClient, DeleteTableCommand } from '@aws-sdk/client-dynamodb';
import {
  S3Client,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  DeleteBucketCommand,
  ListMultipartUploadsCommand,
  AbortMultipartUploadCommand,
} from '@aws-sdk/client-s3';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const name = `harbor-android-${Date.now()}`;
const env = {
  ...process.env,
  HARBOR_ANDROID_INTEGRATION: 'true',
  NODE_ENV: 'development',
  DEV_AUTH: 'true',
  PORT: '18990',
  AWS_REGION: 'us-east-1',
  AWS_ACCESS_KEY_ID: 'local',
  AWS_SECRET_ACCESS_KEY: 'local',
  TABLE_NAME: name,
  DYNAMODB_ENDPOINT: 'http://127.0.0.1:8100',
  R2_BUCKET: name,
  R2_ENDPOINT: 'http://127.0.0.1:9100',
  R2_ACCESS_KEY_ID: 'local-storage',
  R2_SECRET_ACCESS_KEY: 'local-development-secret',
};
const run = async (cmd, args) => {
  const child = spawn(cmd, args, { cwd: root, env, stdio: 'inherit' });
  const [code] = await once(child, 'exit');
  if (code) throw new Error(`${cmd} exited with ${code}`);
};
const services = [];
const start = (cmd, args) => {
  const child = spawn(cmd, args, { cwd: root, env, stdio: 'inherit' });
  services.push(child);
  return child;
};
const ready = async (url, child) => {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (child.exitCode !== null) throw new Error('Local test service exited early.');
    try {
      await fetch(url);
      return;
    } catch {
      /* Wait for the local test service to bind its port. */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('Local test service did not start.');
};
const db = new DynamoDBClient({
  endpoint: env.DYNAMODB_ENDPOINT,
  region: env.AWS_REGION,
  credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
});
const s3 = new S3Client({
  endpoint: env.R2_ENDPOINT,
  region: 'auto',
  forcePathStyle: true,
  credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY },
});
try {
  for (const port of [18989, 18990]) {
    try {
      await fetch(`http://127.0.0.1:${port}/health`);
      throw new Error(`Port ${port} is already in use; stop the previous test server first.`);
    } catch (error) {
      if (!error.cause) throw error;
    }
  }
  await run('node', ['--import', 'tsx', 'scripts/local-setup.ts']);
  const fixture = start('node', ['apps/android/fixture-server.mjs']);
  const backend = start('node', ['--import', 'tsx', 'apps/backend/src/local.ts']);
  await Promise.all([
    ready('http://127.0.0.1:18989/health', fixture),
    ready('http://127.0.0.1:18990/health', backend),
  ]);
  const adb = process.env.ANDROID_HOME ? `${process.env.ANDROID_HOME}/platform-tools/adb` : 'adb';
  await run(adb, ['reverse', 'tcp:18989', 'tcp:18989']);
  await run('apps/android/gradlew', [
    '-p',
    'apps/android',
    ':app:testDebugUnitTest',
    '--rerun-tasks',
  ]);
  await run('apps/android/gradlew', [
    '-p',
    'apps/android',
    ':app:connectedDebugAndroidTest',
    '-PharborApiUrl=http://127.0.0.1:18989',
    ...process.argv.slice(2),
  ]);
  const screenshots = [
    '01-sign-in',
    '02-drive',
    '03-backup-files',
    '04-backup-history',
    '05-download-verified',
    '06-ocean-drive',
    '07-violet-dark',
    '08-restored-session',
  ];
  await mkdir(resolve(root, 'apps/android/build/screenshots'), { recursive: true });
  for (const name of screenshots) {
    await run(adb, [
      'pull',
      `/sdcard/Download/harbor0-${name}.png`,
      `apps/android/build/screenshots/${name}.png`,
    ]);
  }
  // Leave the distributable debug APK connected to production, never to test fixtures.
  await run('apps/android/gradlew', [
    '-p',
    'apps/android',
    ':app:assembleDebug',
    ':app:assembleRelease',
    ':app:lintDebug',
  ]);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  for (const child of services) child.kill('SIGTERM');
  try {
    const multipart = await s3.send(new ListMultipartUploadsCommand({ Bucket: name }));
    for (const upload of multipart.Uploads ?? [])
      await s3.send(
        new AbortMultipartUploadCommand({
          Bucket: name,
          Key: upload.Key,
          UploadId: upload.UploadId,
        }),
      );
    for (;;) {
      const result = await s3.send(new ListObjectsV2Command({ Bucket: name }));
      if (!result.Contents?.length) break;
      await s3.send(
        new DeleteObjectsCommand({
          Bucket: name,
          Delete: { Objects: result.Contents.map((o) => ({ Key: o.Key })) },
        }),
      );
    }
    await s3.send(new DeleteBucketCommand({ Bucket: name }));
  } catch (error) {
    if (error.name !== 'NoSuchBucket') {
      console.error('Test bucket cleanup failed:', error.message);
      process.exitCode = 1;
    }
  }
  try {
    await db.send(new DeleteTableCommand({ TableName: name }));
  } catch (error) {
    if (error.name !== 'ResourceNotFoundException') {
      console.error('Test table cleanup failed:', error.message);
      process.exitCode = 1;
    }
  }
  console.log(`Local test resources cleaned: ${name}`);
}
