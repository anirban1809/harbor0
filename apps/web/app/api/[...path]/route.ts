import { proxyBrowserRequest } from '@harbor/api-client';
function proxy(request: Request) {
  return proxyBrowserRequest(request, {
    apiUrl: process.env.API_URL ?? 'http://127.0.0.1:8787',
    allowedOrigin: process.env.APP_ORIGIN ?? 'http://localhost:3000',
    secureCookies: process.env.NODE_ENV === 'production',
  });
}
export { proxy as GET, proxy as POST, proxy as PATCH, proxy as PUT, proxy as DELETE };
