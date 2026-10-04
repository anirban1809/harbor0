import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { WebSocketServer, type WebSocket } from 'ws';
import { createApp } from './api';
import { Beta } from './beta';
import { CognitoAuth, DevelopmentAuth } from './auth';
import { DynamoRepository, type Key, type Write } from './repository';
import { Realtime } from './realtime';
import { ApnsSender, PushDelivery, PushRegistrations } from './push';
import { R2Storage } from './storage';
import { StorageService } from './domain';
import { createAdminApp } from './admin/api';
import { DevelopmentDirectory } from './admin/directory';
import { DevelopmentStaffAuth } from './admin/staff-auth';
if (process.env.NODE_ENV === 'production')
  throw new Error('The local server must not run in production. Use the Lambda entrypoint.');
// DynamoDB Local has no stream trigger; report committed keys the way the stream would.
class ObservedRepository extends DynamoRepository {
  onCommit?: (keys: Key[]) => void;
  override async commit(writes: Write[], checks: Write[]) {
    await super.commit(writes, checks);
    this.onCommit?.(writes.filter((write) => write.row).map((write) => write.key));
  }
}
const repo = new ObservedRepository(
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
const realtimePort = Number(process.env.REALTIME_PORT ?? 8788);
const sockets = new Map<string, WebSocket>();
// Optional: APNS_KEY_PATH (.p8), APNS_KEY_ID and APNS_TEAM_ID send File Provider pushes from local dev.
const push = process.env.APNS_KEY_PATH
  ? new PushDelivery(
      new PushRegistrations(repo),
      new ApnsSender(
        {
          keyId: process.env.APNS_KEY_ID ?? '',
          teamId: process.env.APNS_TEAM_ID ?? '',
          privateKey: readFileSync(process.env.APNS_KEY_PATH, 'utf8'),
        },
        process.env.APNS_BUNDLE_ID ?? 'app.harbor0.ios',
      ),
    )
  : undefined;
const realtime = new Realtime(
  repo,
  `ws://127.0.0.1:${realtimePort}`,
  {
    async send(connectionId, message) {
      const socket = sockets.get(connectionId);
      if (!socket || socket.readyState !== socket.OPEN) return false;
      socket.send(JSON.stringify(message));
      return true;
    },
  },
  push,
);
repo.onCommit = (keys) =>
  void realtime.publish(keys).catch(() => console.error('Local realtime publish failed'));
new WebSocketServer({ host: '127.0.0.1', port: realtimePort }).on(
  'connection',
  async (socket, request) => {
    const connectionId = randomUUID();
    const ticket = new URL(request.url ?? '/', 'ws://local').searchParams.get('ticket');
    try {
      await realtime.connect(connectionId, ticket ?? undefined);
    } catch {
      socket.close(4401, 'Unauthorized');
      return;
    }
    sockets.set(connectionId, socket);
    socket.on('close', () => {
      sockets.delete(connectionId);
      void realtime.disconnect(connectionId).catch(() => {});
    });
  },
);
const auth =
  process.env.DEV_AUTH === 'true'
    ? new DevelopmentAuth()
    : new CognitoAuth(process.env.COGNITO_USER_POOL_ID!, process.env.COGNITO_CLIENT_ID!);
if (auth instanceof DevelopmentAuth)
  for (const identity of auth.users.values()) {
    try {
      await service.ensureUser(identity);
      await service.registerDevice(
        identity.id,
        { name: 'Development browser', platform: 'WEB' },
        identity.deviceId,
      );
    } catch {
      /* Deleted development accounts and revoked devices stay that way. */
    }
  }
const { app } = createApp(
  service,
  auth,
  ['http://localhost:3000', 'http://127.0.0.1:3000'],
  async () => {
    void service.runJobs().catch(() => console.error('Local archive worker failed'));
  },
  realtime,
  // Local sign-up is open unless HARBOR_INVITE_ONLY=true, so tests can create accounts freely.
  new Beta(repo, process.env.HARBOR_INVITE_ONLY === 'true'),
);
serve({ fetch: app.fetch, hostname: '127.0.0.1', port: Number(process.env.PORT ?? 8787) }, () =>
  console.log('harbor0 API listening at http://127.0.0.1:8787'),
);
// The management console API runs as its own server, as it is its own Lambda in the cloud.
if (auth instanceof DevelopmentAuth) {
  const adminPort = Number(process.env.ADMIN_PORT ?? 8789);
  const { app: adminApp } = createAdminApp(
    service,
    new DevelopmentDirectory(auth),
    new DevelopmentStaffAuth(),
    {
      origins: ['http://localhost:3300', 'http://127.0.0.1:3300'],
      secureCookies: false,
      inviteRequired: process.env.HARBOR_INVITE_ONLY === 'true',
    },
  );
  serve({ fetch: adminApp.fetch, hostname: '127.0.0.1', port: adminPort }, () =>
    console.log(`harbor0 admin API listening at http://127.0.0.1:${adminPort}`),
  );
}
const timer = setInterval(
  () =>
    void service
      .runJobs(async (email) =>
        console.log(
          JSON.stringify({
            event: 'development_email_recorded',
            template: email.template,
            to: email.to,
            ...(email.template === 'BETA_INVITE'
              ? { link: `http://localhost:3000/signup?invite=${email.code}` }
              : {}),
            message: 'Local email is not delivered.',
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
