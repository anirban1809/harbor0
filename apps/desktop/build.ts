import { build, type BuildOptions } from 'esbuild';
import { mkdir, writeFile, copyFile, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const main: BuildOptions = {
  entryPoints: ['src/main.ts'],
  outfile: 'dist/main.cjs',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  external: ['electron', 'node:sqlite'],
  sourcemap: true,
};
const preload: BuildOptions = {
  entryPoints: ['src/preload.ts'],
  outfile: 'dist/preload.cjs',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  external: ['electron'],
};
const renderer: BuildOptions = {
  entryPoints: ['src/renderer.tsx'],
  loader: { '.woff2': 'file' },
  assetNames: 'fonts/[name]-[hash]',
  outdir: 'dist/renderer',
  entryNames: 'app',
  chunkNames: 'chunks/[name]-[hash]',
  splitting: true,
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'chrome132',
  jsx: 'automatic',
  define: {
    'process.env.NODE_ENV': '"production"',
    // Shared web code reads Next's inlined build ID; the desktop app updates itself instead.
    'process.env.NEXT_PUBLIC_BUILD_ID': 'undefined',
  },
};
/** The three bundles of the desktop app; `npm run dev` rebuilds them on change. */
export const bundles = { main, preload, renderer };

/** Empties the renderer output and writes the files esbuild does not produce. */
export async function prepare() {
  await rm('dist/renderer', { recursive: true, force: true });
  await mkdir('dist/renderer', { recursive: true });
  await writeFile(
    'dist/renderer/index.html',
    `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://*.r2.cloudflarestorage.com http://127.0.0.1:9100; media-src 'self' https://*.r2.cloudflarestorage.com http://127.0.0.1:9100; font-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'"><title>harbor0</title><link rel="stylesheet" href="app.css"></head><body><div id="root"></div><script type="module" src="app.js"></script></body></html>`,
  );
  // Shared harbor0 artwork is also used by the web favicon and app installers.
  await copyFile('assets/icon.png', 'dist/icon.png');
  await copyFile('assets/trayTemplate.png', 'dist/trayTemplate.png');
  await copyFile('assets/trayTemplate@2x.png', 'dist/trayTemplate@2x.png');
}

if (import.meta.url === pathToFileURL(process.argv[1]!).href) {
  await prepare();
  await Promise.all(Object.values(bundles).map((options) => build(options)));
}
