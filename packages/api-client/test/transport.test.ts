import { afterEach, expect, it, vi } from 'vitest';
import { ApiError, createTransport } from '../src';

afterEach(() => vi.unstubAllGlobals());
function answer(body: string, status: number, contentType = 'application/json') {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(body, { status, headers: { 'Content-Type': contentType } })),
  );
}
const request = () => createTransport('https://api.test')('/v1/users/me');

it('reports a gateway HTML error page as the server being unavailable, not a JSON error', async () => {
  answer('<html><body>502 Bad Gateway</body></html>', 502, 'text/html');
  const error = await request().catch((e) => e);
  expect(error).toBeInstanceOf(ApiError);
  expect(error).toMatchObject({ code: 'BACKEND_UNAVAILABLE', status: 502 });
  expect(error.message).not.toMatch(/Unexpected token|JSON/);
});

it('keeps the API error from a JSON error response', async () => {
  answer(
    JSON.stringify({
      error: {
        code: 'STORAGE_QUOTA_EXCEEDED',
        message: 'Full.',
        requestId: 'r1',
        details: { a: 1 },
      },
    }),
    409,
  );
  await expect(request()).rejects.toMatchObject({
    code: 'STORAGE_QUOTA_EXCEEDED',
    message: 'Full.',
    status: 409,
    requestId: 'r1',
    details: { a: 1 },
  });
});

it('treats a server error without an API error body as unavailable and a client one as failed', async () => {
  answer(JSON.stringify({ message: 'Internal Server Error' }), 500);
  await expect(request()).rejects.toMatchObject({ code: 'BACKEND_UNAVAILABLE', status: 500 });
  answer('Not here', 404, 'text/plain');
  await expect(request()).rejects.toMatchObject({ code: 'REQUEST_FAILED', status: 404 });
});

it('rejects a successful answer that is not JSON (a captive portal) as unavailable', async () => {
  answer('<html>Sign in to Wi-Fi</html>', 200, 'text/html');
  await expect(request()).rejects.toMatchObject({ code: 'BACKEND_UNAVAILABLE', status: 502 });
  answer(JSON.stringify({ ok: true }), 200);
  await expect(request()).resolves.toEqual({ ok: true });
});
