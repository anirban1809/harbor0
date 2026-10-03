import { App, Stack, CfnOutput, Duration, aws_iam as iam } from 'aws-cdk-lib';
// The role GitHub Actions assumes to deploy staging. Only workflow runs on the `staging` branch of
// this repository can assume it (OIDC, no stored AWS keys). Deploy once, by hand:
//   npx cdk deploy HarborGitHubStaging --app 'npx tsx infra/github.ts'
// then set the StagingDeployRoleArn output as the STAGING_AWS_ROLE_ARN repository variable.
const repository = 'anirban1809/harbor0';
const branch = 'staging';
const app = new App();
const stack = new Stack(app, 'HarborGitHubStaging');
const provider = iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
  stack,
  'GitHub',
  `arn:${stack.partition}:iam::${stack.account}:oidc-provider/token.actions.githubusercontent.com`,
);
const role = new iam.Role(stack, 'StagingDeploy', {
  description: `GitHub Actions deploys of harbor0 staging from ${repository}@${branch}`,
  maxSessionDuration: Duration.hours(1),
  assumedBy: new iam.WebIdentityPrincipal(provider.openIdConnectProviderArn, {
    StringEquals: {
      'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
      'token.actions.githubusercontent.com:sub': `repo:${repository}:ref:refs/heads/${branch}`,
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
// deploy-cloud keeps staging's R2 keys in its own secret.
role.addToPolicy(
  new iam.PolicyStatement({
    actions: [
      'secretsmanager:DescribeSecret',
      'secretsmanager:PutSecretValue',
      'secretsmanager:CreateSecret',
      'secretsmanager:TagResource',
    ],
    resources: [
      `arn:${stack.partition}:secretsmanager:${stack.region}:${stack.account}:secret:harbor-storage-staging/r2-*`,
    ],
  }),
);
// Static uploads go only to the staging buckets (CDK names them after their stacks).
role.addToPolicy(
  new iam.PolicyStatement({
    actions: ['s3:ListBucket', 's3:GetObject', 's3:PutObject', 's3:DeleteObject'],
    resources: ['harborwebstaging-*', 'harboradminstaging-*'].flatMap((prefix) => [
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
new CfnOutput(stack, 'StagingDeployRoleArn', { value: role.roleArn });
