import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from '@aws-sdk/client-apigatewaymanagementapi';
import { z } from 'zod';
import { CognitoAuth } from './auth';
import { composeEmail, type Email } from './emails';
import { DynamoRepository } from './repository';
import { R2Storage } from './storage';
import { StorageService } from './domain';
import { createApp } from './api';
import { Beta } from './beta';
import { BETA } from '@harbor/contracts';
import { Realtime, type RealtimeGateway } from './realtime';
import { LazyApnsSender, PushDelivery, PushRegistrations } from './push';
import { proxyBrowserRequest } from '@harbor/api-client';
import { createAdminApp } from './admin/api';
import { CognitoDirectory } from './admin/directory';
import { CognitoStaffAuth } from './admin/staff-auth';
import type { ObjectStorage } from './storage';
const configSchema = z.object({
  TABLE_NAME: z.string().min(1),
  COGNITO_USER_POOL_ID: z.string().min(1),
  COGNITO_CLIENT_ID: z.string().min(1),
  R2_BUCKET: z.string().min(1),
  R2_ENDPOINT: z.url(),
  R2_SECRET_ARN: z.string().min(1),
  WEB_ORIGIN: z.url(),
  EMAIL_FROM: z.union([z.email(), z.literal('')]).default(''),
});
let instance: ReturnType<typeof initialize> | undefined;
async function initialize() {
  const c = configSchema.parse(process.env);
  const secret = await new SecretsManagerClient({}).send(
    new GetSecretValueCommand({ SecretId: c.R2_SECRET_ARN }),
  );
  const credentials = z
    .object({ accessKeyId: z.string().min(1), secretAccessKey: z.string().min(1) })
    .parse(JSON.parse(secret.SecretString!));
  const repo = new DynamoRepository(c.TABLE_NAME);
  const storage = new R2Storage(
    c.R2_BUCKET,
    c.R2_ENDPOINT,
    credentials.accessKeyId,
    credentials.secretAccessKey,
  );
  const service = new StorageService(repo, storage);
  const auth = new CognitoAuth(c.COGNITO_USER_POOL_ID, c.COGNITO_CLIENT_ID);
  const { app } = createApp(
    service,
    auth,
    [c.WEB_ORIGIN],
    async () => {
      if (process.env.MAINTENANCE_FUNCTION_NAME)
        await new LambdaClient({}).send(
          new InvokeCommand({
            FunctionName: process.env.MAINTENANCE_FUNCTION_NAME,
            InvocationType: 'Event',
          }),
        );
    },
    process.env.REALTIME_URL ? new Realtime(repo, process.env.REALTIME_URL) : undefined,
    new Beta(repo, BETA),
  );
  app.all('/api/*', (ctx) =>
    proxyBrowserRequest(ctx.req.raw, {
      apiUrl: 'https://harbor.internal',
      allowedOrigin: c.WEB_ORIGIN,
      secureCookies: true,
      upstream: (request) => app.fetch(request),
    }),
  );
  return {
    app,
    service,
    sendEmail: c.EMAIL_FROM
      ? async (email: Email) => {
          const message = composeEmail(email, c.WEB_ORIGIN);
          await new SESv2Client({}).send(
            new SendEmailCommand({
              FromEmailAddress: `harbor0 <${c.EMAIL_FROM}>`,
              Destination: { ToAddresses: [email.to] },
              Content: {
                Simple: {
                  Subject: { Data: message.subject },
                  Body: { Html: { Data: message.html }, Text: { Data: message.text } },
                },
              },
            }),
          );
        }
      : undefined,
  };
}
export function runtime() {
  instance ??= initialize().catch((error) => {
    instance = undefined;
    throw error;
  });
  return instance;
}

class ApiGatewayRealtime implements RealtimeGateway {
  private client: ApiGatewayManagementApiClient;
  constructor(endpoint: string) {
    this.client = new ApiGatewayManagementApiClient({ endpoint });
  }
  async send(connectionId: string, message: unknown) {
    try {
      await this.client.send(
        new PostToConnectionCommand({
          ConnectionId: connectionId,
          Data: new TextEncoder().encode(JSON.stringify(message)),
        }),
      );
      return true;
    } catch (error) {
      if ((error as { name: string }).name === 'GoneException') return false;
      throw error;
    }
  }
}
let realtimeInstance: Realtime | undefined;
// The socket and stream functions need only the table, not R2 or Cognito.
export function realtimeRuntime() {
  const c = z
    .object({
      TABLE_NAME: z.string().min(1),
      REALTIME_URL: z.string().min(1),
      REALTIME_ENDPOINT: z.url().optional(),
    })
    .parse(process.env);
  const repo = new DynamoRepository(c.TABLE_NAME);
  realtimeInstance ??= new Realtime(
    repo,
    c.REALTIME_URL,
    c.REALTIME_ENDPOINT ? new ApiGatewayRealtime(c.REALTIME_ENDPOINT) : undefined,
    process.env.APNS_SECRET_ID
      ? new PushDelivery(
          new PushRegistrations(repo),
          new LazyApnsSender(
            () => apnsCredentials(process.env.APNS_SECRET_ID!),
            process.env.APNS_BUNDLE_ID ?? 'app.harbor0.ios',
          ),
        )
      : undefined,
  );
  return realtimeInstance;
}

/** The APNs signing key ({ keyId, teamId, privateKey }); push is off until the secret exists. */
async function apnsCredentials(secretId: string) {
  try {
    const secret = await new SecretsManagerClient({}).send(
      new GetSecretValueCommand({ SecretId: secretId }),
    );
    return z
      .object({
        keyId: z.string().min(1),
        teamId: z.string().min(1),
        privateKey: z.string().min(1),
      })
      .parse(JSON.parse(secret.SecretString!));
  } catch (error) {
    if ((error as { name?: string }).name === 'ResourceNotFoundException') return null;
    throw error;
  }
}

let adminInstance: ReturnType<typeof createAdminApp>['app'] | undefined;
/**
 * The management console API. It reads and writes the table and administers the customer
 * pool, but holds no R2 credentials: no console action needs file bytes.
 */
export function adminRuntime() {
  if (adminInstance) return adminInstance;
  const c = z
    .object({
      TABLE_NAME: z.string().min(1),
      COGNITO_USER_POOL_ID: z.string().min(1),
      COGNITO_CLIENT_ID: z.string().min(1),
      STAFF_USER_POOL_ID: z.string().min(1),
      STAFF_CLIENT_ID: z.string().min(1),
      ADMIN_ORIGIN: z.union([z.url(), z.literal('')]).default(''),
    })
    .parse(process.env);
  const noStorage = new Proxy({} as ObjectStorage, {
    get: () => () =>
      Promise.reject(new Error('The management console has no file storage access.')),
  });
  adminInstance = createAdminApp(
    new StorageService(new DynamoRepository(c.TABLE_NAME), noStorage),
    new CognitoDirectory(c.COGNITO_USER_POOL_ID, c.COGNITO_CLIENT_ID),
    new CognitoStaffAuth(c.STAFF_USER_POOL_ID, c.STAFF_CLIENT_ID),
    { origins: c.ADMIN_ORIGIN ? [c.ADMIN_ORIGIN] : [], secureCookies: true, inviteRequired: BETA },
  ).app;
  return adminInstance;
}
