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
  it('sets no cookies until a two-step sign-in finishes', async () => {
    const challenge = { twoFactor: { session: 'TOTP:abc', methods: ['TOTP'], method: 'TOTP' } };
    const first = await proxyBrowserRequest(request('auth/login', { email: 'user@example.test' }), {
      ...opts,
      upstream: async () => Response.json(challenge),
    });
    expect(await first.json()).toEqual(challenge);
    expect(first.headers.getSetCookie()).toHaveLength(0);
    const second = await proxyBrowserRequest(
      request('auth/login/verify', { email: 'user@example.test', code: '123456' }),
      {
        ...opts,
        upstream: async () =>
          Response.json({ accessToken: 'a', refreshToken: 'r', expiresIn: 900, device: {} }),
      },
    );
    expect(await second.json()).toEqual({ expiresIn: 900, device: {} });
    expect(second.headers.getSetCookie()).toHaveLength(2);
  });
  it('hides raw refresh endpoints and only renews through the cookie', async () => {
    const upstream = vi.fn();
    for (const path of ['auth/refresh', 'auth/session'])
      expect(
        (
          await proxyBrowserRequest(request(path, { refreshToken: 'injected' }), {
            ...opts,
            upstream,
          })
        ).status,
      ).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });
  it('answers 401 without renewing inline, keeping the refresh cookie for the client to renew', async () => {
    const upstream = vi.fn(async (r: Request) => {
      expect(r.url).toBe('https://backend.example.test/v1/users/me');
      return Response.json({ error: { code: 'AUTH_INVALID' } }, { status: 401 });
    });
    const r = await proxyBrowserRequest(
      request('users/me', undefined, 'harbor_access=rejected; harbor_refresh=refresh'),
      { ...opts, upstream },
    );
    expect(r.status).toBe(401);
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(r.headers.getSetCookie()).toEqual([
      'harbor_access=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Secure',
    ]);
  });
  it('forwards cookieless requests so public routes keep working', async () => {
    const upstream = vi.fn(async (r: Request) => {
      expect(r.headers.get('authorization')).toBeNull();
      return Response.json({ open: true });
    });
    const r = await proxyBrowserRequest(request('beta'), { ...opts, upstream });
    expect(r.status).toBe(200);
    expect(r.headers.getSetCookie()).toEqual([]);
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
  const renew = (cookie: string, upstream: (r: Request) => Promise<Response>) =>
    proxyBrowserRequest(request('auth/renew', {}, cookie), { ...opts, upstream });
  it('renews a session from the refresh cookie alone', async () => {
    const upstream = vi.fn(async (r: Request) => {
      expect(r.url).toBe('https://backend.example.test/v1/auth/refresh');
      expect(await r.json()).toEqual({ refreshToken: 'saved' });
      return Response.json({ accessToken: 'renewed', refreshToken: 'rotated', expiresIn: 900 });
    });
    const r = await renew('harbor_refresh=saved', upstream);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ renewed: true });
    const cookies = r.headers.getSetCookie();
    expect(cookies.find((c) => c.startsWith('harbor_access='))).toContain('renewed; Path=/');
    expect(cookies.find((c) => c.startsWith('harbor_refresh='))).toContain(
      'rotated; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000',
    );
  });
  it('skips renewal when another tab already renewed', async () => {
    const upstream = vi.fn();
    const r = await renew('harbor_access=fresh; harbor_refresh=rotated', upstream);
    expect(await r.json()).toEqual({ renewed: false });
    expect(upstream).not.toHaveBeenCalled();
    expect(r.headers.getSetCookie()).toEqual([]);
  });
  it('clears browser credentials when the refresh session has ended', async () => {
    const upstream = vi.fn(async () =>
      Response.json({ error: { code: 'AUTH_INVALID' } }, { status: 401 }),
    );
    const r = await renew('harbor_refresh=expired', upstream);
    expect(r.status).toBe(401);
    expect(r.headers.getSetCookie()).toHaveLength(2);
    expect(r.headers.getSetCookie().every((c) => c.includes('Max-Age=0'))).toBe(true);
  });
  it('keeps the refresh cookie when renewal is throttled or the backend fails', async () => {
    for (const status of [429, 500]) {
      const r = await renew('harbor_refresh=saved', async () =>
        Response.json({ error: { code: 'RATE_LIMITED' } }, { status }),
      );
      expect(r.status).toBe(503);
      expect(r.headers.getSetCookie()).toEqual([]);
    }
  });
  it('refuses cross-origin renewal', async () => {
    const upstream = vi.fn();
    const r = await proxyBrowserRequest(
      request('auth/renew', {}, 'harbor_refresh=saved', 'https://attacker.test'),
      { ...opts, upstream },
    );
    expect(r.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
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
