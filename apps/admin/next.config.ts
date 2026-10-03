import path from 'node:path';
import type { NextConfig } from 'next';

// The console is a static export served next to its own API (CloudFront sends /api/* to the
// console Lambda). In development, /api/* is forwarded to the local console API instead.
const development = process.env.NODE_ENV !== 'production';
const config: NextConfig = {
  ...(development
    ? {
        async rewrites() {
          return [
            {
              source: '/api/:path*',
              destination: `${process.env.ADMIN_API_URL ?? 'http://127.0.0.1:8789'}/api/:path*`,
            },
          ];
        },
      }
    : { output: 'export' }),
  // Styles and kit components come from the web app.
  turbopack: { root: path.join(import.meta.dirname, '../..') },
};
export default config;
