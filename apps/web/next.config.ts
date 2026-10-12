import type { NextConfig } from 'next';
const development = process.env.NODE_ENV === 'development';
// Local storage, plus another origin for a second dev server's storage (launch.json).
const storage = [
  'http://127.0.0.1:9100',
  ...(development && process.env.DEV_STORAGE_ORIGIN ? [process.env.DEV_STORAGE_ORIGIN] : []),
].join(' ');
const config: NextConfig = {
  transpilePackages: ['@harbor/contracts', '@harbor/api-client'],
  output: 'standalone',
  // A second dev server in this folder needs its own build folder: Next refuses two in one.
  ...(development && process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Frame-Options', value: 'DENY' },
          {
            key: 'Content-Security-Policy',
            value: `default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://*.r2.cloudflarestorage.com ${storage}; media-src 'self' blob: https://*.r2.cloudflarestorage.com ${storage}; connect-src 'self' https://*.r2.cloudflarestorage.com ${storage} ws://127.0.0.1:8788; worker-src 'self' blob:; frame-ancestors 'none'; object-src 'none'; base-uri 'self'`,
          },
        ],
      },
    ];
  },
};
export default config;
