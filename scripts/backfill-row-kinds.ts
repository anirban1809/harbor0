// Gives rows written before the `kinds` index their kind (see rowKind), then records that the
// index is complete so the console stops scanning the table. Run after the index is ACTIVE.
// Dry run by default; pass --apply to write. Safe to run again.
//   npx tsx --env-file=.env.cloud scripts/backfill-row-kinds.ts [--apply]
import { DescribeTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { KINDS_INDEXED, rowKind } from '../apps/backend/src/repository';
import { readOutputs } from '../infra/environment';

const apply = process.argv.includes('--apply');
const table = process.env.TABLE_NAME ?? (await readOutputs('storage')).TableName;
const endpoint = process.env.DYNAMODB_ENDPOINT;
const client = new DynamoDBClient({ endpoint });
const db = DynamoDBDocumentClient.from(client);

const { Table } = await client.send(new DescribeTableCommand({ TableName: table }));
const index = Table?.GlobalSecondaryIndexes?.find((i) => i.IndexName === 'kinds');
if (index?.IndexStatus !== 'ACTIVE') {
  console.error(`The kinds index on ${table} is ${index?.IndexStatus ?? 'missing'}; deploy it first.`);
  process.exit(1);
}

const counts: Record<string, number> = {};
let missing = 0;
let start: Record<string, unknown> | undefined;
do {
  const page = await db.send(
    new ScanCommand({
      TableName: table,
      ProjectionExpression: 'pk, sk, kind',
      FilterExpression: 'sk = :p OR begins_with(sk, :d) OR begins_with(sk, :s) OR begins_with(sk, :b)',
      ExpressionAttributeValues: { ':p': 'PROFILE', ':d': 'DEVICE#', ':s': 'SYNCFOLDERS#', ':b': 'BACKUP#' },
      ExclusiveStartKey: start,
    }),
  );
  for (const row of page.Items ?? []) {
    const kind = rowKind(row.sk);
    if (!kind) continue;
    counts[kind] = (counts[kind] ?? 0) + 1;
    if (row.kind === kind) continue;
    missing++;
    if (!apply) continue;
    try {
      // The version stays: kind is derived from the key, so no concurrent writer can disagree.
      await db.send(
        new UpdateCommand({
          TableName: table,
          Key: { pk: row.pk, sk: row.sk },
          UpdateExpression: 'SET #k = :k',
          ConditionExpression: 'attribute_exists(pk)',
          ExpressionAttributeNames: { '#k': 'kind' },
          ExpressionAttributeValues: { ':k': kind },
        }),
      );
    } catch (error) {
      // Deleted since the scan read it; nothing to file.
      if ((error as { name: string }).name !== 'ConditionalCheckFailedException') throw error;
    }
  }
  start = page.LastEvaluatedKey;
} while (start);

console.log(`${table}: ${JSON.stringify(counts)}; ${missing} without a kind`);
if (apply) {
  await db.send(
    new PutCommand({
      TableName: table,
      Item: { ...KINDS_INDEXED, v: 1, data: { completedAt: new Date().toISOString() } },
    }),
  );
  console.log('Filed them and marked the index complete; the console reads it from now on.');
} else console.log('Dry run; pass --apply to write.');
