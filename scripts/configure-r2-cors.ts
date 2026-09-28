export {};
const endpoint = new URL(process.env.R2_ENDPOINT!);
const account = endpoint.hostname.split('.')[0];
const jurisdiction = endpoint.hostname.match(/^[a-f0-9]{32}\.([a-z]+)\.r2\./)?.[1];
const origin = new URL(process.env.WEB_ORIGIN!).origin;
if (
  !origin.startsWith('https://') &&
  !['localhost', '127.0.0.1'].includes(new URL(origin).hostname)
)
  throw new Error('Only HTTPS or loopback origins are allowed.');
const url = `https://api.cloudflare.com/client/v4/accounts/${account}/r2/buckets/${process.env.R2_BUCKET}/cors`;
const headers = {
  Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
  'Content-Type': 'application/json',
  ...(jurisdiction ? { 'cf-r2-jurisdiction': jurisdiction } : {}),
};
const current = await fetch(url, { headers });
const result = (await current.json()) as {
  success: boolean;
  result: { rules: { id: string; allowed: { origins: string[] }; [key: string]: unknown }[] };
};
if (!current.ok || !result.success)
  throw new Error(`Reading bucket CORS failed: ${current.status}`);
const rules = result.result.rules;
const rule = rules.find((r) => r.id === 'harbor-web');
if (!rule)
  throw new Error('Expected the harbor0-managed CORS rule; refusing to modify an unrelated bucket.');
rule.allowed.origins = [...new Set([...rule.allowed.origins, origin])];
const response = await fetch(url, { method: 'PUT', headers, body: JSON.stringify({ rules }) });
const saved = (await response.json()) as { success: boolean };
if (!response.ok || !saved.success)
  throw new Error(`Saving bucket CORS failed: ${response.status}`);
console.log(`R2 now permits browser requests from ${origin}; existing origins preserved.`);
