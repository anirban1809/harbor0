import { test, expect, type Page } from '@playwright/test';

const pages = [
  ['My Drive', '/drive'],
  ['Shared', '/shared'],
  ['Favorites', '/favorites'],
  ['Trash', '/trash'],
  ['Devices', '/devices'],
  ['Storage', '/storage'],
  ['Settings', '/settings'],
  ['Notifications', '/notifications'],
] as const;

const folderItems = [
  { id: 'projects', name: 'Projects', type: 'FOLDER', parentId: null },
  { id: 'nested', name: 'Design work', type: 'FOLDER', parentId: 'projects' },
  { id: 'note', name: 'Folder note.txt', type: 'FILE', mimeType: 'text/plain', parentId: 'nested' },
].map((item) => ({
  ...item,
  ownerUserId: 'routing',
  revision: 1,
  sizeBytes: 0,
  createdAt: '2026-09-26T00:00:00Z',
  updatedAt: '2026-09-26T00:00:00Z',
}));

async function mockSession(page: Page, signedIn = true) {
  await page.route('**/api/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith('/auth/login')) signedIn = true;
    if (pathname.endsWith('/auth/logout')) signedIn = false;
    if (pathname.endsWith('/users/me')) {
      return route.fulfill(
        signedIn
          ? {
              json: {
                user: {
                  id: 'routing',
                  displayName: 'Route Tester',
                  username: 'routing',
                  email: 'routing@example.test',
                },
                storage: { usedBytes: 0, quotaBytes: 100000000000, reservedBytes: 0 },
              },
            }
          : { status: 401, json: { error: { code: 'UNAUTHORIZED', message: 'Sign in required' } } },
      );
    }
    if (pathname.endsWith('/drive/folders') && route.request().method() === 'POST')
      return route.fulfill({
        json: { item: { ...folderItems[0], ...route.request().postDataJSON(), id: 'created' } },
      });
    const itemId = pathname.match(/\/drive\/items\/([^/]+)$/)?.[1];
    const folderId = pathname.match(/\/drive\/folders\/([^/]+)\/children$/)?.[1];
    if (itemId === 'missing' || folderId === 'missing')
      return route.fulfill({
        status: 404,
        json: { error: { code: 'NOT_FOUND', message: 'This folder is unavailable.' } },
      });
    if (itemId)
      return route.fulfill({ json: { item: folderItems.find((item) => item.id === itemId) } });
    if (folderId)
      return route.fulfill({
        json: {
          items: folderItems.filter(
            (item) => item.parentId === (folderId === 'root' ? null : folderId),
          ),
          nextCursor: null,
        },
      });
    if (pathname.endsWith('/search'))
      return route.fulfill({ json: { items: [folderItems[1]], nextCursor: null } });
    return route.fulfill({ json: { items: [], nextCursor: null } });
  });
}

test('every workspace page supports direct access, reload and active navigation', async ({
  page,
}) => {
  await mockSession(page);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  for (const [name, path] of pages) {
    await page.goto(path);
    await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
    await expect(page).toHaveTitle(`${name} — harbor0`);
    if (name !== 'Notifications') {
      await expect(
        page
          .getByRole('navigation', { name: 'Main navigation' })
          .getByRole('link', { name, exact: true }),
      ).toHaveAttribute('aria-current', 'page');
    }
    await page.reload();
    await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`${path}$`));
  }
  expect(errors).toEqual([]);
});

test('links, shortcuts and browser history navigate without remounting the workspace', async ({
  page,
}) => {
  await mockSession(page);
  await page.goto('/');
  await expect(page).toHaveURL(/\/drive$/);
  // This preference is held in the workspace, so it also detects remounts.
  await page.getByRole('button', { name: 'Grid view', exact: true }).click();
  for (const [name, path] of pages) {
    if (name === 'Notifications') {
      await page.getByRole('button', { name: 'Activity notifications', exact: true }).click();
      await page.getByRole('button', { name: 'All notifications', exact: true }).click();
    } else {
      await page.locator('.sidebar').getByRole('link', { name, exact: true }).click();
    }
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  }
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  await page.goForward();
  await expect(page.getByRole('heading', { name: 'Notifications', exact: true })).toBeVisible();
  await page.locator('.topbar').getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: 'Account settings' }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await page.getByRole('button', { name: 'Manage storage' }).click();
  await expect(page).toHaveURL(/\/storage$/);
  await page.getByRole('link', { name: 'harbor0 home' }).click();
  await expect(page).toHaveURL(/\/drive$/);
  await expect(page.getByRole('button', { name: 'Grid view', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});

test('sign-in returns to the requested page and sign-out protects it', async ({ page }) => {
  await mockSession(page, false);
  await page.goto('/settings');
  await expect(page).toHaveURL(/\/login\?next=%2Fsettings$/);
  await page.getByLabel('Email', { exact: true }).fill('routing@example.test');
  await page.getByLabel('Password', { exact: true }).fill('Development-only-123!');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  await page.locator('.topbar').getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: 'Sign out', exact: true }).click();
  await expect(page).toHaveURL(/\/login\?next=%2Fsettings$/);
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
});

test('account creation and recovery have routes and preserve the entered email', async ({
  page,
}) => {
  await mockSession(page, false);
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill('routing@example.test');
  await page.getByRole('link', { name: 'New here? Create an account' }).click();
  await expect(page).toHaveURL(/\/signup\?/);
  await expect(page.getByLabel('Email', { exact: true })).toHaveValue('routing@example.test');
  await page.getByLabel('Display name').fill('Route Tester');
  await page.getByLabel('Username', { exact: true }).fill('routing');
  await page.getByLabel('Password', { exact: true }).fill('Development-only-123!');
  await page.getByRole('button', { name: 'Create your account' }).click();
  await expect(page).toHaveURL(/\/confirm\?/);
  await expect(page.getByLabel('Email', { exact: true })).toHaveValue('routing@example.test');
  await page.getByLabel('Verification code').fill('123456');
  await page.getByRole('button', { name: 'Verify email', exact: true }).click();
  await expect(page).toHaveURL(/\/login\?/);
  await page.getByRole('link', { name: 'Forgot password?' }).click();
  await expect(page).toHaveURL(/\/forgot-password\?/);
  await page.getByRole('button', { name: 'Send reset code', exact: true }).click();
  await expect(page).toHaveURL(/\/reset-password\?/);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Reset password', exact: true })).toBeVisible();
});

test('unknown routes return 404 and login cannot redirect outside the app', async ({ page }) => {
  await mockSession(page);
  const response = await page.goto('/not-a-page');
  expect(response?.status()).toBe(404);
  await page.goto('/login?next=https%3A%2F%2Fexample.com');
  await expect(page).toHaveURL(/\/drive$/);
});

test('folder URLs survive refresh, restore breadcrumbs, and support history and direct links', async ({
  page,
}) => {
  await mockSession(page);
  await page.goto('/drive');
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await expect(page).toHaveURL(/\/drive\?folder=projects$/);
  await page.getByRole('button', { name: 'Design work', exact: true }).click();
  await expect(page).toHaveURL(/\/drive\?folder=nested$/);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Folder note.txt', exact: true })).toBeVisible();
  await expect(
    page.locator('.breadcrumbs').getByRole('link', { name: 'Projects', exact: true }),
  ).toBeVisible();
  await expect(
    page.locator('.breadcrumbs').getByRole('link', { name: 'Design work', exact: true }),
  ).toHaveAttribute('aria-current', 'location');
  await page.goBack();
  await expect(page).toHaveURL(/\/drive\?folder=projects$/);
  await expect(page.getByRole('button', { name: 'Design work', exact: true })).toBeVisible();
  await page.goForward();
  await expect(page.getByRole('button', { name: 'Folder note.txt', exact: true })).toBeVisible();
  const direct = await page.context().newPage();
  await mockSession(direct);
  await direct.goto(page.url());
  await expect(direct.getByRole('button', { name: 'Folder note.txt', exact: true })).toBeVisible();
  await expect(
    direct.locator('.breadcrumbs').getByRole('link', { name: 'Projects', exact: true }),
  ).toBeVisible();
  await direct.close();
  await page.locator('.breadcrumbs').getByRole('link', { name: 'Projects', exact: true }).click();
  await expect(page).toHaveURL(/\/drive\?folder=projects$/);
  await page
    .getByRole('navigation', { name: 'Drive location' })
    .getByRole('link', { name: 'My Drive', exact: true })
    .click();
  await expect(page).toHaveURL(/\/drive$/);
  await expect(page.getByRole('button', { name: 'Projects', exact: true })).toBeVisible();
});

test('folder links survive sign-in and new folders use the restored parent', async ({ page }) => {
  await mockSession(page, false);
  await page.goto('/drive?folder=nested');
  await expect(page).toHaveURL(/\/login\?next=%2Fdrive%3Ffolder%3Dnested$/);
  await page.getByLabel('Email', { exact: true }).fill('routing@example.test');
  await page.getByLabel('Password', { exact: true }).fill('Development-only-123!');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/drive\?folder=nested$/);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Folder note.txt', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'New folder', exact: true }).click();
  await page.getByRole('textbox', { name: 'Folder name', exact: true }).fill('New subfolder');
  const request = page.waitForRequest(
    (request) => request.method() === 'POST' && request.url().endsWith('/drive/folders'),
  );
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  expect((await request).postDataJSON()).toMatchObject({
    parentId: 'nested',
    name: 'New subfolder',
  });
});

test('opening a favorite folder restores its actual ancestors and My Drive returns to root', async ({
  page,
}) => {
  await mockSession(page);
  await page.goto('/favorites');
  await page.getByRole('button', { name: 'Design work', exact: true }).click();
  await expect(page).toHaveURL(/\/drive\?folder=nested$/);
  await expect(
    page.locator('.breadcrumbs').getByRole('link', { name: 'Projects', exact: true }),
  ).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('link', { name: 'My Drive', exact: true })
    .click();
  await expect(page).toHaveURL(/\/drive$/);
  await expect(page.getByRole('button', { name: 'Projects', exact: true })).toBeVisible();
});

test('an unavailable folder reports an error without falling back to root', async ({ page }) => {
  await mockSession(page);
  const rootRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/folders/root/children')) rootRequests.push(request.url());
  });
  await page.goto('/drive?folder=missing');
  await expect(
    page.getByRole('alert').filter({ hasText: 'This folder is unavailable.' }),
  ).toBeVisible({ timeout: 15000 });
  await expect(page).toHaveURL(/\/drive\?folder=missing$/);
  expect(rootRequests).toEqual([]);
});

test('Shared tabs support direct links, reload, history and legacy links', async ({ page }) => {
  await mockSession(page);
  await page.goto('/shared');
  const received = page.getByRole('tab', { name: 'Received', exact: true });
  const sent = page.getByRole('tab', { name: 'Sent', exact: true });
  await expect(received).toHaveAttribute('aria-selected', 'true');
  await sent.click();
  await expect(page).toHaveURL(/\/shared\?tab=sent$/);
  await expect(sent).toHaveAttribute('aria-selected', 'true');
  await page.reload();
  await expect(sent).toHaveAttribute('aria-selected', 'true');
  await page.goBack();
  await expect(received).toHaveAttribute('aria-selected', 'true');
  await page.goForward();
  await expect(sent).toHaveAttribute('aria-selected', 'true');
  for (const [path, tab] of [
    ['/received', 'Received'],
    ['/sent', 'Sent'],
  ]) {
    await page.goto(path);
    await expect(page).toHaveURL(tab === 'Sent' ? /\/shared\?tab=sent$/ : /\/shared$/);
    await expect(page.getByRole('heading', { name: 'Shared', exact: true })).toBeVisible();
    await expect(page.getByRole('tab', { name: tab, exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  }
});

test('signing in preserves the selected Shared tab', async ({ page }) => {
  await mockSession(page, false);
  await page.goto('/shared?tab=sent');
  await expect(page).toHaveURL(/\/login\?next=%2Fshared%3Ftab%3Dsent$/);
  await page.getByLabel('Email', { exact: true }).fill('routing@example.test');
  await page.getByLabel('Password', { exact: true }).fill('Example-password-123!');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/shared\?tab=sent$/);
  await expect(page.getByRole('tab', { name: 'Sent', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
});

test('Shared keeps received and sent access grants in their matching tabs', async ({ page }) => {
  await mockSession(page);
  await page.route('**/api/v1/shares/*', async (route) => {
    const sent = route.request().url().endsWith('/sent');
    return route.fulfill({
      json: {
        items: [
          {
            id: sent ? 'outgoing' : 'incoming',
            ownerUserId: sent ? 'routing' : 'someone-else',
            permission: 'VIEWER',
            item: { ...folderItems[0], name: sent ? 'Team documents' : 'Client documents' },
          },
        ],
      },
    });
  });
  await page.goto('/shared');
  await expect(page.getByRole('button', { name: /Client documents/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Team documents/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Remove access', exact: true })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Sent', exact: true }).click();
  await expect(page.getByRole('button', { name: /Team documents/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Client documents/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Remove access', exact: true })).toBeVisible();
});
