/**
 * Creates a personal access token for an account in the local DynamoDB table, without signing in:
 * `npm run local:token -- you@example.com [READ]`. Accounts signed in through Cognito against the
 * local API can't get a development session, so this is how rclone is tried on them locally.
 */
import { AccessTokens } from '../apps/backend/src/access-tokens';
import { DynamoRepository } from '../apps/backend/src/repository';

const endpoint = process.env.DYNAMODB_ENDPOINT ?? '';
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(endpoint))
  throw new Error('This script only runs against a local DynamoDB (DYNAMODB_ENDPOINT).');
const [email, scope = 'FULL'] = process.argv.slice(2);
if (!email || !['FULL', 'READ'].includes(scope))
  throw new Error('Usage: npm run local:token -- <email> [FULL|READ]');
const repo = new DynamoRepository(process.env.TABLE_NAME ?? 'harbor-local', endpoint);
const claim = (await repo.get({ pk: 'EMAIL', sk: email.trim().toLowerCase() }))?.data as
  { userId: string } | undefined;
if (!claim) throw new Error(`No local account uses ${email}. Sign in to the local web app first.`);
const { token, item } = await new AccessTokens(repo).create(claim.userId, {
  name: 'Local rclone',
  scope: scope as 'FULL' | 'READ',
  expiresInDays: 30,
});
console.log(`Token ${item.id} for ${email} (${scope}, expires ${item.expiresAt}):`);
console.log(token);
