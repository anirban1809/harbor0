import { spawn } from 'node:child_process';
import { readFile, writeFile, access } from 'node:fs/promises';
const outputs = JSON.parse(await readFile('.cloud/outputs.json', 'utf8')).HarborStorage;
const apiHost = new URL(outputs.ApiUrl).hostname;
if (!/^[a-z0-9]+\.execute-api\.[a-z0-9-]+\.amazonaws\.com$/.test(apiHost))
  throw new Error('Expected the deployed harbor0 API Gateway endpoint.');
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
await run('npm', ['run', 'build:web-static']);
await access('.cloud/web-export/out/index.html');
await run('npm', ['run', 'test:web-styles']);
const assetsOnly = process.argv.includes('--assets-only');
if (!assetsOnly && process.env.WEB_CERT_ARN) {
  const status = (
    await run(
      'aws',
      [
        'acm',
        'describe-certificate',
        '--region',
        'us-east-1',
        '--certificate-arn',
        process.env.WEB_CERT_ARN,
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
      `app.harbor0.com certificate is ${status}; add its DNS validation record first.`,
    );
}
if (!assetsOnly) {
  await run('npx', [
    'cdk',
    'deploy',
    'HarborWeb',
    '--app',
    'npx tsx infra/web.ts',
    '--require-approval',
    'never',
    '--outputs-file',
    '.cloud/web-outputs.json',
    '--parameters',
    `ApiHostname=${apiHost}`,
  ]);
}
const web = JSON.parse(await readFile('.cloud/web-outputs.json', 'utf8')).HarborWeb;
if (!assetsOnly) {
  process.env.WEB_ORIGIN = web.WebUrl;
  let env = await readFile('.env.cloud', 'utf8');
  env = /^WEB_ORIGIN=.*$/m.test(env)
    ? env.replace(/^WEB_ORIGIN=.*$/m, `WEB_ORIGIN=${web.WebUrl}`)
    : env + `\nWEB_ORIGIN=${web.WebUrl}\n`;
  await writeFile('.env.cloud', env, { mode: 0o600 });
  await run('npx', ['tsx', '--env-file=.env.cloud', 'scripts/configure-r2-cors.ts']);
  await run('npm', ['run', 'cloud:deploy']);
}
// Upload hashed assets first and retain older chunks for browsers opened before
// the release. Publish uncached HTML only after all its dependencies exist.
await run('aws', [
  's3',
  'sync',
  '.cloud/web-export/out/_next/static',
  `s3://${web.WebBucketName}/_next/static`,
  '--cache-control',
  'public,max-age=31536000,immutable',
  '--only-show-errors',
]);
await run('aws', [
  's3',
  'sync',
  '.cloud/web-export/out',
  `s3://${web.WebBucketName}`,
  '--exclude',
  '_next/static/*',
  '--exclude',
  'downloads/*',
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
      web.DistributionId,
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
  web.DistributionId,
  '--id',
  invalidation.Invalidation.Id,
]);
console.log(`Published harbor0 at ${web.WebUrl}`);
