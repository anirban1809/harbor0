import type { PreSignUpTriggerEvent } from 'aws-lambda';
import { BETA, username, normalizeEmail } from '@harbor/contracts';
import { DynamoRepository, transact } from './repository';
import { assert } from './errors';
import { Beta } from './beta';
export async function preSignup(event: PreSignUpTriggerEvent) {
  const name = username.parse(event.request.userAttributes.preferred_username);
  const email = normalizeEmail(event.request.userAttributes.email ?? '');
  assert(email, 'VALIDATION_ERROR', 'Email is required.');
  const repo = new DynamoRepository(process.env.TABLE_NAME!);
  // Every sign-up passes here, including ones made straight against Cognito, so the beta's
  // seat limit holds even for clients that skip the API.
  await new Beta(repo, BETA).claim(email, event.request.clientMetadata?.inviteCode);
  await transact(repo, async (tx) => {
    const existing = await tx.get<{ userId?: string; email?: string; reservedUntil?: number }>(
      'USERNAME',
      name,
    );
    assert(
      !existing ||
        existing.email === email ||
        (!existing.userId && (existing.reservedUntil ?? Infinity) < Date.now()),
      'USERNAME_TAKEN',
      'This username is taken.',
      409,
    );
    if (!existing?.userId)
      await tx.put(
        'USERNAME',
        name,
        { email, reservedUntil: Date.now() + 7 * 86400_000 },
        { expiresAt: Math.floor(Date.now() / 1000) + 7 * 86400 },
      );
  });
  return event;
}
