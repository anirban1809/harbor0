import { describe, expect, it, vi } from 'vitest';
import { proxyBrowserRequest } from '../src/session-proxy';
const origin = 'https://files.example.test';
const opts = { apiUrl: 'https://backend.example.test', allowedOrigin: origin, secureCookies: true };
const request = (path: string, body?: unknown, cookie?: string, requestOrigin = origin) =>
  new Request(origin + '/api/v1/' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Origin: requestOrigin, ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
describe('same-origin browser session gateway', () => {
  it('rejects cross-origin writes before contacting the authenticated API', async () => {
    const upstream = vi.fn();
    const r = await proxyBrowserRequest(
      request('drive/folders', {}, 'harbor_access=secret', 'https://attacker.test'),
      { ...opts, upstream },
    );
    expect(r.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });
  it('keeps login tokens out of JSON and stores them in non-cacheable protected cookies', async () => {
    const upstream = vi.fn(async () =>
      Response.json({
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: 'id',
        expiresIn: 900,
        device: { id: 'device' },
      }),
    );
    const r = await proxyBrowserRequest(request('auth/login', { email: 'user@example.test' }), {
      ...opts,
      upstream,
    });
    expect(await r.json()).toEqual({ expiresIn: 900, device: { id: 'device' } });
    const cookies = r.headers.getSetCookie();
    expect(cookies).toHaveLength(2);
    expect(cookies.find((cookie) => cookie.startsWith('harbor_refresh='))).toContain(
      'Max-Age=2592000',
    );
    for (const c of cookies) expect(c).toMatch(/HttpOnly; SameSite=Strict; Max-Age=\d+; Secure/);
    expect(r.headers.get('cache-control')).toContain('no-store');
  });
  it('rotates a cookie session, retries with its new access token, and hides raw refresh endpoints', async () => {
    const calls: Request[] = [];
    const upstream = async (r: Request) => {
      calls.push(r);
      if (r.url.endsWith('/auth/refresh')) {
        expect(await r.json()).toEqual({ refreshToken: 'refresh-old' });
        return Response.json({
          accessToken: 'access-new',
          refreshToken: 'refresh-new',
          expiresIn: 900,
        });
      }
      return r.headers.get('authorization') === 'Bearer access-new'
        ? Response.json({ user: { id: 'u' } })
        : Response.json({ error: { code: 'AUTH_INVALID' } }, { status: 401 });
    };
    const r = await proxyBrowserRequest(
      request('users/me', undefined, 'harbor_access=expired; harbor_refresh=refresh-old'),
      { ...opts, upstream },
    );
    expect(r.status).toBe(200);
    expect(calls).toHaveLength(3);
    expect(r.headers.getSetCookie().join(';')).toContain('harbor_refresh=refresh-new');
    expect(
      (
        await proxyBrowserRequest(request('auth/refresh', { refreshToken: 'injected' }), {
          ...opts,
          upstream,
        })
      ).status,
    ).toBe(404);
    expect(calls).toHaveLength(3);
  });
  it('uses the cookie for logout and clears both credentials', async () => {
    const upstream = async (r: Request) => {
      expect(await r.json()).toEqual({ refreshToken: 'cookie-refresh' });
      return Response.json({ loggedOut: true });
    };
    const r = await proxyBrowserRequest(
      request(
        'auth/logout',
        { refreshToken: 'injected' },
        'harbor_access=access; harbor_refresh=cookie-refresh',
      ),
      { ...opts, upstream },
    );
    expect(r.status).toBe(200);
    expect(r.headers.getSetCookie().every((c) => c.includes('Max-Age=0'))).toBe(true);
  });
  it('restores a browser session using only the persistent refresh cookie', async () => {
    const upstream = vi.fn(async (r: Request) => {
      if (r.url.endsWith('/auth/refresh'))
        return Response.json({ accessToken: 'renewed', refreshToken: 'rotated', expiresIn: 900 });
      expect(r.headers.get('authorization')).toBe('Bearer renewed');
      return Response.json({ user: { id: 'u' } });
    });
    const r = await proxyBrowserRequest(request('users/me', undefined, 'harbor_refresh=saved'), {
      ...opts,
      upstream,
    });
    expect(r.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(2);
    expect(r.headers.getSetCookie().find((c) => c.startsWith('harbor_refresh='))).toContain(
      'Max-Age=2592000',
    );
  });
  it('clears browser credentials when the refresh session has expired', async () => {
    const upstream = vi.fn(async () =>
      Response.json({ error: { code: 'AUTH_INVALID' } }, { status: 401 }),
    );
    const r = await proxyBrowserRequest(request('users/me', undefined, 'harbor_refresh=expired'), {
      ...opts,
      upstream,
    });
    expect(r.status).toBe(401);
    expect(r.headers.getSetCookie()).toHaveLength(2);
    expect(r.headers.getSetCookie().every((c) => c.includes('Max-Age=0'))).toBe(true);
  });
  it('clears revoked device cookies without exposing or renewing credentials', async () => {
    const upstream = vi.fn(async () =>
      Response.json({ error: { code: 'DEVICE_REVOKED' } }, { status: 403 }),
    );
    const r = await proxyBrowserRequest(
      request('users/me', undefined, 'harbor_access=access; harbor_refresh=refresh'),
      { ...opts, upstream },
    );
    expect(r.status).toBe(403);
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(r.headers.getSetCookie().every((c) => c.includes('Max-Age=0'))).toBe(true);
  });
});
