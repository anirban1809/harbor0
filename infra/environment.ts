import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
// One switch for every deploy script and CDK app: HARBOR_ENV=staging targets a fully separate
// copy of the infrastructure (its own stacks, table, user pools, Lambdas, secrets, R2 bucket and
// distributions). Unset means production, whose stack names and resources are unchanged.
const name = process.env.HARBOR_ENV ?? 'production';
if (name !== 'production' && name !== 'staging')
  throw new Error(`HARBOR_ENV must be "production" or "staging", not "${name}".`);
const production = name === 'production';
const suffix = production ? '' : 'Staging';

export const harborEnv = {
  name,
  production,
  stacks: {
    storage: `HarborStorage${suffix}`,
    web: `HarborWeb${suffix}`,
    admin: `HarborAdmin${suffix}`,
  },
  /** Git-ignored settings and credentials for this environment. */
  envFile: production ? '.env.cloud' : '.env.staging',
  /** Git-ignored deploy outputs; staging keeps its own so the two never overwrite each other. */
  cloudDir: production ? '.cloud' : '.cloud/staging',
  r2SecretName: production ? 'harbor-storage/r2' : 'harbor-storage-staging/r2',
  apnsSecretName: production ? 'harbor0-apns' : 'harbor0-staging-apns',
  appDomain: process.env.WEB_DOMAIN || (production ? 'app.harbor0.com' : 'staging.harbor0.com'),
  /** Staging deploys only from this branch. */
  branch: production ? undefined : 'staging',
};

const outputFiles = {
  storage: 'outputs.json',
  web: 'web-outputs.json',
  admin: 'admin-outputs.json',
};
export const outputsPath = (kind: keyof typeof outputFiles) =>
  `${harborEnv.cloudDir}/${outputFiles[kind]}`;
export async function readOutputs(kind: keyof typeof outputFiles) {
  return JSON.parse(await readFile(outputsPath(kind), 'utf8'))[harborEnv.stacks[kind]];
}

/** Staging is built from the `staging` branch only, so what runs there is what was pushed. */
export function assertDeployBranch() {
  if (!harborEnv.branch || process.env.HARBOR_ALLOW_ANY_BRANCH === 'true') return;
  const branch =
    process.env.GITHUB_REF_NAME ||
    execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();
  if (branch !== harborEnv.branch)
    throw new Error(
      `${harborEnv.name} deploys from the "${harborEnv.branch}" branch; this checkout is on "${branch}". ` +
        'Set HARBOR_ALLOW_ANY_BRANCH=true to override deliberately.',
    );
}
