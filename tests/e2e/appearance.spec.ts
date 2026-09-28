import { test, expect, type BrowserContext } from '@playwright/test';
import type { AppearancePreference } from '@harbor/contracts';

test('preset themes sync across sessions, preserve custom colors and recover failed saves', async ({
  browser,
  page,
}) => {
  const accounts = new Map<string, AppearancePreference>();
  let failSave = false;
  async function mock(context: BrowserContext, id: string) {
    await context.route('**/api/**', async (route) => {
      if (new URL(route.request().url()).pathname.endsWith('/users/me')) {
        if (route.request().method() === 'PATCH') {
          if (failSave)
            return route.fulfill({ status: 503, json: { error: { message: 'Offline' } } });
          accounts.set(id, route.request().postDataJSON().appearance);
        }
        return route.fulfill({
          json: {
            user: {
              id,
              displayName: id,
              username: id,
              email: `${id}@example.test`,
              appearance: accounts.get(id),
            },
            storage: { usedBytes: 0, reservedBytes: 0, quotaBytes: 100000000000 },
          },
        });
      }
      return route.fulfill({ json: { items: [], nextCursor: null } });
    });
  }
  await mock(page.context(), 'alice');
  await page.goto('/settings');
  const appearance = page.locator('.appearance-settings');
  const saved = () => expect(appearance.getByRole('status')).toHaveText('Saved to your account.');
  await saved();
  for (const name of ['Harbor', 'Ocean', 'Forest', 'Violet', 'Sunset']) {
    const preset = appearance.getByRole('button', { name: new RegExp(`^${name} `) });
    await preset.click();
    await expect(preset).toHaveAttribute('aria-pressed', 'true');
    await saved();
  }
  await appearance.getByRole('button', { name: /^Ocean / }).click();
  await appearance.getByRole('button', { name: 'Dark', exact: true }).click();
  await saved();
  await expect(page.locator('html')).toHaveClass('dark');
  await expect(appearance.getByRole('textbox', { name: 'Accent hex color' })).toHaveValue(
    '#60a5fa',
  );
  await appearance.getByRole('textbox', { name: 'Accent hex color' }).fill('#fbbf24');
  await saved();
  await page.reload();
  await saved();
  await expect(appearance.getByRole('textbox', { name: 'Accent hex color' })).toHaveValue(
    '#fbbf24',
  );
  // A second browser session has no local storage from the first one.
  const otherContext = await browser.newContext({
    baseURL: 'http://localhost:3000',
    viewport: { width: 390, height: 844 },
  });
  try {
    await mock(otherContext, 'alice');
    const other = await otherContext.newPage();
    await other.goto('/settings');
    await expect(other.locator('.appearance-settings').getByRole('status')).toHaveText(
      'Saved to your account.',
    );
    await expect(other.locator('html')).toHaveClass('dark');
    await expect(other.getByRole('textbox', { name: 'Accent hex color' })).toHaveValue('#fbbf24');
    expect(
      await other.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await other.screenshot({ path: 'test-results/appearance-mobile.png', fullPage: true });
    await other.getByRole('button', { name: 'Reset dark colors', exact: true }).click();
    await expect(other.getByRole('textbox', { name: 'Accent hex color' })).toHaveValue('#60a5fa');
    await expect(other.locator('.appearance-settings').getByRole('status')).toHaveText(
      'Saved to your account.',
    );
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(appearance.getByRole('textbox', { name: 'Accent hex color' })).toHaveValue(
      '#60a5fa',
    );
  } finally {
    await otherContext.close();
  }
  failSave = true;
  await appearance.getByRole('button', { name: /^Forest / }).click();
  await expect(appearance.getByRole('status')).toContainText('Couldn’t save');
  failSave = false;
  await appearance.getByRole('button', { name: 'Retry', exact: true }).click();
  await saved();
  await appearance.getByRole('button', { name: 'Light', exact: true }).click();
  await saved();
  await page.screenshot({ path: 'test-results/appearance-desktop.png', fullPage: true });
  const bobContext = await browser.newContext({ baseURL: 'http://localhost:3000' });
  try {
    await mock(bobContext, 'bob');
    const bob = await bobContext.newPage();
    await bob.goto('/settings');
    await expect(bob.getByRole('button', { name: /^Harbor / })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(accounts.has('bob')).toBe(false);
  } finally {
    await bobContext.close();
  }
});
