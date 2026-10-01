import type { NextConfig } from 'next';
const config: NextConfig = {
  transpilePackages: ['@harbor/contracts', '@harbor/api-client'],
  output: 'standalone',
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
            value:
              "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://*.r2.cloudflarestorage.com http://127.0.0.1:9100; media-src 'self' https://*.r2.cloudflarestorage.com http://127.0.0.1:9100; connect-src 'self' https://*.r2.cloudflarestorage.com http://127.0.0.1:9100 ws://127.0.0.1:8788; worker-src 'self' blob:; frame-ancestors 'none'; object-src 'none'; base-uri 'self'",
          },
        ],
      },
    ];
  },
};
export default config;
