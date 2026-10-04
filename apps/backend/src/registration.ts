import type { PostConfirmationTriggerEvent, PreSignUpTriggerEvent } from 'aws-lambda';
import { BETA, username, normalizeEmail } from '@harbor/contracts';
import { DynamoRepository, transact, Transaction } from './repository';
import { queueEmail, userPK, type Account } from './domain';
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

/** Cognito runs this after a password reset by any route, including its hosted pages. */
export async function postConfirmation(event: PostConfirmationTriggerEvent) {
  if (event.triggerSource !== 'PostConfirmation_ConfirmForgotPassword') return event;
  const attributes = event.request.userAttributes;
  const email = normalizeEmail(attributes.email ?? '');
  if (!email) return event;
  // The new password is already set, so a failure here must not fail the reset.
  try {
    const repo = new DynamoRepository(process.env.TABLE_NAME!);
    const account = await new Transaction(repo).get<Account>(userPK(attributes.sub), 'PROFILE');
    const at = new Date().toISOString();
    await transact(repo, (tx) =>
      queueEmail(tx, `password-${attributes.sub}-${at}`, {
        template: 'PASSWORD_CHANGED',
        to: email,
        name: account?.displayName || attributes.name || attributes.preferred_username,
        at,
      }),
    );
  } catch (error) {
    console.error(JSON.stringify({ event: 'password_notice_failed', error: String(error) }));
  }
  return event;
}
