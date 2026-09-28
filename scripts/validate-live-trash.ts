import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  AdminDeleteUserCommand,
} from '@aws-sdk/client-cognito-identity-provider';

// Exercise the published app using a disposable account, never an existing user's trash.
const { HarborStorage: backend } = JSON.parse(await readFile('.cloud/outputs.json', 'utf8'));
const { HarborWeb: web } = JSON.parse(await readFile('.cloud/web-outputs.json', 'utf8'));
const cognito = new CognitoIdentityProviderClient({ region: process.env.AWS_REGION });
const username = `qa_trash_${randomUUID().replaceAll('-', '').slice(0, 14)}`;
const email = `${username}@example.invalid`;
const password = `Live!${randomBytes(20).toString('hex')}`;
const checks: string[] = [];
const check = (message: string) => {
  checks.push(message);
  console.log(`PASS: ${message}`);
};
let passed = false;
await cognito.send(
  new AdminCreateUserCommand({
    UserPoolId: backend.UserPoolId,
    Username: email,
    MessageAction: 'SUPPRESS',
    UserAttributes: [
      { Name: 'email', Value: email },
      { Name: 'email_verified', Value: 'true' },
      { Name: 'preferred_username', Value: username },
      { Name: 'name', Value: 'Trash deployment validation' },
    ],
  }),
);
const browser = await chromium.launch();
try {
  await cognito.send(
    new AdminSetUserPasswordCommand({
      UserPoolId: backend.UserPoolId,
      Username: email,
      Password: password,
      Permanent: true,
    }),
  );
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(web.WebUrl);
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'My Drive', exact: true })).toBeVisible({
    timeout: 45000,
  });
  check('Published web app signs in through the deployed backend');
  const request = async (path: string, method: string, body?: unknown) => {
    const response = await context.request.fetch(`${web.WebUrl}/api${path}`, {
      method,
      headers: { Origin: web.WebUrl },
      ...(body ? { data: body } : {}),
    });
    assert.ok(response.ok(), `${method} ${path} returned ${response.status()}`);
    return response.json();
  };
  for (let i = 0; i < 12; i++) {
    const { item } = await request('/v1/drive/folders', 'POST', {
      operationId: randomUUID(),
      name: `Deployment trash ${i}`,
      parentId: null,
    });
    await request(`/v1/drive/items/${item.id}`, 'DELETE', {
      operationId: randomUUID(),
      baseRevision: item.revision,
    });
  }
  check('Created and trashed 12 disposable folders across multiple cleanup batches');
  await page.locator('.sidebar').getByRole('link', { name: 'Trash', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Empty Trash', exact: true })).toBeEnabled({
    timeout: 15000,
  });
  await page.getByRole('button', { name: 'Empty Trash', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('items on other pages');
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal((await request('/v1/search?trash=true', 'GET')).items.length, 12);
  check('Cancelling Empty Trash preserves the trashed folders');
  const batches: number[] = [];
  page.on('response', (response) => {
    if (response.url().endsWith('/api/v1/drive/trash/empty')) batches.push(response.status());
  });
  await page.getByRole('button', { name: 'Empty Trash', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Empty Trash', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 45000 });
  await expect(page.getByRole('button', { name: 'Empty Trash', exact: true })).toBeDisabled();
  assert.ok(batches.length >= 2 && batches.every((status) => status === 200));
  assert.equal((await request('/v1/search?trash=true', 'GET')).items.length, 0);
  check('Live Empty Trash clears every batch and immediately hides deleted items');
  await page.reload();
  await expect(page.getByRole('button', { name: 'Empty Trash', exact: true })).toBeDisabled();
  await page.screenshot({ path: '.cloud/live-trash.png', fullPage: true });
  check('Published Trash route remains empty after reload');
  passed = true;
} finally {
  await browser.close();
  await cognito.send(
    new AdminDeleteUserCommand({ UserPoolId: backend.UserPoolId, Username: email }),
  );
  await writeFile(
    '.cloud/live-trash-validation.json',
    JSON.stringify(
      {
        completedAt: new Date().toISOString(),
        webUrl: web.WebUrl,
        passed,
        checks,
        syntheticCognitoUserRemoved: true,
      },
      null,
      2,
    ),
  );
  console.log('Disposable validation identity removed.');
}
