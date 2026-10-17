import path from 'node:path';
import type { NextConfig } from 'next';

// A static site: `next build` writes plain files to `out/`.
const config: NextConfig = {
  output: 'export',
  // The page reuses the web app's tokens, button styles and logo.
  turbopack: { root: path.join(import.meta.dirname, '../..') },
  // A second dev server in this folder needs its own build folder: Next refuses two in one.
  ...(process.env.NODE_ENV === 'development' && process.env.NEXT_DIST_DIR
    ? { distDir: process.env.NEXT_DIST_DIR }
    : {}),
};
export default config;
