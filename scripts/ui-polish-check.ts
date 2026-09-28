import { chromium, _electron as electron, expect, type Page } from '@playwright/test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Isolated presentation fixtures; never connects to or changes an account.
const output = 'test-results/ui-polish';
await mkdir(output, { recursive: true });
const origin = process.env.UI_POLISH_URL ?? 'http://127.0.0.1:3000';
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}
async function contained(inner: ReturnType<Page['locator']>, outer: ReturnType<Page['locator']>) {
  const a = await inner.boundingBox();
  const b = await outer.boundingBox();
  expect(a).not.toBeNull();
  expect(b).not.toBeNull();
  expect(a!.x).toBeGreaterThanOrEqual(b!.x);
  expect(a!.y).toBeGreaterThanOrEqual(b!.y);
  expect(a!.x + a!.width).toBeLessThanOrEqual(b!.x + b!.width);
  expect(a!.y + a!.height).toBeLessThanOrEqual(b!.y + b!.height);
}
const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    reducedMotion: 'reduce',
  });
  const failures: string[] = [];
  page.on('pageerror', (e) => failures.push(e.message));
  let signedIn = false;
  await page.route('**/api/**', (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith('/v1/users/me'))
      return route.fulfill({
        status: signedIn ? 200 : 401,
        json: signedIn
          ? {
              user: {
                id: 'preview',
                displayName: 'UI Preview',
                username: 'preview',
                email: 'preview@example.test',
              },
              storage: {
                usedBytes: 2400000,
                reservedBytes: 0,
                availableBytes: 99997600000,
                quotaBytes: 100000000000,
              },
            }
          : { error: { code: 'UNAUTHORIZED', message: 'Sign in' } },
      });
    if (pathname.includes('/folders/'))
      return route.fulfill({
        json: {
          items: [
            {
              id: 'file',
              name: 'Project specifications and supporting documentation.pdf',
              type: 'FILE',
              mimeType: 'application/pdf',
              sizeBytes: 2400000,
              updatedAt: '2026-09-27T10:00:00Z',
            },
          ],
          nextCursor: null,
        },
      });
    return route.fulfill({ json: { items: [], nextCursor: null } });
  });
  for (const route of ['login', 'signup', 'confirm', 'forgot-password', 'reset-password']) {
    await page.goto(`${origin}/${route}`);
    await expect(page.locator('.auth-form h2')).toBeVisible();
    for (const width of [1440, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await noOverflow(page);
      const submit = page.locator('button[type="submit"]');
      await submit.scrollIntoViewIfNeeded();
      await expect(submit).toBeInViewport();
      await page.evaluate(() => scrollTo(0, 0));
      if (width === 1440 || width === 390)
        await page.screenshot({ path: `${output}/web-${route}-${width}.png`, fullPage: true });
    }
  }
  signedIn = true;
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${origin}/drive`);
  await expect(page.locator('.file-entry-row')).toHaveCount(1);
  await page.evaluate(() => {
    document.body.tabIndex = -1;
    document.body.focus();
    document.body.removeAttribute('tabindex');
  });
  // Development tooling may precede the app in the tab order.
  const skip = page.getByRole('link', { name: 'Skip to content' });
  for (let index = 0; index < 4; index++) {
    await page.keyboard.press('Tab');
    if (await skip.evaluate((el) => el === document.activeElement)) break;
  }
  await expect(skip).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#workspace-content')).toBeFocused();
  await page.getByRole('button', { name: 'Grid view', exact: true }).click();
  const card = page.locator('.file-entry-card');
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await noOverflow(page);
    await contained(card.getByRole('button', { name: /^Actions for/ }), card);
    await contained(card.getByRole('checkbox'), card);
    await contained(card.locator('.file-entry-label'), card);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: `${output}/web-grid.png`, fullPage: true });
  await card.getByRole('button', { name: /^Actions for/ }).click();
  await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
  await expect(page.getByRole('dialog').getByLabel('Name', { exact: true })).toBeFocused();
  await page.setViewportSize({ width: 320, height: 568 });
  await noOverflow(page);
  await page.screenshot({ path: `${output}/web-dialog-320.png`, fullPage: true });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(card.getByRole('button', { name: /^Actions for/ })).toBeFocused();
  const duration = await page
    .locator('.upload-button')
    .evaluate((el) => getComputedStyle(el).transitionDuration);
  expect(parseFloat(duration)).toBeLessThanOrEqual(0.00001);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('button', { name: 'Switch to dark theme' }).click();
  await page.screenshot({ path: `${output}/web-grid-dark.png`, fullPage: true });
  expect(failures).toEqual([]);
  console.log(
    'PASS: all five authentication pages at four widths, grid controls inside cards, long names, keyboard skip link, modal focus restoration, reduced motion and dark mode',
  );
} finally {
  await browser.close();
}

const profile = await mkdtemp(path.join(os.tmpdir(), 'harbor-polish-'));
const app = await electron.launch({
  args: ['apps/desktop', `--user-data-dir=${profile}`],
  env: {
    ...process.env,
    HARBOR_DEV_AUTH: 'false',
    HARBOR_API_URL: 'https://preview.invalid',
    HARBOR_COGNITO_DOMAIN: 'https://auth.invalid',
    HARBOR_COGNITO_CLIENT_ID: 'fixture',
  },
});
try {
  const page = await app.firstWindow();
  await expect(page.getByRole('heading', { name: 'Sign in to harbor0' })).toBeVisible();
  for (const [width, height] of [
    [1440, 900],
    [840, 620],
  ]) {
    await app.evaluate(
      ({ BrowserWindow }, { width, height }) =>
        BrowserWindow.getAllWindows()[0].setContentSize(width, height),
      { width, height },
    );
    await noOverflow(page);
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeInViewport();
    await page.screenshot({ path: `${output}/desktop-login-${width}.png`, fullPage: true });
  }
  console.log('PASS: native desktop sign-in at full and compact window sizes');
} finally {
  await app.close();
  await rm(profile, { recursive: true, force: true });
}
