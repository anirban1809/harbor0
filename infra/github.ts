import { App, Stack, CfnOutput, Duration, aws_iam as iam } from 'aws-cdk-lib';
import { harborEnv } from './environment';
// The role GitHub Actions assumes to deploy one environment. Only workflow runs on that
// environment's branch of this repository can assume it (OIDC, no stored AWS keys):
// production ← main (automatic, after Validate passes), staging ← staging (manual runs only).
// Deploy once per environment, by hand:
//   npx cdk deploy HarborGitHubProduction --app 'npx tsx infra/github.ts'
//   HARBOR_ENV=staging npx cdk deploy HarborGitHubStaging --app 'npx tsx infra/github.ts'
// then set the DeployRoleArn output as the PRODUCTION_/STAGING_AWS_ROLE_ARN repository variable.
const repository = 'anirban1809/harbor0';
// The repository uses GitHub's immutable OIDC subject, which names the owner and repository by
// login@id, so a renamed or re-created repository with the same name cannot assume the role.
const subjectRepository = 'anirban1809@43294429/harbor0@1392168060';
const branch = harborEnv.branch;
const label = harborEnv.production ? 'Production' : 'Staging';
const app = new App();
const stack = new Stack(app, `HarborGitHub${label}`);
const provider = iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
  stack,
  'GitHub',
  `arn:${stack.partition}:iam::${stack.account}:oidc-provider/token.actions.githubusercontent.com`,
);
const role = new iam.Role(stack, `${label}Deploy`, {
  description: `GitHub Actions deploys of harbor0 ${harborEnv.name} from ${repository}@${branch}`,
  maxSessionDuration: Duration.hours(1),
  assumedBy: new iam.WebIdentityPrincipal(provider.openIdConnectProviderArn, {
    StringEquals: {
      'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
      'token.actions.githubusercontent.com:sub': `repo:${subjectRepository}:ref:refs/heads/${branch}`,
    },
  }),
});
// CDK deploys through the bootstrap roles (asset publishing, CloudFormation, lookups).
role.addToPolicy(
  new iam.PolicyStatement({
    actions: ['sts:AssumeRole', 'sts:TagSession'],
    resources: [`arn:${stack.partition}:iam::${stack.account}:role/cdk-hnb659fds-*`],
  }),
);
// deploy-cloud keeps the environment's R2 keys in its own secret.
role.addToPolicy(
  new iam.PolicyStatement({
    actions: [
      'secretsmanager:DescribeSecret',
      'secretsmanager:PutSecretValue',
      'secretsmanager:CreateSecret',
      'secretsmanager:TagResource',
    ],
    resources: [
      `arn:${stack.partition}:secretsmanager:${stack.region}:${stack.account}:secret:${harborEnv.r2SecretName}-*`,
    ],
  }),
);
// Static uploads go only to this environment's buckets (CDK names them after their stacks, so
// `harborweb-*` never matches staging's `harborwebstaging-*`).
const buckets = harborEnv.production
  ? ['harborweb-*', 'harboradmin-*', 'harborlanding-*']
  : ['harborwebstaging-*', 'harboradminstaging-*'];
role.addToPolicy(
  new iam.PolicyStatement({
    actions: ['s3:ListBucket', 's3:GetObject', 's3:PutObject', 's3:DeleteObject'],
    resources: buckets.flatMap((prefix) => [
      `arn:${stack.partition}:s3:::${prefix}`,
      `arn:${stack.partition}:s3:::${prefix}/*`,
    ]),
  }),
);
role.addToPolicy(
  new iam.PolicyStatement({
    actions: [
      'cloudfront:CreateInvalidation',
      'cloudfront:GetInvalidation',
      'acm:DescribeCertificate',
    ],
    resources: ['*'],
  }),
);
new CfnOutput(stack, 'DeployRoleArn', { value: role.roleArn });
