import path from 'node:path';
import type { NextConfig } from 'next';

// A static site: `next build` writes plain files to `out/`.
const config: NextConfig = {
  output: 'export',
  // The page reuses the web app's tokens, button styles and logo.
  turbopack: { root: path.join(import.meta.dirname, '../..') },
};
export default config;
