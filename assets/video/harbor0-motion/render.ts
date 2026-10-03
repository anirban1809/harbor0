// Renders index.html frame by frame and encodes it with ffmpeg.
// Usage: npx tsx assets/video/harbor0-motion/render.ts [--fps 30] [--out harbor0-motion.mp4] [--stills 2,6,10]
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const fps = Number(arg('fps', '30'));
const out = resolve(here, arg('out', 'harbor0-motion.mp4'));
const stills = arg('stills', '');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
await page.goto(pathToFileURL(resolve(here, 'index.html')).href);
await page.waitForFunction(() => (window as any).__ready === true);
const duration: number = await page.evaluate(() => (window as any).DURATION);

if (stills) {
  for (const t of stills.split(',').map(Number)) {
    await page.evaluate((time) => (window as any).render(time), t);
    await page.screenshot({ path: resolve(here, `still-${t}.png`) });
  }
  await browser.close();
  process.exit(0);
}

const ffmpeg = spawn('ffmpeg', ['-y', '-f', 'image2pipe', '-framerate', String(fps), '-i', '-',
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out], { stdio: ['pipe', 'ignore', 'inherit'] });
const done = new Promise((r) => ffmpeg.on('close', r));

const frames = Math.round(duration * fps);
for (let f = 0; f < frames; f++) {
  await page.evaluate((time) => (window as any).render(time), f / fps);
  const png = await page.screenshot({ type: 'png' });
  if (!ffmpeg.stdin.write(png)) await new Promise((r) => ffmpeg.stdin.once('drain', r));
  if (f % fps === 0) process.stdout.write(`\r${f}/${frames}`);
}
ffmpeg.stdin.end();
await done;
await browser.close();
console.log(`\nwrote ${out}`);
