import { chromium, expect, _electron as electron, type Page } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Isolated fixtures exercise the real browser/Electron media and text loaders.
const output = 'test-results/previews';
await mkdir(output, { recursive: true });
const wave = Buffer.alloc(44 + 16000 * 2);
wave.write('RIFF');
wave.writeUInt32LE(wave.length - 8, 4);
wave.write('WAVEfmt ', 8);
wave.writeUInt32LE(16, 16);
wave.writeUInt16LE(1, 20);
wave.writeUInt16LE(1, 22);
wave.writeUInt32LE(8000, 24);
wave.writeUInt32LE(16000, 28);
wave.writeUInt16LE(2, 32);
wave.writeUInt16LE(16, 34);
wave.write('data', 36);
wave.writeUInt32LE(wave.length - 44, 40);
for (let i = 0; i < 16000; i++)
  wave.writeInt16LE(Math.round(Math.sin((i * 2 * Math.PI * 440) / 8000) * 2000), 44 + i * 2);
const contents: Record<string, Buffer> = {
  text: Buffer.from('<script>window.previewExecuted = true</script>\nHello from harbor0! 🌍'),
  image: Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
    'base64',
  ),
  audio: wave,
  video: await readFile('tests/fixtures/preview.webm'),
  empty: Buffer.alloc(0),
  large: Buffer.from('A'.repeat(1_000_020)),
  error: Buffer.from('Recovered preview'),
  broken: Buffer.from('Not a video'),
  slow: Buffer.from('This response must not replace a newer preview'),
};
const names: Record<string, string> = {
  text: 'Notes.txt',
  image: 'Photo.png',
  video: 'Clip.webm',
  audio: 'Music.wav',
  empty: 'Empty.txt',
  large: 'Large.log',
  error: 'Retry.txt',
  broken: 'Broken.webm',
  slow: 'Slow.txt',
  unsupported: 'Archive.zip',
};
const items = Object.entries(names).map(([id, name]) => ({
  id,
  name,
  type: 'FILE',
  mimeType: 'application/octet-stream',
  sizeBytes: contents[id]?.length ?? 100,
  ownerUserId: 'demo',
  revision: 1,
  createdAt: '2026-09-25T00:00:00Z',
  updatedAt: '2026-09-25T00:00:00Z',
}));
let failDownloads = false;
const ranges: string[] = [];
const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') {
    res.end();
    return;
  }
  const pathname = new URL(req.url!, 'http://127.0.0.1:9100').pathname;
  if (pathname === '/v1/auth/refresh' || pathname === '/v1/auth/login') {
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        accessToken: 'preview-test-token',
        refreshToken: 'preview-test-refresh',
        expiresIn: 3600,
      }),
    );
    return;
  }
  if (pathname.startsWith('/v1/') && pathname !== '/v1/downloads') {
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify(
        pathname === '/v1/users/me'
          ? { user: { id: 'demo', displayName: 'Preview test' } }
          : pathname === '/v1/auth/session'
            ? { device: { id: 'preview-device', devicePublicId: 'preview-device' } }
            : { items: [], nextCursor: null },
      ),
    );
    return;
  }
  if (pathname === '/v1/downloads') {
    let body = '';
    for await (const chunk of req) body += chunk;
    const id = JSON.parse(body).driveItemId;
    res.setHeader('Content-Type', 'application/json');
    if (id === 'error' && failDownloads) {
      res.writeHead(503);
      res.end(JSON.stringify({ error: { code: 'UNAVAILABLE', message: 'Try again' } }));
      return;
    }
    res.end(
      JSON.stringify({
        downloadUrl: `http://127.0.0.1:9100/content/${id}`,
        sizeBytes: contents[id]?.length ?? 0,
      }),
    );
    return;
  }
  const id = pathname.split('/').at(-1)!;
  const bytes = contents[id];
  if (!bytes) {
    res.writeHead(404);
    res.end();
    return;
  }
  if (id === 'slow') await new Promise((resolve) => setTimeout(resolve, 1500));
  // Match uploaded storage objects: a generic MIME type and attachment disposition.
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${names[id]}"`);
  res.setHeader('Accept-Ranges', 'bytes');
  const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
  if (range) {
    ranges.push(id);
    const start = Number(range[1]);
    const end = Math.min(Number(range[2] || bytes.length - 1), bytes.length - 1);
    if (start >= bytes.length) {
      res.writeHead(416);
      res.end();
      return;
    }
    res.setHeader('Content-Range', `bytes ${start}-${end}/${bytes.length}`);
    res.writeHead(206, { 'Content-Length': end - start + 1 });
    res.end(bytes.subarray(start, end + 1));
  } else {
    res.writeHead(200, { 'Content-Length': bytes.length });
    res.end(bytes);
  }
});
await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});

const fixtureOrigin = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
async function checks(page: Page, platform: string) {
  await page.route('http://127.0.0.1:9100/content/**', async (route) => {
    const response = await fetch(
      route.request().url().replace('http://127.0.0.1:9100', fixtureOrigin),
      { headers: route.request().headers() },
    );
    await route.fulfill({
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: Buffer.from(await response.arrayBuffer()),
    });
  });
  const dialog = page.getByRole('dialog');
  const open = async (id: string) => {
    await page.getByRole('button', { name: names[id], exact: true }).click();
    await expect(dialog.getByRole('heading', { name: names[id], exact: true })).toBeVisible();
  };
  const close = async () => {
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  };
  await expect(page.getByRole('heading', { name: 'My Drive', exact: true })).toBeVisible();
  await open('text');
  await expect(dialog).not.toHaveAttribute('aria-modal', 'true');
  await expect(page.locator('.dialog-backdrop')).toHaveCount(0);
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  await expect
    .poll(async () => {
      const box = await dialog.boundingBox();
      return Math.round(box!.x + box!.width);
    })
    .toBe(viewport.width);
  const trayBox = await dialog.boundingBox();
  expect(trayBox!.x + trayBox!.width).toBeCloseTo(viewport.width, 0);
  expect(trayBox!.y).toBe(0);
  expect(trayBox!.height).toBe(viewport.height);
  expect(trayBox!.width).toBe(480);
  const information = dialog.getByRole('region', { name: 'File information' });
  await expect(information).toContainText('Text document');
  await expect(information).toContainText('Created');
  await expect(information).toContainText('Modified');
  await expect(page.getByLabel('Text preview')).toContainText(
    '<script>window.previewExecuted = true</script>',
  );
  expect(await page.evaluate(() => (window as any).previewExecuted)).toBeUndefined();
  await page.screenshot({ path: `${output}/${platform}-text.png` });
  // A second file can be opened directly while the non-modal tray remains open.
  await open('image');
  await expect(information).toContainText('PNG file');
  await open('text');
  await close();
  await expect(page.getByRole('button', { name: names.text, exact: true })).toBeFocused();
  await open('image');
  await expect
    .poll(() => dialog.locator('img').evaluate((el: HTMLImageElement) => el.naturalWidth))
    .toBe(1);
  await expect(dialog.getByText('Loading preview…')).toHaveCount(0);
  await close();
  for (const id of ['video', 'audio']) {
    await open(id);
    const media = dialog.locator(id);
    await expect
      .poll(() => media.evaluate((el: HTMLMediaElement) => el.readyState))
      .toBeGreaterThan(0);
    await media.evaluate((el: HTMLMediaElement) => el.play());
    await expect
      .poll(() => media.evaluate((el: HTMLMediaElement) => el.currentTime))
      .toBeGreaterThan(0);
    await media.evaluate((el: HTMLMediaElement) => {
      el.pause();
      el.currentTime = 1;
    });
    await expect
      .poll(() => media.evaluate((el: HTMLMediaElement) => el.currentTime))
      .toBeGreaterThanOrEqual(1);
    await page.screenshot({ path: `${output}/${platform}-${id}.png` });
    await close();
    await expect(page.locator('audio,video')).toHaveCount(0);
  }
  await open('empty');
  await expect(dialog.getByText('This text file is empty.')).toBeVisible();
  await close();
  await open('large');
  await expect(dialog.getByText('Showing the first 1 MB.', { exact: false })).toBeVisible();
  expect((await page.getByLabel('Text preview').textContent())?.length).toBe(1_000_000);
  await close();
  await open('unsupported');
  await expect(dialog.getByText('No preview available', { exact: false })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Download', exact: true })).toBeEnabled();
  await close();
  failDownloads = true;
  await open('error');
  await expect(dialog.getByRole('alert')).toBeVisible();
  failDownloads = false;
  await dialog.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByLabel('Text preview')).toHaveText('Recovered preview');
  await close();
  await open('broken');
  await expect(dialog.getByRole('alert')).toContainText('format may not be supported');
  await close();
  await open('slow');
  await close();
  await open('text');
  await expect(page.getByLabel('Text preview')).toContainText('Hello from harbor0');
  await page.waitForTimeout(1600);
  await expect(page.getByLabel('Text preview')).toContainText('Hello from harbor0');
  await close();
  await page.getByRole('button', { name: `Actions for ${names.text}`, exact: true }).click();
  await page.getByRole('menuitem', { name: 'Open', exact: true }).click();
  await expect(page.getByLabel('Text preview')).toContainText('Hello from harbor0');
  await close();
  if (platform === 'web') {
    await page.setViewportSize({ width: 390, height: 844 });
    await open('video');
    await expect
      .poll(() => dialog.locator('video').evaluate((el: HTMLVideoElement) => el.readyState))
      .toBeGreaterThan(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    const box = await dialog.boundingBox();
    expect(box!.width).toBe(390);
    expect(box!.x).toBe(0);
    await expect(dialog.getByRole('button', { name: 'Download', exact: true })).toBeInViewport();
    await page.screenshot({ path: `${output}/web-mobile.png` });
    await close();
  }
  console.log(
    `PASS: ${platform} text, image, audio/video playback and seek, empty/large files, literal HTML, unsupported/corrupt formats, retry, stale response cleanup, menu and keyboard focus`,
  );
}
const browser = await chromium.launch();
let desktop: Awaited<ReturnType<typeof electron.launch>> | undefined;
let profile: string | undefined;
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.route('**/api/**', async (route) => {
    const url = route.request().url();
    if (url.endsWith('/v1/downloads')) {
      const response = await fetch(fixtureOrigin + '/v1/downloads', {
        method: 'POST',
        body: route.request().postData(),
      });
      return route.fulfill({ status: response.status, json: await response.json() });
    }
    if (url.endsWith('/v1/users/me'))
      return route.fulfill({
        json: {
          user: {
            id: 'demo',
            displayName: 'Preview test',
            username: 'preview',
            email: 'preview@example.test',
          },
          storage: { usedBytes: 100, quotaBytes: 100000000000, reservedBytes: 0 },
        },
      });
    return route.fulfill({
      json: { items: url.includes('/children') ? items : [], nextCursor: null },
    });
  });
  await page.goto('http://127.0.0.1:3000');
  await checks(page, 'web');
  profile = await mkdtemp(path.join(os.tmpdir(), 'harbor-preview-'));
  desktop = await electron.launch({
    args: ['apps/desktop', `--user-data-dir=${profile}`],
    env: { ...process.env, HARBOR_DEV_AUTH: 'true', HARBOR_API_URL: fixtureOrigin },
  });
  const window = await desktop.firstWindow();
  await expect(window.getByRole('heading', { name: 'Sign in to harbor0' })).toBeVisible();
  await desktop.evaluate(
    ({ ipcMain }, { fixtures, fixtureOrigin }) => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (input, init) =>
        originalFetch(
          typeof input === 'string'
            ? input.replace('http://127.0.0.1:9100/content/', fixtureOrigin + '/content/')
            : input,
          init,
        );
      ipcMain.removeHandler('harbor:status');
      ipcMain.handle('harbor:status', () => ({
        ok: true,
        data: { signedIn: true, accountId: 'demo', roots: [], jobs: [], sync: {} },
      }));
      // Keep actual download authorization and previewText handlers, including isolated main-process fetching.
      ipcMain.removeHandler('harbor:request');
      ipcMain.handle('harbor:request', async (_event, input) => ({
        ok: true,
        data:
          input.path === '/v1/downloads'
            ? await (
                await fetch(fixtureOrigin + '/v1/downloads', {
                  method: 'POST',
                  body: JSON.stringify(input.body),
                })
              ).json()
            : {
                items: input.path.includes('/children') ? fixtures : [],
                nextCursor: null,
              },
      }));
    },
    { fixtures: items, fixtureOrigin },
  );
  await window.reload();
  await window.evaluate(() =>
    globalThis.window.harbor.login({ email: 'preview@example.test', password: 'preview-fixture' }),
  );
  await checks(window, 'desktop');
  expect(ranges).toContain('text');
  expect(ranges).toContain('video');
  expect(ranges).toContain('audio');
  console.log('PASS: storage range requests and real desktop text IPC');
} finally {
  await desktop?.close();
  await browser.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (profile) await rm(profile, { recursive: true, force: true });
}
