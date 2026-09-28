import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, expect } from '@playwright/test';
import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  AdminDeleteUserCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { ZipReader, Uint8ArrayReader, Uint8ArrayWriter } from '@zip.js/zip.js';

const output = JSON.parse(await readFile('.cloud/outputs.json', 'utf8')).HarborStorage;
const origin = process.env.WEB_ORIGIN!;
const cognito = new CognitoIdentityProviderClient({ region: process.env.AWS_REGION });
const username = 'qa_zip_' + randomUUID().replaceAll('-', '').slice(0, 14);
const email = username + '@example.invalid';
const password = 'Live!' + randomBytes(20).toString('hex');
const folderName = 'ZIP validation ' + username;
const checks: string[] = [];
let passed = false;
let root: { id: string; revision: number } | undefined;
let archiveId: string | undefined;
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ acceptDownloads: true });
async function api(path: string, method = 'GET', body?: unknown) {
  const response = await context.request.fetch(origin + '/api' + path, {
    method,
    headers: { Origin: origin },
    ...(body ? { data: body } : {}),
  });
  const result = await response.json();
  assert.equal(response.ok(), true, `${path}: ${result.error?.message ?? response.status()}`);
  return result;
}
function pass(message: string) {
  checks.push(message);
  console.log('PASS:', message);
}
let created = false;
try {
  await cognito.send(
    new AdminCreateUserCommand({
      UserPoolId: output.UserPoolId,
      Username: email,
      MessageAction: 'SUPPRESS',
      UserAttributes: [
        { Name: 'email', Value: email },
        { Name: 'email_verified', Value: 'true' },
        { Name: 'preferred_username', Value: username },
        { Name: 'name', Value: 'ZIP validation' },
      ],
    }),
  );
  created = true;
  await cognito.send(
    new AdminSetUserPasswordCommand({
      UserPoolId: output.UserPoolId,
      Username: email,
      Password: password,
      Permanent: true,
    }),
  );
  await api('/v1/auth/login', 'POST', {
    email,
    password,
    platform: 'WEB',
    deviceName: 'ZIP deployment validation',
  });
  root = (
    await api('/v1/drive/folders', 'POST', {
      operationId: randomUUID(),
      name: folderName,
      parentId: null,
    })
  ).item;
  const nested = (
    await api('/v1/drive/folders', 'POST', {
      operationId: randomUUID(),
      name: 'Nested',
      parentId: root!.id,
    })
  ).item;
  await api('/v1/drive/folders', 'POST', {
    operationId: randomUUID(),
    name: 'Empty',
    parentId: root!.id,
  });
  const bytes = Buffer.alloc(18 * 1024 * 1024, 97);
  const hash = createHash('sha256').update(bytes).digest('hex');
  const { upload } = await api('/v1/uploads', 'POST', {
    operationId: randomUUID(),
    parentId: nested.id,
    name: 'résumé.bin',
    mimeType: 'application/octet-stream',
    sizeBytes: bytes.length,
    contentHash: hash,
  });
  const parts: { partNumber: number; etag: string }[] = [];
  for (let offset = 0; offset < bytes.length; offset += upload.partSizeBytes) {
    const partNumber = parts.length + 1;
    const signed = await api(`/v1/uploads/${upload.id}/parts`, 'POST', {
      partNumbers: [partNumber],
    });
    const response = await fetch(signed.parts[0].uploadUrl, {
      method: 'PUT',
      body: bytes.subarray(offset, offset + upload.partSizeBytes),
    });
    assert(response.ok);
    parts.push({ partNumber, etag: response.headers.get('etag')! });
  }
  await api(`/v1/uploads/${upload.id}/complete`, 'POST', { parts, contentHash: hash });
  pass('Created isolated 18 MiB fixture in private R2 storage');
  const page = await context.newPage();
  let contentRequests = 0;
  let individualDownloads = 0;
  page.on('request', (request) => {
    if (
      request.method() === 'GET' &&
      new URL(request.url()).hostname.endsWith('.r2.cloudflarestorage.com')
    )
      contentRequests++;
    if (new URL(request.url()).pathname.endsWith('/v1/downloads')) individualDownloads++;
  });
  await page.goto(origin + '/drive');
  await page.getByRole('button', { name: `Actions for ${folderName}`, exact: true }).click();
  const jobResponse = page.waitForResponse(
    (r) => r.url().endsWith('/v1/folder-downloads') && r.request().method() === 'POST',
  );
  const downloading = page.waitForEvent('download', { timeout: 240000 });
  await page.getByRole('menuitem', { name: 'Download as ZIP', exact: true }).click();
  const job = await (await jobResponse).json();
  assert(job.id, job.error?.message ?? 'Missing archive ID');
  archiveId = job.id;
  await expect(page.getByRole('status', { name: 'ZIP download status' })).toBeVisible();
  pass('Deployed web app shows ZIP preparation status');
  await page.screenshot({ path: '.cloud/live-zip-preparing.png' });
  const download = await downloading;
  assert.equal(download.suggestedFilename(), folderName + '.zip');
  const archive = await readFile((await download.path())!);
  const status = await api(`/v1/folder-downloads/${archiveId}`);
  assert.equal(status.state, 'READY');
  assert.equal(status.files, 1);
  assert.equal(status.totalBytes, bytes.length);
  assert.equal(createHash('sha256').update(archive).digest('hex'), status.contentHash);
  const reader = new ZipReader(new Uint8ArrayReader(archive), {
    useWebWorkers: false,
    checkSignature: true,
  });
  const entries = await reader.getEntries();
  assert(entries.some((e) => e.filename === `${folderName}/Empty/` && e.directory));
  const file = entries.find((e) => e.filename.endsWith('/Nested/résumé.bin'))!;
  assert(file && !file.directory);
  const extracted = await file.getData(new Uint8ArrayWriter());
  assert.equal(createHash('sha256').update(extracted).digest('hex'), hash);
  await reader.close();
  assert.equal(contentRequests, 1);
  assert.equal(individualDownloads, 0);
  pass('AWS Lambda prepares a valid multipart ZIP with nested, empty and Unicode entries');
  pass('Browser downloads exactly one archive with verified contents and SHA-256');
  await expect(page.getByRole('status').filter({ hasText: 'download started' })).toBeVisible();
  passed = true;
} finally {
  let cleanupComplete = false;
  try {
    if (archiveId) await api(`/v1/folder-downloads/${archiveId}`, 'DELETE');
    if (root) {
      const { item } = await api(`/v1/drive/items/${root.id}`, 'DELETE', {
        operationId: randomUUID(),
        baseRevision: root.revision,
      });
      await api(`/v1/drive/items/${root.id}/permanent`, 'DELETE', {
        operationId: randomUUID(),
        baseRevision: item.revision,
      });
      await new LambdaClient({ region: process.env.AWS_REGION }).send(
        new InvokeCommand({
          FunctionName: output.MaintenanceFunctionName,
          InvocationType: 'Event',
        }),
      );
      for (let i = 0; i < 30; i++) {
        if ((await api('/v1/users/me')).storage.usedBytes === 0) break;
        if (i % 3 === 0)
          await new LambdaClient({ region: process.env.AWS_REGION }).send(
            new InvokeCommand({
              FunctionName: output.MaintenanceFunctionName,
              InvocationType: 'Event',
            }),
          );
        await delay(2000);
      }
      assert.equal(
        (await api('/v1/users/me')).storage.usedBytes,
        0,
        'Fixture cleanup did not finish',
      );
      pass('Removed synthetic folder and released its storage quota');
    }
    cleanupComplete = true;
  } finally {
    await browser.close();
    if (created)
      await cognito.send(
        new AdminDeleteUserCommand({ UserPoolId: output.UserPoolId, Username: email }),
      );
    await writeFile(
      '.cloud/live-zip-validation.json',
      JSON.stringify(
        {
          completedAt: new Date().toISOString(),
          webOrigin: origin,
          passed: passed && cleanupComplete,
          checks,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  }
}
