import { spawn } from 'node:child_process';
import { readFile, writeFile, access } from 'node:fs/promises';
// Publishes the management console: HarborAdmin (static site + /api/* → console API), then
// records its origin in .env.cloud and redeploys HarborStorage so the console API accepts it.
const outputs = JSON.parse(await readFile('.cloud/outputs.json', 'utf8')).HarborStorage;
if (!outputs.AdminApiUrl) throw new Error('Run npm run cloud:deploy first: no AdminApiUrl output.');
const apiHost = new URL(outputs.AdminApiUrl).hostname;
if (!/^[a-z0-9]+\.execute-api\.[a-z0-9-]+\.amazonaws\.com$/.test(apiHost))
  throw new Error('Expected the deployed console API Gateway endpoint.');
async function run(command: string, args: string[], capture = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: process.env,
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
await run('npm', ['run', 'build:admin']);
await access('apps/admin/out/index.html');
const assetsOnly = process.argv.includes('--assets-only');
if (!assetsOnly && process.env.ADMIN_CERT_ARN) {
  const status = (
    await run(
      'aws',
      [
        'acm',
        'describe-certificate',
        '--region',
        'us-east-1',
        '--certificate-arn',
        process.env.ADMIN_CERT_ARN,
        '--query',
        'Certificate.Status',
        '--output',
        'text',
      ],
      true,
    )
  ).trim();
  if (status !== 'ISSUED')
    throw new Error(
      `${process.env.ADMIN_DOMAIN} certificate is ${status}; add its DNS validation record first.`,
    );
}
if (!assetsOnly) {
  await run('npx', [
    'cdk',
    'deploy',
    'HarborAdmin',
    '--app',
    'npx tsx infra/admin.ts',
    '--require-approval',
    'never',
    '--outputs-file',
    '.cloud/admin-outputs.json',
    '--parameters',
    `AdminApiHostname=${apiHost}`,
  ]);
}
const site = JSON.parse(await readFile('.cloud/admin-outputs.json', 'utf8')).HarborAdmin;
if (!assetsOnly && process.env.ADMIN_ORIGIN !== site.AdminUrl) {
  process.env.ADMIN_ORIGIN = site.AdminUrl;
  let env = await readFile('.env.cloud', 'utf8');
  env = /^ADMIN_ORIGIN=.*$/m.test(env)
    ? env.replace(/^ADMIN_ORIGIN=.*$/m, `ADMIN_ORIGIN=${site.AdminUrl}`)
    : env + `\nADMIN_ORIGIN=${site.AdminUrl}\n`;
  await writeFile('.env.cloud', env, { mode: 0o600 });
  await run('npm', ['run', 'cloud:deploy']);
}
await run('aws', [
  's3',
  'sync',
  'apps/admin/out/_next/static',
  `s3://${site.AdminBucketName}/_next/static`,
  '--cache-control',
  'public,max-age=31536000,immutable',
  '--only-show-errors',
]);
await run('aws', [
  's3',
  'sync',
  'apps/admin/out',
  `s3://${site.AdminBucketName}`,
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
      site.AdminDistributionId,
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
  site.AdminDistributionId,
  '--id',
  invalidation.Invalidation.Id,
]);
console.log(`Published the harbor0 management console at ${site.AdminUrl}`);
