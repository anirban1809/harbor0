// Fills the sign-up limits for accounts made before them: each inbox's EMAIL_CANON claim (the
// earliest account holds it, then the earliest beta request) and each proved device key's list
// of accounts. Dry run by default; pass --apply to write. Safe to run again.
//   npx tsx --env-file=.env.cloud scripts/backfill-signup-guards.ts [--apply]
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { canonicalEmail } from '../packages/contracts/src/index';
import { DynamoRepository, transact } from '../apps/backend/src/repository';
import { inboxClaim, putInboxClaim, recordDeviceAccount } from '../apps/backend/src/signup-guard';
import { readOutputs } from '../infra/environment';

const apply = process.argv.includes('--apply');
const table = process.env.TABLE_NAME ?? (await readOutputs('storage')).TableName;
const endpoint = process.env.DYNAMODB_ENDPOINT;
const db = DynamoDBDocumentClient.from(new DynamoDBClient({ endpoint }));
const repo = new DynamoRepository(table, endpoint);

type Row = { pk: string; sk: string; data: Record<string, unknown> };
async function scan(filter: string, values: Record<string, string>) {
  const rows: Row[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const page = await db.send(
      new ScanCommand({
        TableName: table,
        FilterExpression: filter,
        ExpressionAttributeValues: values,
        ExclusiveStartKey: start,
      }),
    );
    rows.push(...((page.Items ?? []) as Row[]));
    start = page.LastEvaluatedKey;
  } while (start);
  return rows;
}

const profiles = (await scan('sk = :p AND begins_with(pk, :u)', { ':p': 'PROFILE', ':u': 'USER#' }))
  .map((r) => r.data as { id: string; email: string; createdAt: string; deletedAt?: string })
  .filter((p) => p.id && p.email);
const live = profiles.filter((p) => !p.deletedAt).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
const entries = (await scan('pk = :b', { ':b': 'BETA_EMAIL' }))
  .map((r) => r.data as { email: string; requestedAt: string })
  .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
const keys = await scan('begins_with(pk, :u) AND begins_with(sk, :k)', {
  ':u': 'USER#',
  ':k': 'DEVICE_KEY#',
});

const claimed = new Map<string, string>();
const shared: string[] = [];
let inboxes = 0;
for (const claim of [
  ...live.map((p) => ({ email: p.email, userId: p.id })),
  ...entries.map((e) => ({ email: e.email })),
]) {
  const canon = canonicalEmail(claim.email);
  const holder = claimed.get(canon);
  if (holder) {
    if (holder !== claim.email && 'userId' in claim) shared.push(`${claim.email} (inbox held by ${holder})`);
    continue;
  }
  claimed.set(canon, claim.email);
  if (!apply) {
    inboxes++;
    continue;
  }
  const wrote = await transact(repo, async (tx) => {
    if (await inboxClaim(tx, claim.email)) return false;
    await putInboxClaim(tx, claim);
    return true;
  });
  if (wrote) inboxes++;
}

const email = new Map(profiles.map((p) => [p.id, p.email]));
const perKey = new Map<string, string[]>();
for (const row of keys) {
  const userId = row.pk.slice('USER#'.length);
  const fingerprint = row.data.fingerprint as string | undefined;
  const address = email.get(userId);
  if (!fingerprint || !address) continue;
  perKey.set(fingerprint, [...(perKey.get(fingerprint) ?? []), address]);
  if (apply)
    await transact(repo, (tx) => recordDeviceAccount(tx, fingerprint, { userId, email: address }));
}

console.log(`${apply ? 'Claimed' : 'Would claim'} ${inboxes} inboxes in ${table}.`);
console.log(`${shared.length} existing accounts share an inbox with an earlier one:`);
for (const s of shared) console.log(`  ${s}`);
const crowded = [...perKey.entries()].filter(([, accounts]) => new Set(accounts).size > 1);
console.log(`${keys.length} device keys; ${crowded.length} used by more than one account:`);
for (const [fp, accounts] of crowded)
  console.log(`  ${fp.slice(0, 10)}…: ${[...new Set(accounts)].join(', ')}`);
if (!apply) console.log('Dry run. Pass --apply to write.');
