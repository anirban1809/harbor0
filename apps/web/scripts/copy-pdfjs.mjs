// Copies the fonts, CMaps and image decoders pdf.js fetches at runtime into public/pdfjs.
import { cp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const source = path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
const target = path.join(path.dirname(fileURLToPath(import.meta.url)), '../public/pdfjs');
await rm(target, { recursive: true, force: true });
for (const dir of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
  await cp(path.join(source, dir), path.join(target, dir), {
    recursive: true,
    // The scripting sandbox is never enabled, so its interpreter is not needed.
    filter: (file) => !path.basename(file).startsWith('quickjs'),
  });
}
