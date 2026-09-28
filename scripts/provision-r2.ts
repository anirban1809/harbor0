import { z } from 'zod';
const config = z
  .object({
    CLOUDFLARE_ACCOUNT_ID: z.string().regex(/^[a-f0-9]{32}$/),
    CLOUDFLARE_API_TOKEN: z.string().min(1),
    R2_BUCKET: z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/),
    WEB_ORIGIN: z.url(),
    R2_ENDPOINT: z.url().optional(),
  })
  .parse(process.env);
const origin = new URL(config.WEB_ORIGIN);
if (origin.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(origin.hostname))
  throw new Error('Use HTTPS, or a loopback origin for live development validation.');
const endpointHost = config.R2_ENDPOINT ? new URL(config.R2_ENDPOINT).hostname : '';
const jurisdiction = endpointHost.match(
  /^[a-f0-9]{32}\.([a-z]+)\.r2\.cloudflarestorage\.com$/,
)?.[1];
const base = `https://api.cloudflare.com/client/v4/accounts/${config.CLOUDFLARE_ACCOUNT_ID}/r2/buckets`;
async function call(route: string, method = 'GET', body?: unknown) {
  const response = await fetch(base + route, {
    method,
    headers: {
      Authorization: `Bearer ${config.CLOUDFLARE_API_TOKEN}`,
      'Content-Type': 'application/json',
      ...(jurisdiction ? { 'cf-r2-jurisdiction': jurisdiction } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await response.json()) as {
    success: boolean;
    result: any;
    errors?: { code: number; message: string }[];
  };
  if (!response.ok || !json.success)
    throw new Error(
      `Cloudflare R2 ${method} failed (${response.status}): ${json.errors?.map((e) => e.code).join(',') ?? 'unknown'}`,
    );
  return json.result;
}
// This command provisions a new, dedicated bucket. An existing bucket fails closed.
await call('', 'POST', { name: config.R2_BUCKET });
await call(`/${config.R2_BUCKET}/cors`, 'PUT', {
  rules: [
    {
      id: 'harbor-web',
      allowed: { origins: [config.WEB_ORIGIN], methods: ['GET', 'PUT', 'HEAD'], headers: ['*'] },
      exposeHeaders: ['ETag', 'Content-Length', 'Content-Range'],
      maxAgeSeconds: 3600,
    },
  ],
});
await call(`/${config.R2_BUCKET}/lifecycle`, 'PUT', {
  rules: [
    {
      id: 'harbor-incomplete-uploads',
      enabled: true,
      conditions: { prefix: 'objects/' },
      abortMultipartUploadsTransition: { condition: { type: 'Age', maxAge: 172800 } },
    },
  ],
});
console.log(
  'Created a private R2 bucket with browser CORS and incomplete-upload cleanup. Keep public access disabled and create bucket-scoped S3 credentials next.',
);
