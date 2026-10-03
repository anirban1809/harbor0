// Forgets every account's signed-in devices so each registers again at its next sign-in.
// Dry run by default; pass --apply to write. Deploy the backend first: backups must already be
// matched by installation, or the computers that own them can't run them afterwards.
//   npx tsx --env-file=.env.cloud scripts/reset-devices.ts [--apply]
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoRepository } from '../apps/backend/src/repository';
import { resetDevices } from '../apps/backend/src/device-reset';
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

const repo = new DynamoRepository(table, endpoint);
const total = { accounts: 0, devices: 0, pushes: 0, backups: 0 };
for (const id of users) {
  const counts = await resetDevices(repo, id, apply);
  if (!counts.devices && !counts.pushes && !counts.backups) continue;
  total.accounts++;
  total.devices += counts.devices;
  total.pushes += counts.pushes;
  total.backups += counts.backups;
}
console.log(
  `${apply ? 'Reset' : 'Would reset'} ${total.devices} device sign-ins and ${total.pushes} push ` +
    `registrations across ${total.accounts} of ${users.length} accounts in ${table}; ` +
    `${total.backups} backups ${apply ? 'now' : 'would be'} tied to their installation.`,
);
if (!apply) console.log('Dry run. Pass --apply to write.');
