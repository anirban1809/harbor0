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
import { EmailLinks, EmailSuppressions, recordMailEvent, type SesEventDetail } from './email-preferences';
const configSchema = z.object({
  TABLE_NAME: z.string().min(1),
  COGNITO_USER_POOL_ID: z.string().min(1),
  COGNITO_CLIENT_ID: z.string().min(1),
  R2_BUCKET: z.string().min(1),
  R2_ENDPOINT: z.url(),
  R2_SECRET_ARN: z.string().min(1),
  WEB_ORIGIN: z.url(),
  EMAIL_FROM: z.union([z.email(), z.literal('')]).default(''),
  /** SES configuration set that reports delivery events for every message. */
  MAIL_CONFIGURATION_SET: z.string().optional(),
  /** Secrets Manager secret (a plain string) that signs unsubscribe links. */
  EMAIL_LINK_SECRET_ARN: z.string().min(1),
  /** Sender for console campaigns, kept apart from account notices; empty refuses to send them. */
  CAMPAIGN_EMAIL_FROM: z.union([z.email(), z.literal('')]).default(''),
  /** Campaign emails a second; SES accounts allow 14 by default and notices share the rate. */
  CAMPAIGN_SEND_RATE: z.coerce.number().int().min(1).max(100).default(10),
});
let instance: ReturnType<typeof initialize> | undefined;
async function initialize() {
  const c = configSchema.parse(process.env);
  const secrets = new SecretsManagerClient({});
  const [secret, linkSecret] = await Promise.all([
    secrets.send(new GetSecretValueCommand({ SecretId: c.R2_SECRET_ARN })),
    secrets.send(new GetSecretValueCommand({ SecretId: c.EMAIL_LINK_SECRET_ARN })),
  ]);
  const emailLinks = new EmailLinks(z.string().min(32).parse(linkSecret.SecretString), c.WEB_ORIGIN);
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
    emailLinks,
  );
  app.all('/api/*', (ctx) =>
    proxyBrowserRequest(ctx.req.raw, {
      apiUrl: 'https://harbor.internal',
      allowedOrigin: c.WEB_ORIGIN,
      secureCookies: true,
      upstream: (request) => app.fetch(request),
    }),
  );
  const ses = new SESv2Client({});
  return {
    app,
    service,
    emailLinks,
    campaignRate: c.CAMPAIGN_SEND_RATE,
    sendEmail: c.EMAIL_FROM
      ? async (email: Email) => {
          const from = email.template === 'CAMPAIGN' ? c.CAMPAIGN_EMAIL_FROM : c.EMAIL_FROM;
          if (!from) throw new Error('The campaign sender is not configured.');
          const message = composeEmail(email, c.WEB_ORIGIN);
          await ses.send(
            new SendEmailCommand({
              FromEmailAddress: `harbor0 <${from}>`,
              ConfigurationSetName: c.MAIL_CONFIGURATION_SET,
              Destination: { ToAddresses: [email.to] },
              Content: {
                Simple: {
                  Subject: { Data: message.subject },
                  Body: { Html: { Data: message.html }, Text: { Data: message.text } },
                  Headers: message.headers.length
                    ? message.headers.map((h) => ({ Name: h.name, Value: h.value }))
                    : undefined,
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
      WEB_ORIGIN: z.union([z.url(), z.literal('')]).default(''),
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
    {
      origins: c.ADMIN_ORIGIN ? [c.ADMIN_ORIGIN] : [],
      secureCookies: true,
      inviteRequired: BETA,
      webOrigin: c.WEB_ORIGIN,
    },
  ).app;
  return adminInstance;
}

let suppressions: EmailSuppressions | undefined;
/** SES bounce and complaint events, delivered by EventBridge; needs only the table. */
export function mailEventRuntime() {
  suppressions ??= new EmailSuppressions(
    new DynamoRepository(z.object({ TABLE_NAME: z.string().min(1) }).parse(process.env).TABLE_NAME),
  );
  return (detail: SesEventDetail) => recordMailEvent(suppressions!, detail);
}
