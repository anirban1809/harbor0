import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
test('Alice uploads, downloads, sends; Bob accepts and saves', async ({ browser }) => {
  const alice = await browser.newContext();
  const bob = await browser.newContext();
  const page = await alice.newPage();
  await page.goto('/');
  await page.getByLabel('Email', { exact: true }).fill('alice@example.test');
  await page.getByLabel('Password', { exact: true }).fill('Development-only-123!');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'My Drive', exact: true })).toBeVisible();
  const name = `test-${Date.now()}.txt`;
  const content = Buffer.from('Private files, shared only with authenticated people.');
  await page
    .locator('input[type=file]')
    .first()
    .setInputFiles({ name, mimeType: 'text/plain', buffer: content });
  await expect(page.getByRole('button', { name, exact: true })).toBeVisible({ timeout: 30000 });
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: `Actions for ${name}` }).click();
  await page.getByRole('menuitem', { name: 'Download', exact: true }).click();
  const downloaded = await downloadPromise;
  const data = await readFile((await downloaded.path())!);
  expect(createHash('sha256').update(data).digest('hex')).toBe(
    createHash('sha256').update(content).digest('hex'),
  );
  await page.getByRole('button', { name: `Actions for ${name}` }).click();
  await page.getByRole('menuitem', { name: 'Send', exact: true }).click();
  await page.getByLabel('To', { exact: true }).fill('@bob');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.screenshot({ path: 'test-results/drive-desktop.png', fullPage: true });
  const recipient = await bob.newPage();
  await recipient.goto('/');
  await recipient.getByLabel('Email', { exact: true }).fill('bob@example.test');
  await recipient.getByLabel('Password', { exact: true }).fill('Development-only-123!');
  await recipient.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(recipient.getByRole('heading', { name: 'My Drive', exact: true })).toBeVisible();
  await recipient.getByRole('link', { name: 'Received', exact: true }).click();
  const card = recipient.locator('article').filter({ hasText: name });
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'Accept', exact: true }).click();
  await card.getByRole('button', { name: 'Save to My Drive', exact: true }).click();
  await expect(card.getByRole('button', { name: 'Saved to My Drive', exact: true })).toBeDisabled();
  await recipient.locator('.sidebar').getByRole('link', { name: 'My Drive', exact: true }).click();
  await expect(recipient.getByRole('button', { name, exact: true })).toBeVisible();
  await recipient.setViewportSize({ width: 390, height: 844 });
  await recipient.screenshot({ path: 'test-results/drive-mobile.png', fullPage: true });
  await alice.close();
  await bob.close();
});
test('signup and verified email claim an invitation', async ({ browser }) => {
  const alice = await browser.newContext();
  const page = await alice.newPage();
  await page.goto('/');
  await page.getByLabel('Email', { exact: true }).fill('alice@example.test');
  await page.getByLabel('Password', { exact: true }).fill('Development-only-123!');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const name = `invitation-${Date.now()}.txt`;
  const recipientEmail = `charlie${Date.now()}@example.test`;
  await page
    .locator('input[type=file]')
    .first()
    .setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from('Invitation content') });
  await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
  await page.getByRole('button', { name: `Actions for ${name}` }).click();
  await page.getByRole('menuitem', { name: 'Send', exact: true }).click();
  await page.getByLabel('To', { exact: true }).fill(recipientEmail);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  const charlie = await browser.newContext();
  const recipient = await charlie.newPage();
  await recipient.goto('/');
  await recipient.getByRole('link', { name: 'New here? Create an account' }).click();
  await recipient.getByLabel('Email', { exact: true }).fill(recipientEmail);
  await recipient.getByLabel('Display name').fill('Charlie');
  await recipient.getByLabel('Username', { exact: true }).fill(recipientEmail.split('@')[0]);
  await recipient.getByLabel('Password', { exact: true }).fill('Development-only-123!');
  await recipient.getByRole('button', { name: 'Create your account' }).click();
  await recipient.getByLabel('Verification code').fill('123456');
  await recipient.getByRole('button', { name: 'Verify email', exact: true }).click();
  await recipient.getByLabel('Password', { exact: true }).fill('Development-only-123!');
  await recipient.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(recipient.getByRole('heading', { name: 'My Drive', exact: true })).toBeVisible();
  await recipient.getByRole('link', { name: 'Received', exact: true }).click();
  const card = recipient.locator('article').filter({ hasText: name });
  await card.getByRole('button', { name: 'Accept', exact: true }).click();
  await expect(card.getByRole('button', { name: 'Save to My Drive' })).toBeVisible();
  await alice.close();
  await charlie.close();
});
