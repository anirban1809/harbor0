import { afterEach, expect, it, vi } from 'vitest';
import { GET, POST } from '../app/api/[...path]/route';

afterEach(() => vi.unstubAllGlobals());

it('sends upstream bodies as strings so a 401 answer stays a 401', async () => {
  const calls: [string, RequestInit][] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      return Response.json({ error: { code: 'AUTH_REQUIRED' } }, { status: 401 });
    }),
  );
  const origin = 'http://localhost:3000';
  const response = await POST(
    new Request(origin + '/api/v1/realtime/tickets', {
      method: 'POST',
      headers: { Origin: origin, Cookie: 'harbor_refresh=ended' },
      body: '{}',
    }),
  );
  expect(response.status).toBe(401);
  expect(response.headers.getSetCookie()).toEqual([
    expect.stringMatching(/^harbor_access=; .*Max-Age=0/),
    expect.stringMatching(/^harbor_refresh=; .*Max-Age=0/),
  ]);
  // Refresh attempt, the request itself, and the retry's refresh attempt.
  expect(calls.map(([url, init]) => [new URL(url).pathname, typeof init.body])).toEqual([
    ['/v1/auth/refresh', 'string'],
    ['/v1/realtime/tickets', 'string'],
    ['/v1/auth/refresh', 'string'],
  ]);
  expect((await GET(new Request(origin + '/api/v1/users/me'))).status).toBe(401);
});
