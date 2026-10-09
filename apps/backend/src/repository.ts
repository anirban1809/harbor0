import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { DomainError, RetryTransaction } from './errors';
export type Row = {
  pk: string;
  sk: string;
  v: number;
  data: unknown;
  expiresAt?: number;
  gpk?: string;
  gsk?: string;
};
export type Key = { pk: string; sk: string };
export type Write = { key: Key; expected: number | null; row?: Row };
export type Page = { rows: Row[]; cursor: string | null };
export interface Repository {
  get(key: Key): Promise<Row | undefined>;
  /** `descending` reads the highest sort keys first; `after` applies to ascending reads only. */
  query(
    pk: string,
    prefix: string,
    limit?: number,
    cursor?: string,
    after?: string,
    descending?: boolean,
  ): Promise<Page>;
  commit(writes: Write[], checks: Write[]): Promise<void>;
  /** Atomically counts one more use of `key` unless it already has `max`; false when full. */
  increment(key: Key, max: number, expiresAt: number): Promise<boolean>;
  due(now: string, cursor?: string): Promise<Page>;
  /** Every account PROFILE's storage fields; a full-table read, so callers cache the result. */
  scanProfiles(): Promise<ProfileStorage[]>;
  /** Every device session's account, platform and name; a full-table read like scanProfiles. */
  scanDevices(): Promise<DeviceSighting[]>;
}
export type DeviceSighting = {
  userId?: string;
  platform?: string;
  name?: string;
  lastSeenAt?: string;
};
export type ProfileStorage = {
  id?: string;
  storageUsedBytes?: number;
  storageQuotaBytes?: number;
  storageReservedBytes?: number;
  trashBytes?: number;
  purgingBytes?: number;
  deletedAt?: string;
  purgeAt?: string;
  email?: string;
  username?: string;
  displayName?: string;
  createdAt?: string;
  suspendedAt?: string;
  freeQuotaBytes?: number;
};
const PROFILE_FIELDS = [
  'id',
  'storageUsedBytes',
  'storageQuotaBytes',
  'storageReservedBytes',
  'trashBytes',
  'purgingBytes',
  'deletedAt',
  'purgeAt',
  'email',
  'username',
  'displayName',
  'createdAt',
  'suspendedAt',
  'freeQuotaBytes',
] as const;
const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
/** A cursor that resumes a query just after this row. */
export const rowCursor = (row: Row) => encode({ pk: row.pk, sk: row.sk });
function decode(cursor: string): Key {
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString());
  } catch {
    throw new DomainError('VALIDATION_ERROR', 'Invalid pagination cursor.');
  }
}
export class DynamoRepository implements Repository {
  private db: DynamoDBDocumentClient;
  constructor(
    private table: string,
    endpoint?: string,
  ) {
    this.db = DynamoDBDocumentClient.from(new DynamoDBClient({ endpoint }), {
      marshallOptions: { removeUndefinedValues: true },
    });
  }
  async get(key: Key) {
    return (
      await this.db.send(new GetCommand({ TableName: this.table, Key: key, ConsistentRead: true }))
    ).Item as Row | undefined;
  }
  async query(
    pk: string,
    prefix: string,
    limit = 100,
    cursor?: string,
    after?: string,
    descending = false,
  ): Promise<Page> {
    const start = cursor ? decode(cursor) : undefined;
    if (start && (start.pk !== pk || !start.sk.startsWith(prefix)))
      throw new DomainError('VALIDATION_ERROR', 'Cursor does not match this collection.');
    const result = await this.db.send(
      new QueryCommand({
        TableName: this.table,
        ConsistentRead: true,
        KeyConditionExpression: after
          ? 'pk = :pk AND sk BETWEEN :after AND :end'
          : prefix
            ? 'pk = :pk AND begins_with(sk, :prefix)'
            : 'pk = :pk',
        ExpressionAttributeValues: after
          ? { ':pk': pk, ':after': after + '\u0000', ':end': prefix + '\uffff' }
          : prefix
            ? { ':pk': pk, ':prefix': prefix }
            : { ':pk': pk },
        Limit: limit,
        ExclusiveStartKey: start,
        ScanIndexForward: !descending,
      }),
    );
    return {
      rows: (result.Items ?? []) as Row[],
      cursor: result.LastEvaluatedKey ? encode(result.LastEvaluatedKey) : null,
    };
  }
  async due(now: string, cursor?: string): Promise<Page> {
    const result = await this.db.send(
      new QueryCommand({
        TableName: this.table,
        IndexName: 'jobs',
        KeyConditionExpression: 'gpk = :job AND gsk <= :now',
        ExpressionAttributeValues: { ':job': 'JOB', ':now': now },
        Limit: 50,
        ExclusiveStartKey: cursor ? decode(cursor) : undefined,
      }),
    );
    return {
      rows: (result.Items ?? []) as Row[],
      cursor: result.LastEvaluatedKey ? encode(result.LastEvaluatedKey) : null,
    };
  }
  async commit(writes: Write[], checks: Write[]) {
    const all = [...writes, ...checks];
    if (all.length > 100)
      throw new DomainError(
        'OPERATION_TOO_LARGE',
        'This operation exceeds the atomic metadata batch size. Use smaller batches.',
        413,
      );
    const condition = (w: Write) => ({
      ConditionExpression: w.expected === null ? 'attribute_not_exists(pk)' : 'v = :v',
      ...(w.expected === null ? {} : { ExpressionAttributeValues: { ':v': w.expected } }),
    });
    try {
      await this.db.send(
        new TransactWriteCommand({
          TransactItems: [
            ...writes.map((w) =>
              w.row
                ? { Put: { TableName: this.table, Item: w.row, ...condition(w) } }
                : { Delete: { TableName: this.table, Key: w.key, ...condition(w) } },
            ),
            ...checks.map((w) => ({
              ConditionCheck: { TableName: this.table, Key: w.key, ...condition(w) },
            })),
          ],
        }),
      );
    } catch (error) {
      const e = error as { name: string; CancellationReasons?: { Code: string }[] };
      if (
        (e.name === 'TransactionCanceledException' &&
          e.CancellationReasons?.some((r) =>
            ['ConditionalCheckFailed', 'TransactionConflict'].includes(r.Code),
          )) ||
        e.name === 'TransactionConflictException'
      )
        throw new RetryTransaction();
      throw error;
    }
  }
  async increment(key: Key, max: number, expiresAt: number) {
    // One plain conditional update: half the write cost of a transaction and no read first.
    try {
      await this.db.send(
        new UpdateCommand({
          TableName: this.table,
          Key: key,
          UpdateExpression: 'ADD #n :one SET expiresAt = :exp',
          ConditionExpression: 'attribute_not_exists(#n) OR #n < :max',
          ExpressionAttributeNames: { '#n': 'n' },
          ExpressionAttributeValues: { ':one': 1, ':max': max, ':exp': expiresAt },
        }),
      );
      return true;
    } catch (error) {
      if ((error as { name: string }).name === 'ConditionalCheckFailedException') return false;
      throw error;
    }
  }
  async scanProfiles() {
    return this.scanData<ProfileStorage>('sk = :sk', { ':sk': 'PROFILE' }, PROFILE_FIELDS);
  }
  async scanDevices() {
    return this.scanData<DeviceSighting>('begins_with(sk, :sk)', { ':sk': 'DEVICE#' }, [
      'userId',
      'platform',
      'name',
      'lastSeenAt',
    ]);
  }
  /** The chosen `data` fields of every row the filter keeps. */
  private async scanData<T>(
    filter: string,
    values: Record<string, unknown>,
    fields: readonly string[],
  ) {
    // Parallel segments keep a large table within the console Lambda's timeout.
    const segments = 4;
    const parts = await Promise.all(
      Array.from({ length: segments }, async (_, segment) => {
        const out: T[] = [];
        let start: Record<string, unknown> | undefined;
        do {
          const page = await this.db.send(
            new ScanCommand({
              TableName: this.table,
              Segment: segment,
              TotalSegments: segments,
              FilterExpression: filter,
              ProjectionExpression: fields.map((_, i) => `#d.#f${i}`).join(', '),
              ExpressionAttributeNames: {
                '#d': 'data',
                ...Object.fromEntries(fields.map((f, i) => [`#f${i}`, f])),
              },
              ExpressionAttributeValues: values,
              ExclusiveStartKey: start,
            }),
          );
          for (const item of page.Items ?? []) out.push((item.data ?? {}) as T);
          start = page.LastEvaluatedKey;
        } while (start);
        return out;
      }),
    );
    return parts.flat();
  }
  async scanForMaintenance(cursor?: string) {
    return this.db.send(
      new ScanCommand({
        TableName: this.table,
        Limit: 100,
        ExclusiveStartKey: cursor ? decode(cursor) : undefined,
      }),
    );
  }
}
export class MemoryRepository implements Repository {
  rows = new Map<string, Row>();
  async get(key: Key) {
    return structuredClone(this.rows.get(key.pk + '|' + key.sk));
  }
  async query(
    pk: string,
    prefix: string,
    limit = 100,
    cursor?: string,
    after?: string,
    descending = false,
  ): Promise<Page> {
    const start = cursor ? decode(cursor) : undefined;
    if (start && (start.pk !== pk || !start.sk.startsWith(prefix)))
      throw new DomainError('VALIDATION_ERROR', 'Invalid cursor.');
    const rows = [...this.rows.values()]
      .filter(
        (r) =>
          r.pk === pk &&
          r.sk.startsWith(prefix) &&
          (descending ? !start || r.sk < start.sk : r.sk > (start?.sk ?? after ?? '')),
      )
      .sort((a, b) => (descending ? -1 : 1) * a.sk.localeCompare(b.sk, 'en'));
    const selected = rows.slice(0, limit);
    return {
      rows: structuredClone(selected),
      cursor: rows.length > limit ? encode({ pk, sk: selected.at(-1)!.sk }) : null,
    };
  }
  async due(now: string): Promise<Page> {
    return {
      rows: structuredClone(
        [...this.rows.values()].filter((r) => r.gpk === 'JOB' && r.gsk! <= now).slice(0, 50),
      ),
      cursor: null,
    };
  }
  counters = new Map<string, number>();
  async increment(key: Key, max: number) {
    const k = key.pk + '|' + key.sk;
    const n = this.counters.get(k) ?? 0;
    if (n >= max) return false;
    this.counters.set(k, n + 1);
    return true;
  }
  async scanProfiles() {
    return [...this.rows.values()]
      .filter((r) => r.sk === 'PROFILE')
      .map((r) => structuredClone(r.data) as ProfileStorage);
  }
  async scanDevices() {
    return [...this.rows.values()]
      .filter((r) => r.sk.startsWith('DEVICE#'))
      .map((r) => {
        const { userId, platform, name, lastSeenAt } = r.data as DeviceSighting;
        return { userId, platform, name, lastSeenAt };
      });
  }
  async commit(writes: Write[], checks: Write[]) {
    if (writes.length + checks.length > 100)
      throw new DomainError('OPERATION_TOO_LARGE', 'Metadata batch too large.', 413);
    for (const w of [...writes, ...checks])
      if ((this.rows.get(w.key.pk + '|' + w.key.sk)?.v ?? null) !== w.expected)
        throw new RetryTransaction();
    for (const w of writes) {
      const key = w.key.pk + '|' + w.key.sk;
      if (w.row) this.rows.set(key, structuredClone(w.row));
      else this.rows.delete(key);
    }
  }
}
export class Transaction {
  private reads = new Map<string, Row | undefined>();
  private writes = new Map<string, Write>();
  constructor(public repo: Repository) {}
  async get<T>(pk: string, sk: string): Promise<T | undefined> {
    const key = pk + '|' + sk;
    if (this.writes.has(key))
      return structuredClone(this.writes.get(key)?.row?.data) as T | undefined;
    if (!this.reads.has(key)) this.reads.set(key, await this.repo.get({ pk, sk }));
    return structuredClone(this.reads.get(key)?.data) as T | undefined;
  }
  async put(
    pk: string,
    sk: string,
    data: unknown,
    extra: Partial<Pick<Row, 'expiresAt' | 'gpk' | 'gsk'>> = {},
  ) {
    await this.get(pk, sk);
    const expected = this.reads.get(pk + '|' + sk)?.v ?? null;
    this.writes.set(pk + '|' + sk, {
      key: { pk, sk },
      expected,
      row: { pk, sk, v: (expected ?? 0) + 1, data, ...extra },
    });
  }
  async delete(pk: string, sk: string) {
    await this.get(pk, sk);
    this.writes.set(pk + '|' + sk, {
      key: { pk, sk },
      expected: this.reads.get(pk + '|' + sk)?.v ?? null,
    });
  }
  async list<T>(pk: string, prefix: string): Promise<T[]> {
    let cursor: string | undefined;
    const out: T[] = [];
    do {
      const page = await this.repo.query(pk, prefix, 100, cursor);
      for (const row of page.rows) {
        const key = row.pk + '|' + row.sk;
        if (!this.reads.has(key)) this.reads.set(key, row);
        out.push(row.data as T);
      }
      cursor = page.cursor ?? undefined;
    } while (cursor);
    return out;
  }
  async commit() {
    if (!this.writes.size) return;
    const checks: Write[] = [];
    for (const [key, row] of this.reads) {
      if (!this.writes.has(key)) {
        const split = key.indexOf('|');
        checks.push({
          key: { pk: key.slice(0, split), sk: key.slice(split + 1) },
          expected: row?.v ?? null,
        });
      }
    }
    await this.repo.commit([...this.writes.values()], checks);
  }
}
export async function transact<T>(
  repo: Repository,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const tx = new Transaction(repo);
    try {
      const result = await fn(tx);
      await tx.commit();
      return result;
    } catch (error) {
      if (!(error instanceof RetryTransaction)) throw error;
      await new Promise((r) => setTimeout(r, Math.random() * Math.min(200, 5 * 2 ** attempt)));
    }
  }
  throw new DomainError(
    'CONCURRENT_UPDATE',
    'Another change is in progress. Retry with the same operation ID.',
    409,
  );
}
