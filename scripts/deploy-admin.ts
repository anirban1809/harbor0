import { spawn } from 'node:child_process';
import { readFile, writeFile, access } from 'node:fs/promises';
import { assertDeployBranch, harborEnv, outputsPath, readOutputs } from '../infra/environment';
// Publishes the management console: HarborAdmin (static site + /api/* → console API), then
// records its origin in the environment's settings file and redeploys the storage stack so the
// console API accepts it.
assertDeployBranch();
const outputs = await readOutputs('storage');
if (!outputs.AdminApiUrl) throw new Error('Deploy the storage stack first: no AdminApiUrl output.');
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
    harborEnv.stacks.admin,
    '--app',
    'npx tsx infra/admin.ts',
    '--require-approval',
    'never',
    '--outputs-file',
    outputsPath('admin'),
    '--parameters',
    `AdminApiHostname=${apiHost}`,
  ]);
}
const site = await readOutputs('admin');
if (!assetsOnly && process.env.ADMIN_ORIGIN !== site.AdminUrl) {
  process.env.ADMIN_ORIGIN = site.AdminUrl;
  let env = await readFile(harborEnv.envFile, 'utf8');
  env = /^ADMIN_ORIGIN=.*$/m.test(env)
    ? env.replace(/^ADMIN_ORIGIN=.*$/m, `ADMIN_ORIGIN=${site.AdminUrl}`)
    : env + `\nADMIN_ORIGIN=${site.AdminUrl}\n`;
  await writeFile(harborEnv.envFile, env, { mode: 0o600 });
  await run('npx', ['tsx', `--env-file=${harborEnv.envFile}`, 'scripts/deploy-cloud.ts']);
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
console.log(`Published the harbor0 ${harborEnv.name} management console at ${site.AdminUrl}`);
