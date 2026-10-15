import { spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { assertDeployBranch, harborEnv, outputsPath, readOutputs } from '../infra/environment';
// Public link pages (apps/share) on harbor0content.online: build the static export, deploy the
// HarborShare stack in front of it and the API's public routes, then publish the files.
assertDeployBranch();
const outputs = await readOutputs('storage');
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
await run('npm', ['run', 'build', '-w', '@harbor/share']);
await access('apps/share/out/s.html');
if ((await readFile('apps/share/out/s.html', 'utf8')).includes('127.0.0.1'))
  throw new Error('The link page export still points at a local address.');
const assetsOnly = process.argv.includes('--assets-only');
if (!assetsOnly && process.env.SHARE_CERT_ARN) {
  const status = (
    await run(
      'aws',
      [
        'acm',
        'describe-certificate',
        '--region',
        'us-east-1',
        '--certificate-arn',
        process.env.SHARE_CERT_ARN,
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
      `${harborEnv.shareDomain} certificate is ${status}; add its DNS validation record first.`,
    );
}
// The storage stack makes the secret; CI deploys it, so read its ARN from CloudFormation rather
// than from local outputs that may predate it.
async function edgeSecretValue() {
  const arn = (
    await run(
      'aws',
      [
        'cloudformation',
        'describe-stacks',
        '--stack-name',
        harborEnv.stacks.storage,
        '--query',
        "Stacks[0].Outputs[?OutputKey=='PublicLinkEdgeSecretArn'].OutputValue",
        '--output',
        'text',
      ],
      true,
    )
  ).trim();
  if (!arn.startsWith('arn:'))
    throw new Error('Deploy the storage stack first: it creates the public link edge secret.');
  return (
    await run(
      'aws',
      [
        'secretsmanager',
        'get-secret-value',
        '--secret-id',
        arn,
        '--query',
        'SecretString',
        '--output',
        'text',
      ],
      true,
    )
  ).trim();
}
const edgeSecret = assetsOnly ? '' : await edgeSecretValue();
if (!assetsOnly)
  await run('npx', [
    'cdk',
    'deploy',
    harborEnv.stacks.share,
    '--app',
    'npx tsx infra/share.ts',
    '--require-approval',
    'never',
    '--outputs-file',
    outputsPath('share'),
    '--parameters',
    `ApiHostname=${apiHost}`,
    '--parameters',
    `EdgeSecret=${edgeSecret}`,
  ]);
const site = await readOutputs('share');
// Upload hashed assets before the HTML that references them.
await run('aws', [
  's3',
  'sync',
  'apps/share/out/_next/static',
  `s3://${site.ShareBucketName}/_next/static`,
  '--cache-control',
  'public,max-age=31536000,immutable',
  '--only-show-errors',
]);
await run('aws', [
  's3',
  'sync',
  'apps/share/out',
  `s3://${site.ShareBucketName}`,
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
      site.ShareDistributionId,
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
  site.ShareDistributionId,
  '--id',
  invalidation.Invalidation.Id,
]);
console.log(
  `Published public link pages (${harborEnv.name}) at ${site.ShareUrl}` +
    (process.env.SHARE_CERT_ARN
      ? ''
      : `. Point ${harborEnv.shareDomain} at ${site.ShareDistributionDomain} once SHARE_CERT_ARN is set.`),
);
