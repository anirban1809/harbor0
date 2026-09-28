import { serve } from '@hono/node-server';
import { createApp } from './api';
import { CognitoAuth, DevelopmentAuth } from './auth';
import { DynamoRepository } from './repository';
import { R2Storage } from './storage';
import { StorageService } from './domain';
if (process.env.NODE_ENV === 'production')
  throw new Error('The local server must not run in production. Use the Lambda entrypoint.');
const repo = new DynamoRepository(
  process.env.TABLE_NAME ?? 'harbor-local',
  process.env.DYNAMODB_ENDPOINT ?? 'http://127.0.0.1:8100',
);
const storage = new R2Storage(
  process.env.R2_BUCKET ?? 'harbor-local',
  process.env.R2_ENDPOINT ?? 'http://127.0.0.1:9100',
  process.env.R2_ACCESS_KEY_ID ?? 'local-storage',
  process.env.R2_SECRET_ACCESS_KEY ?? 'local-development-secret',
);
const service = new StorageService(repo, storage);
const auth =
  process.env.DEV_AUTH === 'true'
    ? new DevelopmentAuth()
    : new CognitoAuth(process.env.COGNITO_USER_POOL_ID!, process.env.COGNITO_CLIENT_ID!);
if (auth instanceof DevelopmentAuth)
  for (const identity of auth.users.values()) {
    await service.ensureUser(identity);
    try {
      await service.registerDevice(
        identity.id,
        { name: 'Development browser', platform: 'WEB' },
        identity.deviceId,
      );
    } catch {
      /* Revoked development devices stay revoked. */
    }
  }
const { app } = createApp(
  service,
  auth,
  ['http://localhost:3000', 'http://127.0.0.1:3000'],
  async () => {
    void service.runJobs().catch(() => console.error('Local archive worker failed'));
  },
);
serve({ fetch: app.fetch, hostname: '127.0.0.1', port: Number(process.env.PORT ?? 8787) }, () =>
  console.log('harbor0 API listening at http://127.0.0.1:8787'),
);
const timer = setInterval(
  () =>
    void service
      .runJobs(async () =>
        console.log(
          JSON.stringify({
            event: 'development_invitation_recorded',
            message:
              'Invitation remains accessible through verified signup; local email is not delivered.',
          }),
        ),
      )
      .catch(() => console.error('Local job runner failed')),
  60_000,
);
process.on('SIGTERM', () => {
  clearInterval(timer);
  process.exit(0);
});
