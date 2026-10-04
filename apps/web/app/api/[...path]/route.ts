import { proxyBrowserRequest } from '@harbor/api-client';
function proxy(request: Request) {
  return proxyBrowserRequest(request, {
    apiUrl: process.env.API_URL ?? 'http://127.0.0.1:8787',
    allowedOrigin: process.env.APP_ORIGIN ?? 'http://localhost:3000',
    secureCookies: process.env.NODE_ENV === 'production',
    // Next's fetch re-wraps a Request body as a stream; undici then rejects any 401 answer to
    // it ("expected non-null body source"), which turned an ended session into a 503.
    upstream: async (upstream) =>
      fetch(upstream.url, {
        method: upstream.method,
        headers: upstream.headers,
        body: ['GET', 'HEAD'].includes(upstream.method) ? undefined : await upstream.text(),
        cache: 'no-store',
      }),
  });
}
export { proxy as GET, proxy as POST, proxy as PATCH, proxy as PUT, proxy as DELETE };
