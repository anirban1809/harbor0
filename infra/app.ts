import {
  App,
  Stack,
  CfnParameter,
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
} from 'aws-cdk-lib';
import { DynamoEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
const app = new App();
const stack = new Stack(app, 'HarborStorage');
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
    'Optional SES verified sender for file invitations; Cognito uses its AWS default sender',
}).valueAsString;
const table = new dynamodb.Table(stack, 'Metadata', {
  partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
  sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
  billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
  encryption: dynamodb.TableEncryption.AWS_MANAGED,
  pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
  timeToLiveAttribute: 'expiresAt',
  // Keys only: live updates need to know which rows changed, never their contents.
  stream: dynamodb.StreamViewType.KEYS_ONLY,
  removalPolicy: RemovalPolicy.RETAIN,
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
  removalPolicy: RemovalPolicy.RETAIN,
});
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
      app.node.tryGetContext('cognitoDomainPrefix') ?? `harbor-${stack.account}-${stack.region}`,
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
  removalPolicy: RemovalPolicy.RETAIN,
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
    resources: [`arn:${stack.partition}:ses:${stack.region}:${stack.account}:identity/*`],
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
    NODE_ENV: 'production',
  },
});
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
}))
  new CfnOutput(stack, key, { value });
