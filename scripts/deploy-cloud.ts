import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import {
  SecretsManagerClient,
  CreateSecretCommand,
  DescribeSecretCommand,
  PutSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import { S3Client, HeadBucketCommand } from '@aws-sdk/client-s3';
import { z } from 'zod';

const config = z
  .object({
    AWS_REGION: z.string().min(1),
    R2_BUCKET: z.string().min(1),
    R2_ENDPOINT: z.url(),
    R2_ACCESS_KEY_ID: z.string().min(1),
    R2_SECRET_ACCESS_KEY: z.string().min(1),
    WEB_ORIGIN: z.url(),
    EMAIL_FROM: z.union([z.email(), z.literal('')]).default(''),
  })
  .parse(process.env);
const endpoint = new URL(config.R2_ENDPOINT);
if (endpoint.protocol !== 'https:' || !endpoint.hostname.endsWith('.r2.cloudflarestorage.com'))
  throw new Error('A live HTTPS R2 endpoint is required.');
const s3 = new S3Client({
  endpoint: config.R2_ENDPOINT,
  region: 'auto',
  credentials: {
    accessKeyId: config.R2_ACCESS_KEY_ID,
    secretAccessKey: config.R2_SECRET_ACCESS_KEY,
  },
});
await s3.send(new HeadBucketCommand({ Bucket: config.R2_BUCKET }));
const secrets = new SecretsManagerClient({ region: config.AWS_REGION });
const name = 'harbor-storage/r2';
const SecretString = JSON.stringify({
  accessKeyId: config.R2_ACCESS_KEY_ID,
  secretAccessKey: config.R2_SECRET_ACCESS_KEY,
});
let arn: string;
try {
  const existing = await secrets.send(new DescribeSecretCommand({ SecretId: name }));
  if (!existing.Tags?.some((tag) => tag.Key === 'Project' && tag.Value === 'HarborStorage'))
    throw new Error('An unrelated secret already uses the deployment secret name.');
  arn = existing.ARN!;
  await secrets.send(new PutSecretValueCommand({ SecretId: arn, SecretString }));
} catch (error) {
  if ((error as { name: string }).name !== 'ResourceNotFoundException') throw error;
  arn = (
    await secrets.send(
      new CreateSecretCommand({
        Name: name,
        Description: 'harbor0 private R2 runtime credentials',
        SecretString,
        Tags: [{ Key: 'Project', Value: 'HarborStorage' }],
      }),
    )
  ).ARN!;
}
console.log('R2 access verified. Runtime credentials stored in AWS Secrets Manager.');
await mkdir('.cloud', { recursive: true, mode: 0o700 });
await writeFile(
  '.cloud/deployment.json',
  JSON.stringify(
    {
      region: config.AWS_REGION,
      stackName: 'HarborStorage',
      bucket: config.R2_BUCKET,
      endpoint: config.R2_ENDPOINT,
      webOrigin: config.WEB_ORIGIN,
      secretArn: arn,
    },
    null,
    2,
  ),
  { mode: 0o600 },
);
async function run(command: string, args: string[]) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', env: process.env });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)),
    );
  });
}
await run('npm', ['run', 'build:backend']);
await run('npx', [
  'cdk',
  'deploy',
  'HarborStorage',
  '--app',
  'npx tsx infra/app.ts',
  '--require-approval',
  'never',
  '--outputs-file',
  '.cloud/outputs.json',
  '--parameters',
  `WebOrigin=${config.WEB_ORIGIN}`,
  '--parameters',
  `R2Endpoint=${config.R2_ENDPOINT}`,
  '--parameters',
  `R2Bucket=${config.R2_BUCKET}`,
  '--parameters',
  `R2SecretArn=${arn}`,
  '--parameters',
  `EmailFrom=${config.EMAIL_FROM}`,
  '--parameters',
  `AdminOrigin=${process.env.ADMIN_ORIGIN ?? ''}`,
]);
console.log('Cloud deployment finished. Non-secret outputs are in .cloud/outputs.json.');
