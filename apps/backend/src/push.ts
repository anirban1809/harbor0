import { createPrivateKey, createSign, type KeyObject } from 'node:crypto';
import { connect, type ClientHttp2Session } from 'node:http2';
import { Transaction, transact, type Repository } from './repository';

// Push wakes clients that cannot keep a connection open, such as the iOS Files extension.
// Like live updates, a push is only a hint: the client then reads its change feed.
export type PushEnvironment = 'sandbox' | 'production';
export type PushRegistration = {
  deviceId: string;
  token: string;
  environment: PushEnvironment;
  kind: 'FILE_PROVIDER';
  /** The File Provider domain to refresh (the account id). */
  domain: string;
  updatedAt: string;
};
export type PushResult = 'sent' | 'gone';
export interface PushSender {
  send(registration: PushRegistration): Promise<PushResult>;
}

const userPK = (id: string) => `USER#${id}`;
const pushKey = (deviceId: string) => `PUSH#${deviceId}`;
// A burst of changes (e.g. a folder upload) wakes each phone once.
const DEBOUNCE_MS = 5000;

export class PushRegistrations {
  constructor(private repo: Repository) {}
  async register(userId: string, input: Omit<PushRegistration, 'updatedAt'>) {
    const registration: PushRegistration = { ...input, updatedAt: new Date().toISOString() };
    await transact(this.repo, (tx) =>
      tx.put(userPK(userId), pushKey(input.deviceId), registration),
    );
    return { registered: true };
  }
  async remove(userId: string, deviceId: string) {
    await transact(this.repo, async (tx) => {
      await tx.get(userPK(userId), pushKey(deviceId));
      await tx.delete(userPK(userId), pushKey(deviceId));
    });
    return { removed: true };
  }
  list(userId: string) {
    return new Transaction(this.repo).list<PushRegistration>(userPK(userId), 'PUSH#');
  }
}

/** Sends one wake-up to each of a user's registered devices, dropping tokens APNs rejects. */
export class PushDelivery {
  private recent = new Map<string, number>();
  constructor(
    private registrations: PushRegistrations,
    private sender: PushSender,
  ) {}
  async changed(userId: string, now = Date.now()) {
    const targets = (await this.registrations.list(userId)).filter((registration) => {
      const last = this.recent.get(registration.token);
      return last === undefined || now - last >= DEBOUNCE_MS;
    });
    await Promise.all(
      targets.map(async (registration) => {
        this.recent.set(registration.token, now);
        try {
          if ((await this.sender.send(registration)) === 'gone')
            await this.registrations.remove(userId, registration.deviceId);
        } catch (error) {
          // Best effort: the client still catches up whenever the app opens.
          console.error(
            JSON.stringify({
              event: 'push_send_failed',
              errorType: (error as Error).name,
              message: (error as Error).message,
            }),
          );
        }
      }),
    );
    if (this.recent.size > 10_000) this.recent.clear();
    return targets.length;
  }
}

export type ApnsCredentials = { keyId: string; teamId: string; privateKey: string };

/**
 * Apple Push Notification service over HTTP/2 with token (JWT) authentication.
 * File Provider pushes use the `fileprovider` type and the app's `.pushkit.fileprovider` topic;
 * iOS then asks the extension for changes to the given container.
 */
export class ApnsSender implements PushSender {
  private key: KeyObject;
  private jwt?: { value: string; issuedAt: number };
  private sessions = new Map<string, ClientHttp2Session>();
  constructor(
    private credentials: ApnsCredentials,
    private bundleId: string,
    private hosts: Record<PushEnvironment, string> = {
      sandbox: 'https://api.sandbox.push.apple.com',
      production: 'https://api.push.apple.com',
    },
  ) {
    this.key = createPrivateKey(credentials.privateKey);
  }
  /** Apple accepts a provider token for up to an hour and rejects refreshes more often than every 20 minutes. */
  private token(now = Math.floor(Date.now() / 1000)) {
    if (this.jwt && now - this.jwt.issuedAt < 45 * 60) return this.jwt.value;
    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = `${encode({ alg: 'ES256', kid: this.credentials.keyId })}.${encode({ iss: this.credentials.teamId, iat: now })}`;
    const signature = createSign('SHA256')
      .update(unsigned)
      .sign({ key: this.key, dsaEncoding: 'ieee-p1363' });
    this.jwt = { value: `${unsigned}.${signature.toString('base64url')}`, issuedAt: now };
    return this.jwt.value;
  }
  private session(host: string) {
    let session = this.sessions.get(host);
    if (!session || session.closed || session.destroyed) {
      session = connect(host);
      session.on('error', () => this.sessions.delete(host));
      session.on('close', () => this.sessions.delete(host));
      session.unref();
      this.sessions.set(host, session);
    }
    return session;
  }
  send(registration: PushRegistration): Promise<PushResult> {
    const body = JSON.stringify({
      'container-identifier': 'NSFileProviderWorkingSetContainerItemIdentifier',
      domain: registration.domain,
    });
    return new Promise((resolve, reject) => {
      const request = this.session(this.hosts[registration.environment]).request({
        ':method': 'POST',
        ':path': `/3/device/${registration.token}`,
        authorization: `bearer ${this.token()}`,
        'apns-push-type': 'fileprovider',
        'apns-topic': `${this.bundleId}.pushkit.fileprovider`,
        'apns-priority': '5',
        'apns-expiration': String(Math.floor(Date.now() / 1000) + 3600),
        // Only the latest wake-up matters; APNs keeps one per device while it is offline.
        'apns-collapse-id': 'changes',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      });
      let status = 0;
      let text = '';
      request.setTimeout(10_000, () => request.close());
      request.on('response', (headers) => (status = Number(headers[':status'])));
      request.on('data', (chunk) => (text += chunk));
      request.on('error', reject);
      request.on('close', () => {
        if (status === 200) return resolve('sent');
        const reason = (() => {
          try {
            return (JSON.parse(text) as { reason?: string }).reason ?? '';
          } catch {
            return '';
          }
        })();
        // The token belongs to an uninstalled app or a different environment.
        if (
          status === 410 ||
          ['BadDeviceToken', 'Unregistered', 'DeviceTokenNotForTopic'].includes(reason)
        )
          return resolve('gone');
        reject(new Error(`APNs ${status || 'no response'} ${reason}`.trim()));
      });
      request.end(body);
    });
  }
  close() {
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
  }
}

/**
 * Loads APNs credentials on first use (e.g. from Secrets Manager). When none are configured,
 * pushes are skipped quietly and clients catch up when the app opens.
 */
export class LazyApnsSender implements PushSender {
  private sender?: Promise<ApnsSender | null>;
  constructor(
    private load: () => Promise<ApnsCredentials | null>,
    private bundleId: string,
  ) {}
  async send(registration: PushRegistration): Promise<PushResult> {
    this.sender ??= this.load().then(
      (credentials) => (credentials ? new ApnsSender(credentials, this.bundleId) : null),
      (error) => {
        this.sender = undefined; // Retry the secret on a later batch.
        throw error;
      },
    );
    const sender = await this.sender;
    return sender ? sender.send(registration) : 'sent';
  }
}
