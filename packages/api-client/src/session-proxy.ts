import { SESSION_DURATION_SECONDS } from './session';
type Tokens = { accessToken: string; refreshToken: string; expiresIn: number };
type ProxyOptions = {
  apiUrl: string;
  allowedOrigin: string;
  secureCookies: boolean;
  upstream?: (request: Request) => Promise<Response> | Response;
};
const json = (data: unknown, status: number) =>
  Response.json(data, {
    status,
    headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' },
  });
const error = (code: string, message: string, status: number) =>
  json({ error: { code, message } }, status);

/** Same-origin browser gateway. Tokens never appear in its JSON responses. */
export async function proxyBrowserRequest(req: Request, options: ProxyOptions): Promise<Response> {
  const url = new URL(req.url);
  const endpoint = url.pathname.slice('/api'.length);
  if (!url.pathname.startsWith('/api/v1/') || /%(?:2f|5c|2e)|\\|\/\.\.?\//i.test(endpoint))
    return error('NOT_FOUND', 'Unknown endpoint.', 404);
  if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method))
    return error('METHOD_NOT_ALLOWED', 'Method not allowed.', 405);
  if (!['GET', 'HEAD'].includes(req.method) && req.headers.get('origin') !== options.allowedOrigin)
    return error('FORBIDDEN', 'Request origin is not allowed.', 403);
  // Refresh credentials only enter through HTTP-only cookies. Native clients
  // use the bearer-token API directly rather than this browser gateway.
  if (['/v1/auth/refresh', '/v1/auth/session'].includes(endpoint))
    return error('NOT_FOUND', 'Unknown browser endpoint.', 404);
  const cookies = new Map(
    (req.headers.get('cookie') ?? '').split(';').map((part) => {
      const offset = part.indexOf('=');
      let value = part.slice(offset + 1).trim();
      try {
        value = decodeURIComponent(value);
      } catch {
        value = '';
      }
      return [part.slice(0, offset).trim(), value];
    }),
  );
  const access = cookies.get('harbor_access');
  const refresh = cookies.get('harbor_refresh');
  let rotated: Tokens | undefined;
  const upstream = options.upstream ?? fetch;
  const call = (path: string, method: string, body?: string, token?: string) =>
    upstream(
      new Request(options.apiUrl + path, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body,
      }),
    );
  const cookie = (name: string, value: string, age: number) =>
    `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${options.secureCookies ? '; Secure' : ''}`;
  const withCookies = (result: Response, clear: string[]) => {
    for (const name of clear) result.headers.append('Set-Cookie', cookie(name, '', 0));
    if (rotated) {
      result.headers.append(
        'Set-Cookie',
        cookie('harbor_access', rotated.accessToken, Math.max(1, rotated.expiresIn - 30)),
      );
      result.headers.append(
        'Set-Cookie',
        cookie('harbor_refresh', rotated.refreshToken, SESSION_DURATION_SECONDS),
      );
    }
    return result;
  };
  const expired = () => error('AUTH_INVALID', 'Your session expired. Sign in again.', 401);
  try {
    // Cognito rotates the refresh token on every use, so renewing inside ordinary requests
    // raced: parallel requests each spent the same cookie, and whichever response landed last
    // won. The browser renews through this one endpoint instead, one renewal at a time.
    if (endpoint === '/v1/auth/renew') {
      if (req.method !== 'POST') return error('METHOD_NOT_ALLOWED', 'Method not allowed.', 405);
      // Another tab renewed first: its cookies came with this request.
      if (access) return json({ renewed: false }, 200);
      if (!refresh) return withCookies(expired(), ['harbor_refresh']);
      const response = await call(
        '/v1/auth/refresh',
        'POST',
        JSON.stringify({ refreshToken: refresh }),
      );
      // Throttling or an outage says nothing about the session: keep the cookie to retry with.
      if (response.status !== 401 && !response.ok)
        return error(
          'BACKEND_UNAVAILABLE',
          'harbor0 is temporarily unavailable. Your local files are safe.',
          503,
        );
      if (!response.ok) return withCookies(expired(), ['harbor_access', 'harbor_refresh']);
      rotated = (await response.json()) as Tokens;
      return withCookies(json({ renewed: true }, 200), []);
    }
    if (Number(req.headers.get('content-length') ?? 0) > 1024 * 1024)
      return error('VALIDATION_ERROR', 'Request is too large.', 413);
    const text = ['GET', 'HEAD'].includes(req.method) ? undefined : await req.text();
    if (text && new TextEncoder().encode(text).length > 1024 * 1024)
      return error('VALIDATION_ERROR', 'Request is too large.', 413);
    // Without an access cookie, signed-in routes answer 401 and the client renews and retries.
    const response = await call(
      endpoint + url.search,
      req.method,
      endpoint === '/v1/auth/logout' ? JSON.stringify({ refreshToken: refresh ?? '' }) : text,
      access,
    );
    const data = await response.json();
    // A sign-in that still needs its second step returns no tokens yet.
    if (
      ['/v1/auth/login', '/v1/auth/login/verify'].includes(endpoint) &&
      response.ok &&
      data.accessToken
    )
      rotated = data;
    const { accessToken: _access, refreshToken: _refresh, idToken: _id, ...safe } = data;
    const result = json(safe, response.status);
    result.headers.set('X-Request-ID', response.headers.get('X-Request-ID') ?? '');
    if (endpoint === '/v1/auth/logout' || safe.error?.code === 'DEVICE_REVOKED')
      return withCookies(result, ['harbor_access', 'harbor_refresh']);
    // A rejected access token is spent, but the refresh cookie may still renew the session.
    if (response.status === 401 && access) return withCookies(result, ['harbor_access']);
    return withCookies(result, []);
  } catch {
    return error(
      'BACKEND_UNAVAILABLE',
      'harbor0 is temporarily unavailable. Your local files are safe.',
      503,
    );
  }
}
