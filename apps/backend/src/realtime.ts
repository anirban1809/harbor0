import { createHash, randomBytes } from 'node:crypto';
import type { ShareGrant } from '@harbor/contracts';
import { Transaction, transact, type Key, type Repository } from './repository';
import { assert } from './errors';

// Live updates are hints only: a message tells a client to read its change feed or
// notifications through the normal API, so ordering and authorization stay there.
export type RealtimeMessage = { type: 'changes' | 'notification' };
export interface RealtimeGateway {
  /** Resolves false when the connection no longer exists. */
  send(connectionId: string, message: RealtimeMessage): Promise<boolean>;
}
type Ticket = { userId: string; deviceId: string; expiresAt: number };
type Connection = { connectionId: string; deviceId: string; expiresAt: number };
export type Interest =
  { userId: string; type: RealtimeMessage['type'] } | { ownerId: string; folderId: string };

const TICKET_SECONDS = 60;
// API Gateway closes every connection after 2 hours; rows outlive that and expire by TTL.
const CONNECTION_SECONDS = 3 * 3600;
const userPK = (id: string) => `USER#${id}`;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const seconds = () => Math.floor(Date.now() / 1000);

/** Which users a committed row should wake. Shared by the DynamoDB stream and local dev. */
export function interests(keys: Key[]): Interest[] {
  const out: Interest[] = [];
  for (const { pk, sk } of keys) {
    if (!pk.startsWith('USER#')) continue;
    const userId = pk.slice('USER#'.length);
    if (sk.startsWith('CHANGE#') || sk.startsWith('ACCESS#')) out.push({ userId, type: 'changes' });
    else if (sk.startsWith('NOTIFICATION#')) out.push({ userId, type: 'notification' });
    // Shared sync folders are recorded in the owner's feed; recipients follow a revision.
    else if (sk.startsWith('SYNCFOLDERREV#'))
      out.push({ ownerId: userId, folderId: sk.slice('SYNCFOLDERREV#'.length) });
  }
  return out;
}

export class Realtime {
  constructor(
    private repo: Repository,
    private url: string,
    private gateway?: RealtimeGateway,
  ) {}
  /** A single-use ticket, so browsers (which cannot send headers) can authenticate the socket. */
  async ticket(userId: string, deviceId: string) {
    const ticket = randomBytes(32).toString('base64url');
    const expiresAt = seconds() + TICKET_SECONDS;
    await transact(this.repo, (tx) =>
      tx.put('RTTICKET', digest(ticket), { userId, deviceId, expiresAt }, { expiresAt }),
    );
    return { url: this.url, ticket, expiresAt: new Date(expiresAt * 1000).toISOString() };
  }
  async connect(connectionId: string, ticket: string | undefined) {
    assert(ticket, 'AUTH_REQUIRED', 'A realtime ticket is required.', 401);
    return transact(this.repo, async (tx) => {
      const key = digest(ticket);
      const found = await tx.get<Ticket>('RTTICKET', key);
      // TTL deletion is lazy, so expiry is checked here as well.
      assert(found && found.expiresAt > seconds(), 'AUTH_INVALID', 'Realtime ticket expired.', 401);
      await tx.delete('RTTICKET', key);
      const expiresAt = seconds() + CONNECTION_SECONDS;
      await tx.put(
        userPK(found.userId),
        `RTCONN#${connectionId}`,
        { connectionId, deviceId: found.deviceId, expiresAt } satisfies Connection,
        { expiresAt },
      );
      await tx.put('RTCONN', connectionId, { userId: found.userId }, { expiresAt });
      return { userId: found.userId };
    });
  }
  async disconnect(connectionId: string) {
    await transact(this.repo, async (tx) => {
      const found = await tx.get<{ userId: string }>('RTCONN', connectionId);
      if (!found) return;
      await tx.delete('RTCONN', connectionId);
      await tx.delete(userPK(found.userId), `RTCONN#${connectionId}`);
    });
  }
  async publish(keys: Key[]) {
    const targets = new Map<string, Set<RealtimeMessage['type']>>();
    const add = (userId: string, type: RealtimeMessage['type']) =>
      targets.set(userId, (targets.get(userId) ?? new Set()).add(type));
    const shares = new Map<string, Promise<ShareGrant[]>>();
    for (const interest of interests(keys)) {
      if ('userId' in interest) {
        add(interest.userId, interest.type);
        continue;
      }
      if (!shares.has(interest.ownerId))
        shares.set(
          interest.ownerId,
          new Transaction(this.repo).list<ShareGrant>(userPK(interest.ownerId), 'SHARE#'),
        );
      for (const share of await shares.get(interest.ownerId)!)
        if (
          share.driveItemId === interest.folderId &&
          share.syncState === 'ACCEPTED' &&
          !share.revokedAt &&
          share.recipientUserId
        )
          add(share.recipientUserId, 'changes');
    }
    await Promise.all([...targets].map(([userId, types]) => this.deliver(userId, types)));
    return targets.size;
  }
  private async deliver(userId: string, types: Set<RealtimeMessage['type']>) {
    const gateway = this.gateway;
    assert(gateway, 'INTERNAL_ERROR', 'Realtime delivery is not configured.', 500);
    const connections = await new Transaction(this.repo).list<Connection>(
      userPK(userId),
      'RTCONN#',
    );
    await Promise.all(
      connections
        .filter((connection) => connection.expiresAt > seconds())
        .flatMap((connection) =>
          [...types].map(async (type) => {
            try {
              if (!(await gateway.send(connection.connectionId, { type })))
                await this.disconnect(connection.connectionId);
            } catch (error) {
              // Delivery is best effort; clients still poll as a fallback.
              console.error(
                JSON.stringify({
                  event: 'realtime_send_failed',
                  errorType: (error as Error).name,
                }),
              );
            }
          }),
        ),
    );
  }
}
