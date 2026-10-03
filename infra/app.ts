import {
  App,
  Stack,
  CfnParameter,
  CfnCondition,
  Fn,
  CfnOutput,
  Duration,
  RemovalPolicy,
  aws_dynamodb as dynamodb,
  aws_cognito as cognito,
  aws_lambda as lambda,
  aws_apigatewayv2 as apigw,
  aws_apigatewayv2_integrations as integrations,
  aws_iam as iam,
  aws_events as events,
  aws_events_targets as targets,
  aws_logs as logs,
  aws_sqs as sqs,
  aws_cloudwatch as cloudwatch,
  Tags,
} from 'aws-cdk-lib';
import { DynamoEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { harborEnv } from './environment';
const app = new App();
const stack = new Stack(app, harborEnv.stacks.storage);
// Staging is disposable: its data is test data, so it is not retained or backed up when removed.
const removalPolicy = harborEnv.production ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;
if (!harborEnv.production) Tags.of(stack).add('Environment', harborEnv.name);
const param = (name: string, description: string) =>
  new CfnParameter(stack, name, { type: 'String', description }).valueAsString;
const webOrigin = param('WebOrigin', 'HTTPS origin of the deployed web application');
const r2Endpoint = param('R2Endpoint', 'https://<account>.r2.cloudflarestorage.com');
const r2Bucket = param('R2Bucket', 'Existing private R2 bucket');
const r2SecretArn = param(
  'R2SecretArn',
  'Secrets Manager ARN containing accessKeyId and secretAccessKey',
);
const emailFrom = new CfnParameter(stack, 'EmailFrom', {
  type: 'String',
  default: '',
  description:
    'Optional SES sender on a verified domain for invitations and Cognito mail; empty keeps the AWS default Cognito sender',
}).valueAsString;
const hasEmailFrom = new CfnCondition(stack, 'HasEmailFrom', {
  expression: Fn.conditionNot(Fn.conditionEquals(emailFrom, '')),
});
// Cognito sends from the verified domain identity; the trailing '@' keeps the split two-part
// even when the sender is empty.
const emailDomain = Fn.select(1, Fn.split('@', Fn.join('', [emailFrom, '@'])));
const useSesForCognito = (userPool: cognito.UserPool) => {
  (userPool.node.defaultChild as cognito.CfnUserPool).emailConfiguration = Fn.conditionIf(
    hasEmailFrom.logicalId,
    {
      EmailSendingAccount: 'DEVELOPER',
      From: `harbor0 <${emailFrom}>`,
      SourceArn: `arn:${stack.partition}:ses:${stack.region}:${stack.account}:identity/${emailDomain}`,
    },
    { EmailSendingAccount: 'COGNITO_DEFAULT' },
  );
};
const adminOrigin = new CfnParameter(stack, 'AdminOrigin', {
  type: 'String',
  default: '',
  description: 'HTTPS origin of the management console; empty refuses every console change',
}).valueAsString;
const table = new dynamodb.Table(stack, 'Metadata', {
  partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
  sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
  billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
  encryption: dynamodb.TableEncryption.AWS_MANAGED,
  pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: harborEnv.production },
  timeToLiveAttribute: 'expiresAt',
  // Keys only: live updates need to know which rows changed, never their contents.
  stream: dynamodb.StreamViewType.KEYS_ONLY,
  removalPolicy,
});
table.addGlobalSecondaryIndex({
  indexName: 'jobs',
  partitionKey: { name: 'gpk', type: dynamodb.AttributeType.STRING },
  sortKey: { name: 'gsk', type: dynamodb.AttributeType.STRING },
  projectionType: dynamodb.ProjectionType.ALL,
});
const pool = new cognito.UserPool(stack, 'Users', {
  selfSignUpEnabled: true,
  signInAliases: { email: true },
  signInCaseSensitive: false,
  autoVerify: { email: true },
  email: cognito.UserPoolEmail.withCognito(),
  standardAttributes: {
    email: { required: true, mutable: false },
    preferredUsername: { required: true, mutable: false },
    fullname: { required: false, mutable: true },
  },
  passwordPolicy: {
    minLength: 12,
    requireDigits: true,
    requireLowercase: true,
    requireUppercase: true,
    requireSymbols: true,
  },
  accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
  removalPolicy,
});
useSesForCognito(pool);
const registration = new lambda.Function(stack, 'Registration', {
  runtime: lambda.Runtime.NODEJS_22_X,
  handler: 'index.preSignup',
  code: lambda.Code.fromAsset('dist/backend'),
  timeout: Duration.seconds(10),
  environment: { TABLE_NAME: table.tableName, NODE_ENV: 'production' },
});
table.grantReadWriteData(registration);
pool.addTrigger(cognito.UserPoolOperation.PRE_SIGN_UP, registration);
const client = new cognito.CfnUserPoolClient(stack, 'Client', {
  userPoolId: pool.userPoolId,
  generateSecret: false,
  explicitAuthFlows: ['ALLOW_USER_PASSWORD_AUTH', 'ALLOW_USER_SRP_AUTH'],
  enableTokenRevocation: true,
  preventUserExistenceErrors: 'ENABLED',
  accessTokenValidity: 15,
  idTokenValidity: 15,
  refreshTokenValidity: 30,
  tokenValidityUnits: { accessToken: 'minutes', idToken: 'minutes', refreshToken: 'days' },
  refreshTokenRotation: { feature: 'ENABLED', retryGracePeriodSeconds: 10 },
  readAttributes: ['email', 'email_verified', 'preferred_username', 'name'],
  writeAttributes: ['email', 'preferred_username', 'name'],
  supportedIdentityProviders: ['COGNITO'],
  allowedOAuthFlowsUserPoolClient: true,
  allowedOAuthFlows: ['code'],
  allowedOAuthScopes: ['openid', 'email', 'profile', 'aws.cognito.signin.user.admin'],
  callbackUrLs: ['harbor://auth/callback'],
  logoutUrLs: [webOrigin],
});
const domain = pool.addDomain('ManagedLogin', {
  cognitoDomain: {
    domainPrefix:
      app.node.tryGetContext('cognitoDomainPrefix') ??
      (harborEnv.production
        ? `harbor-${stack.account}-${stack.region}`
        : `harbor-${harborEnv.name}-${stack.account}-${stack.region}`),
  },
});
const environment = {
  TABLE_NAME: table.tableName,
  COGNITO_USER_POOL_ID: pool.userPoolId,
  COGNITO_CLIENT_ID: client.ref,
  R2_BUCKET: r2Bucket,
  R2_ENDPOINT: r2Endpoint,
  R2_SECRET_ARN: r2SecretArn,
  WEB_ORIGIN: webOrigin,
  EMAIL_FROM: emailFrom,
  NODE_ENV: 'production',
};
const logGroup = new logs.LogGroup(stack, 'ApiLogs', {
  retention: logs.RetentionDays.ONE_MONTH,
  removalPolicy,
});
const apiFunction = new lambda.Function(stack, 'Api', {
  runtime: lambda.Runtime.NODEJS_22_X,
  handler: 'index.handler',
  code: lambda.Code.fromAsset('dist/backend'),
  memorySize: 512,
  timeout: Duration.seconds(29),
  environment,
  logGroup,
});
const jobsFunction = new lambda.Function(stack, 'Maintenance', {
  runtime: lambda.Runtime.NODEJS_22_X,
  handler: 'index.jobs',
  code: lambda.Code.fromAsset('dist/backend'),
  memorySize: 512,
  timeout: Duration.minutes(5),
  environment,
});
jobsFunction.grantInvoke(apiFunction);
apiFunction.addEnvironment('MAINTENANCE_FUNCTION_NAME', jobsFunction.functionName);
for (const fn of [apiFunction, jobsFunction]) {
  table.grantReadWriteData(fn);
  fn.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [r2SecretArn],
    }),
  );
}
jobsFunction.addToRolePolicy(
  new iam.PolicyStatement({
    actions: ['ses:SendEmail'],
    // The domain's default configuration set is checked as a resource too.
    resources: [
      `arn:${stack.partition}:ses:${stack.region}:${stack.account}:identity/*`,
      `arn:${stack.partition}:ses:${stack.region}:${stack.account}:configuration-set/*`,
    ],
    conditions: { StringEquals: { 'ses:FromAddress': emailFrom } },
  }),
);
// Live updates: clients hold a WebSocket; the table stream says which users to wake.
const realtimeSocket = new lambda.Function(stack, 'RealtimeSocket', {
  runtime: lambda.Runtime.NODEJS_22_X,
  handler: 'index.realtimeSocket',
  code: lambda.Code.fromAsset('dist/backend'),
  memorySize: 256,
  timeout: Duration.seconds(10),
  environment: { TABLE_NAME: table.tableName, NODE_ENV: 'production' },
});
table.grantReadWriteData(realtimeSocket);
const socketIntegration = new integrations.WebSocketLambdaIntegration(
  'RealtimeIntegration',
  realtimeSocket,
);
const sockets = new apigw.WebSocketApi(stack, 'Realtime', {
  connectRouteOptions: { integration: socketIntegration },
  disconnectRouteOptions: { integration: socketIntegration },
  defaultRouteOptions: { integration: socketIntegration },
});
const socketStage = new apigw.WebSocketStage(stack, 'RealtimeStage', {
  webSocketApi: sockets,
  stageName: 'live',
  autoDeploy: true,
  throttle: { burstLimit: 100, rateLimit: 50 },
});
realtimeSocket.addEnvironment('REALTIME_URL', socketStage.url);
apiFunction.addEnvironment('REALTIME_URL', socketStage.url);
const realtimeStream = new lambda.Function(stack, 'RealtimeStream', {
  runtime: lambda.Runtime.NODEJS_22_X,
  handler: 'index.realtimeStream',
  code: lambda.Code.fromAsset('dist/backend'),
  memorySize: 256,
  timeout: Duration.seconds(30),
  environment: {
    TABLE_NAME: table.tableName,
    REALTIME_URL: socketStage.url,
    REALTIME_ENDPOINT: socketStage.callbackUrl,
    // File Provider pushes for iOS; off until the APNs secret (`harbor0-apns`) exists.
    APNS_SECRET_ID: harborEnv.apnsSecretName,
    APNS_BUNDLE_ID: 'app.harbor0.ios',
    NODE_ENV: 'production',
  },
});
realtimeStream.addToRolePolicy(
  new iam.PolicyStatement({
    actions: ['secretsmanager:GetSecretValue'],
    resources: [
      `arn:${stack.partition}:secretsmanager:${stack.region}:${stack.account}:secret:${harborEnv.apnsSecretName}-*`,
    ],
  }),
);
table.grantReadWriteData(realtimeStream);
socketStage.grantManagementApiAccess(realtimeStream);
// Only rows that can wake a client invoke the function.
realtimeStream.addEventSource(
  new DynamoEventSource(table, {
    startingPosition: lambda.StartingPosition.LATEST,
    batchSize: 100,
    retryAttempts: 2,
    maxRecordAge: Duration.minutes(5),
    filters: ['CHANGE#', 'ACCESS#', 'NOTIFICATION#', 'SYNCFOLDERREV#'].map((prefix) =>
      lambda.FilterCriteria.filter({
        eventName: lambda.FilterRule.or('INSERT', 'MODIFY'),
        dynamodb: { Keys: { sk: { S: lambda.FilterRule.beginsWith(prefix) } } },
      }),
    ),
  }),
);
// Management console: staff sign in to their own pool (admin-created, TOTP required), and the
// console API runs in its own Lambda behind its own HTTP API with no R2 access.
const staffPool = new cognito.UserPool(stack, 'Staff', {
  selfSignUpEnabled: false,
  signInAliases: { email: true },
  signInCaseSensitive: false,
  mfa: cognito.Mfa.REQUIRED,
  mfaSecondFactor: { sms: false, otp: true },
  passwordPolicy: {
    minLength: 14,
    requireDigits: true,
    requireLowercase: true,
    requireUppercase: true,
    requireSymbols: true,
    tempPasswordValidity: Duration.days(3),
  },
  // Staff passwords are reset by an administrator, never by email self-service.
  accountRecovery: cognito.AccountRecovery.NONE,
  userInvitation: {
    emailSubject: 'Your harbor0 console account',
    emailBody:
      'An administrator added you to the harbor0 management console. Sign in with {username} and the temporary password {####}, then set a password and add an authenticator app.',
  },
  removalPolicy,
});
useSesForCognito(staffPool);
for (const [id, groupName, description] of [
  ['StaffAdmins', 'admin', 'Full console access: storage limits, suspension, deletion'],
  ['StaffSupport', 'support', 'Read access, notes, password resets and sign-outs'],
])
  new cognito.CfnUserPoolGroup(stack, id, {
    userPoolId: staffPool.userPoolId,
    groupName,
    description,
  });
const staffClient = new cognito.CfnUserPoolClient(stack, 'StaffClient', {
  userPoolId: staffPool.userPoolId,
  generateSecret: false,
  explicitAuthFlows: ['ALLOW_USER_PASSWORD_AUTH'],
  enableTokenRevocation: true,
  preventUserExistenceErrors: 'ENABLED',
  accessTokenValidity: 15,
  idTokenValidity: 15,
  refreshTokenValidity: 12,
  tokenValidityUnits: { accessToken: 'minutes', idToken: 'minutes', refreshToken: 'hours' },
  refreshTokenRotation: { feature: 'ENABLED', retryGracePeriodSeconds: 10 },
  readAttributes: ['email', 'email_verified'],
  writeAttributes: [],
  supportedIdentityProviders: ['COGNITO'],
});
const adminLogs = new logs.LogGroup(stack, 'AdminLogs', {
  retention: logs.RetentionDays.ONE_YEAR,
  removalPolicy,
});
const adminFunction = new lambda.Function(stack, 'Admin', {
  runtime: lambda.Runtime.NODEJS_22_X,
  handler: 'index.admin',
  code: lambda.Code.fromAsset('dist/backend'),
  memorySize: 512,
  timeout: Duration.seconds(29),
  environment: {
    TABLE_NAME: table.tableName,
    COGNITO_USER_POOL_ID: pool.userPoolId,
    COGNITO_CLIENT_ID: client.ref,
    STAFF_USER_POOL_ID: staffPool.userPoolId,
    STAFF_CLIENT_ID: staffClient.ref,
    ADMIN_ORIGIN: adminOrigin,
    NODE_ENV: 'production',
  },
  logGroup: adminLogs,
});
table.grantReadWriteData(adminFunction);
adminFunction.addToRolePolicy(
  new iam.PolicyStatement({
    actions: [
      'cognito-idp:ListUsers',
      'cognito-idp:DescribeUserPool',
      'cognito-idp:AdminResetUserPassword',
      'cognito-idp:AdminConfirmSignUp',
      'cognito-idp:AdminUpdateUserAttributes',
      'cognito-idp:AdminDisableUser',
      'cognito-idp:AdminEnableUser',
      'cognito-idp:AdminUserGlobalSignOut',
      'cognito-idp:AdminDeleteUser',
    ],
    resources: [pool.userPoolArn],
  }),
);
const adminApi = new apigw.HttpApi(stack, 'AdminHttpApi', {
  description: 'harbor0 management console API (reached through the console distribution)',
});
adminApi.addRoutes({
  path: '/{proxy+}',
  methods: [apigw.HttpMethod.ANY],
  integration: new integrations.HttpLambdaIntegration('AdminIntegration', adminFunction),
});
const adminStage = adminApi.defaultStage!.node.defaultChild as apigw.CfnStage;
adminStage.defaultRouteSettings = { throttlingBurstLimit: 20, throttlingRateLimit: 10 };
new cloudwatch.Alarm(stack, 'AdminErrors', {
  metric: adminFunction.metricErrors(),
  threshold: 1,
  evaluationPeriods: 1,
});
const api = new apigw.HttpApi(stack, 'HttpApi', {
  corsPreflight: {
    allowOrigins: [webOrigin],
    allowHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'X-Request-ID'],
    allowMethods: [apigw.CorsHttpMethod.ANY],
    exposeHeaders: ['X-Request-ID'],
  },
});
api.addRoutes({
  path: '/{proxy+}',
  methods: [apigw.HttpMethod.ANY],
  integration: new integrations.HttpLambdaIntegration('Integration', apiFunction),
});
const stage = api.defaultStage!.node.defaultChild as apigw.CfnStage;
stage.defaultRouteSettings = { throttlingBurstLimit: 200, throttlingRateLimit: 100 };
const dlq = new sqs.Queue(stack, 'MaintenanceFailures', {
  retentionPeriod: Duration.days(14),
  encryption: sqs.QueueEncryption.SQS_MANAGED,
});
new events.Rule(stack, 'MaintenanceSchedule', {
  schedule: events.Schedule.rate(Duration.minutes(1)),
  targets: [new targets.LambdaFunction(jobsFunction, { deadLetterQueue: dlq, retryAttempts: 2 })],
});
new cloudwatch.Alarm(stack, 'ApiErrors', {
  metric: apiFunction.metricErrors(),
  threshold: 5,
  evaluationPeriods: 1,
});
new cloudwatch.Alarm(stack, 'RealtimeErrors', {
  metric: realtimeStream.metricErrors(),
  threshold: 5,
  evaluationPeriods: 1,
});
new cloudwatch.Alarm(stack, 'JobErrors', {
  metric: jobsFunction.metricErrors(),
  threshold: 1,
  evaluationPeriods: 1,
});
for (const [key, value] of Object.entries({
  ApiUrl: api.apiEndpoint,
  RealtimeUrl: socketStage.url,
  UserPoolId: pool.userPoolId,
  ClientId: client.ref,
  HostedLogin: domain.baseUrl(),
  TableName: table.tableName,
  ApiFunctionName: apiFunction.functionName,
  MaintenanceFunctionName: jobsFunction.functionName,
  RegistrationFunctionName: registration.functionName,
  AdminApiUrl: adminApi.apiEndpoint,
  StaffUserPoolId: staffPool.userPoolId,
  StaffClientId: staffClient.ref,
}))
  new CfnOutput(stack, key, { value });
