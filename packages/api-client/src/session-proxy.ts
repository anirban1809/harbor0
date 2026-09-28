import { SESSION_DURATION_SECONDS } from './session';
type Tokens = { accessToken: string; refreshToken: string; expiresIn: number };
type ProxyOptions = {
  apiUrl: string;
  allowedOrigin: string;
  secureCookies: boolean;
  upstream?: (request: Request) => Promise<Response> | Response;
};
const publicActions = new Set(['signup', 'confirm', 'resend', 'login', 'forgot', 'reset']);
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
  let access = cookies.get('harbor_access');
  let refresh = cookies.get('harbor_refresh');
  let rotated: Tokens | undefined;
  const isPublic =
    endpoint.startsWith('/v1/auth/') && publicActions.has(endpoint.slice('/v1/auth/'.length));
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
  const renew = async () => {
    if (!refresh) return false;
    const response = await call(
      '/v1/auth/refresh',
      'POST',
      JSON.stringify({ refreshToken: refresh }),
    );
    if (!response.ok) return false;
    rotated = (await response.json()) as Tokens;
    access = rotated.accessToken;
    refresh = rotated.refreshToken;
    return true;
  };
  const cookie = (name: string, value: string, age: number) =>
    `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${options.secureCookies ? '; Secure' : ''}`;
  try {
    if (Number(req.headers.get('content-length') ?? 0) > 1024 * 1024)
      return error('VALIDATION_ERROR', 'Request is too large.', 413);
    const text = ['GET', 'HEAD'].includes(req.method) ? undefined : await req.text();
    if (text && new TextEncoder().encode(text).length > 1024 * 1024)
      return error('VALIDATION_ERROR', 'Request is too large.', 413);
    if (!access && !isPublic) await renew();
    const send = () =>
      call(
        endpoint + url.search,
        req.method,
        endpoint === '/v1/auth/logout' ? JSON.stringify({ refreshToken: refresh ?? '' }) : text,
        access,
      );
    let response = await send();
    if (response.status === 401 && !isPublic && (await renew())) response = await send();
    const data = await response.json();
    if (endpoint === '/v1/auth/login' && response.ok) rotated = data;
    const { accessToken: _access, refreshToken: _refresh, idToken: _id, ...safe } = data;
    const result = json(safe, response.status);
    result.headers.set('X-Request-ID', response.headers.get('X-Request-ID') ?? '');
    const clear =
      endpoint === '/v1/auth/logout' ||
      response.status === 401 ||
      safe.error?.code === 'DEVICE_REVOKED';
    if (clear) {
      result.headers.append('Set-Cookie', cookie('harbor_access', '', 0));
      result.headers.append('Set-Cookie', cookie('harbor_refresh', '', 0));
    } else if (rotated) {
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
  } catch {
    return error(
      'BACKEND_UNAVAILABLE',
      'harbor0 is temporarily unavailable. Your local files are safe.',
      503,
    );
  }
}
