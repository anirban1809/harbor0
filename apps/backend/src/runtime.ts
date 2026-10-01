import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from '@aws-sdk/client-apigatewaymanagementapi';
import { z } from 'zod';
import { CognitoAuth } from './auth';
import { DynamoRepository } from './repository';
import { R2Storage } from './storage';
import { StorageService } from './domain';
import { createApp } from './api';
import { Realtime, type RealtimeGateway } from './realtime';
import { proxyBrowserRequest } from '@harbor/api-client';
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
      ? async (to: string, sender: string) => {
          await new SESv2Client({}).send(
            new SendEmailCommand({
              FromEmailAddress: c.EMAIL_FROM,
              Destination: { ToAddresses: [to] },
              Content: {
                Simple: {
                  Subject: { Data: 'A file is waiting for you in harbor0' },
                  Body: {
                    Text: {
                      Data: `${sender} sent you files in harbor0. Create an account with this email address and verify it to receive them. Sign in at ${c.WEB_ORIGIN}. Invitations expire after 30 days. Files are never available through public links.`,
                    },
                  },
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
  realtimeInstance ??= new Realtime(
    new DynamoRepository(c.TABLE_NAME),
    c.REALTIME_URL,
    c.REALTIME_ENDPOINT ? new ApiGatewayRealtime(c.REALTIME_ENDPOINT) : undefined,
  );
  return realtimeInstance;
}
