import { execFileSync } from 'node:child_process';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
const web = JSON.parse(await readFile('.cloud/web-outputs.json', 'utf8')).HarborWeb;
const aws = (...args: string[]) =>
  JSON.parse(execFileSync('aws', [...args, '--output', 'json'], { encoding: 'utf8' }));
const checks: string[] = [];
function pass(message: string) {
  checks.push(message);
  console.log('PASS:', message);
}
const distribution = aws('cloudfront', 'get-distribution', '--id', web.DistributionId).Distribution;
assert.equal(distribution.Status, 'Deployed');
assert.equal(distribution.DistributionConfig.Enabled, true);
pass('CloudFront distribution is deployed and enabled');
const api = distribution.DistributionConfig.CacheBehaviors.Items.find(
  (b: { PathPattern: string }) => b.PathPattern === '/api/*',
);
assert.ok(api);
const cache = aws('cloudfront', 'get-cache-policy', '--id', api.CachePolicyId).CachePolicy
  .CachePolicyConfig;
assert.equal(cache.MinTTL, 0);
assert.equal(cache.DefaultTTL, 0);
assert.equal(cache.MaxTTL, 0);
pass('API caching is disabled at every CloudFront TTL');
const forwarding = aws('cloudfront', 'get-origin-request-policy', '--id', api.OriginRequestPolicyId)
  .OriginRequestPolicy.OriginRequestPolicyConfig;
assert.equal(forwarding.CookiesConfig.CookieBehavior, 'all');
assert.equal(forwarding.HeadersConfig.HeaderBehavior, 'allExcept');
assert.ok(forwarding.HeadersConfig.Headers.Items.includes('host'));
pass('CloudFront forwards session cookies and Origin without replacing the API hostname');
const block = aws(
  's3api',
  'get-public-access-block',
  '--bucket',
  web.WebBucketName,
).PublicAccessBlockConfiguration;
assert.ok(Object.values(block).every((value) => value === true));
assert.equal(
  aws('s3api', 'get-bucket-policy-status', '--bucket', web.WebBucketName).PolicyStatus.IsPublic,
  false,
);
const s3Origin = distribution.DistributionConfig.Origins.Items.find(
  (o: { S3OriginConfig?: unknown }) => o.S3OriginConfig,
);
assert.ok(s3Origin.OriginAccessControlId);
pass('S3 is private and CloudFront uses origin access control');
const direct = await fetch(`https://${web.WebBucketName}.s3.us-east-1.amazonaws.com/index.html`);
assert.equal(direct.status, 403);
pass('Direct anonymous S3 access is denied');
const redirect = await fetch(web.WebUrl.replace('https:', 'http:'), { redirect: 'manual' });
assert.ok([301, 302, 307, 308].includes(redirect.status));
assert.ok(redirect.headers.get('location')?.startsWith(web.WebUrl));
pass('HTTP redirects to HTTPS');
const home = await fetch(web.WebUrl);
assert.equal(home.status, 200);
assert.ok((await home.text()).includes('harbor0'));
assert.ok(home.headers.get('strict-transport-security')?.includes('max-age='));
assert.ok(home.headers.get('content-security-policy')?.includes("frame-ancestors 'none'"));
assert.equal(home.headers.get('x-content-type-options'), 'nosniff');
pass('Public HTML loads with HTTPS security headers');
const assets = await readdir('.cloud/web-export/out/_next/static/chunks');
const asset = assets.find((name) => name.endsWith('.js'))!;
const staticResponse = await fetch(`${web.WebUrl}/_next/static/chunks/${asset}`);
assert.equal(staticResponse.status, 200);
assert.ok(staticResponse.headers.get('cache-control')?.includes('immutable'));
pass('Versioned JavaScript assets are served with immutable caching');
const unauthorized = await fetch(web.WebUrl + '/api/v1/users/me');
assert.equal(unauthorized.status, 401);
assert.equal((await unauthorized.json()).error.code, 'AUTH_REQUIRED');
assert.ok(unauthorized.headers.get('cache-control')?.includes('no-store'));
pass('Unauthenticated API requests retain their JSON status and are not cached');
await writeFile(
  '.cloud/web-hosting-validation.json',
  JSON.stringify(
    { completedAt: new Date().toISOString(), webUrl: web.WebUrl, passed: true, checks },
    null,
    2,
  ),
);
