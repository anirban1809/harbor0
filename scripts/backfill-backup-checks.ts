// Gives backup folders created before stale-backup reminders their first check, so a folder that
// already stopped backing up is still reported. Dry run by default; pass --apply to write.
// Deploy the backend first.
//   npx tsx --env-file=.env.cloud scripts/backfill-backup-checks.ts [--apply]
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoRepository } from '../apps/backend/src/repository';
import { StorageService } from '../apps/backend/src/domain';
import { MemoryStorage } from '../apps/backend/src/storage';
import { Backups } from '../apps/backend/src/backups';
import { readOutputs } from '../infra/environment';

const apply = process.argv.includes('--apply');
const table = process.env.TABLE_NAME ?? (await readOutputs('storage')).TableName;
// DYNAMODB_ENDPOINT points at DynamoDB Local when run with --env-file=.env.
const endpoint = process.env.DYNAMODB_ENDPOINT;
const db = DynamoDBDocumentClient.from(new DynamoDBClient({ endpoint }));
const users: string[] = [];
let start: Record<string, unknown> | undefined;
do {
  const page = await db.send(
    new ScanCommand({
      TableName: table,
      FilterExpression: 'sk = :profile AND begins_with(pk, :user)',
      ExpressionAttributeValues: { ':profile': 'PROFILE', ':user': 'USER#' },
      ProjectionExpression: 'pk',
      ExclusiveStartKey: start,
    }),
  );
  for (const row of page.Items ?? []) users.push(String(row.pk).slice('USER#'.length));
  start = page.LastEvaluatedKey;
} while (start);

// Only metadata is written, so no object storage is needed.
const backups = new Backups(
  new StorageService(new DynamoRepository(table, endpoint), new MemoryStorage()),
);
let folders = 0;
let accounts = 0;
for (const id of users) {
  const count = await backups.backfillChecks(id, apply);
  if (!count) continue;
  folders += count;
  accounts++;
}
console.log(
  `${apply ? 'Armed' : 'Would arm'} stale-backup checks for ${folders} folders across ` +
    `${accounts} of ${users.length} accounts in ${table}.`,
);
if (!apply) console.log('Dry run. Pass --apply to write.');
