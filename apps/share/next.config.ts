import path from 'node:path';
import type { NextConfig } from 'next';

// Public link pages, served on their own domain (harbor0content.online). In the cloud this is a
// static export, and CloudFront sends /api/v1/public/* to the API; locally Next does that.
const development = process.env.NODE_ENV === 'development';
const api = process.env.API_URL ?? 'http://127.0.0.1:8787';
const config: NextConfig = {
  ...(development
    ? {
        async rewrites() {
          return [{ source: '/api/v1/public/:path*', destination: `${api}/v1/public/:path*` }];
        },
      }
    : { output: 'export' }),
  transpilePackages: ['@harbor/contracts'],
  // The pages reuse the web app's tokens and component styles.
  turbopack: { root: path.join(import.meta.dirname, '../..') },
};
export default config;
