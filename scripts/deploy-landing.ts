import { spawn } from 'node:child_process';
import { readFile, access } from 'node:fs/promises';
// "Sign up"/"Sign in" must point at the hosted web app, never the localhost
// value in apps/landing/.env.local (an already-set env var wins over .env files).
const webUrl = process.env.WEB_ORIGIN;
if (!webUrl?.startsWith('https://')) throw new Error('WEB_ORIGIN must be the hosted web app URL.');
async function run(command: string, args: string[], capture = false, env = process.env) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    });
    let output = '';
    child.stdout?.on('data', (data) => {
      output += String(data);
    });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve(output) : reject(new Error(`${command} exited ${code}`)),
    );
  });
}
await run('npm', ['run', 'build:landing'], false, { ...process.env, NEXT_PUBLIC_APP_URL: webUrl });
await access('apps/landing/out/index.html');
const html = await readFile('apps/landing/out/index.html', 'utf8');
if (html.includes('localhost')) throw new Error('Landing export still links to localhost.');
const assetsOnly = process.argv.includes('--assets-only');
if (!assetsOnly && process.env.LANDING_CERT_ARN) {
  const status = (
    await run(
      'aws',
      [
        'acm',
        'describe-certificate',
        '--region',
        'us-east-1',
        '--certificate-arn',
        process.env.LANDING_CERT_ARN,
        '--query',
        'Certificate.Status',
        '--output',
        'text',
      ],
      true,
    )
  ).trim();
  if (status !== 'ISSUED')
    throw new Error(`harbor0.com certificate is ${status}; add its DNS validation records first.`);
}
if (!assetsOnly) {
  await run('npx', [
    'cdk',
    'deploy',
    'HarborLanding',
    '--app',
    'npx tsx infra/landing.ts',
    '--require-approval',
    'never',
    '--outputs-file',
    '.cloud/landing-outputs.json',
  ]);
}
const site = JSON.parse(await readFile('.cloud/landing-outputs.json', 'utf8')).HarborLanding;
// Upload hashed assets before the HTML that references them.
await run('aws', [
  's3',
  'sync',
  'apps/landing/out/_next/static',
  `s3://${site.LandingBucketName}/_next/static`,
  '--cache-control',
  'public,max-age=31536000,immutable',
  '--only-show-errors',
]);
await run('aws', [
  's3',
  'sync',
  'apps/landing/out',
  `s3://${site.LandingBucketName}`,
  '--exclude',
  '_next/static/*',
  '--cache-control',
  'no-cache,max-age=0,must-revalidate',
  '--delete',
  '--only-show-errors',
]);
const invalidation = JSON.parse(
  await run(
    'aws',
    [
      'cloudfront',
      'create-invalidation',
      '--distribution-id',
      site.LandingDistributionId,
      '--paths',
      '/*',
      '--output',
      'json',
    ],
    true,
  ),
);
await run('aws', [
  'cloudfront',
  'wait',
  'invalidation-completed',
  '--distribution-id',
  site.LandingDistributionId,
  '--id',
  invalidation.Invalidation.Id,
]);
console.log(`Published harbor0 landing at ${site.LandingUrl}`);
