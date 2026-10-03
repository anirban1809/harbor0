import { randomUUID } from 'node:crypto';
import {
  AdminDeleteUserCommand,
  type CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';

/**
 * Removes a live-validation account the way a person deleting their account would: the API
 * tombstones the profile, releases the username and email, schedules the purge and deletes the
 * Cognito user. Deleting only the Cognito user would leave the profile behind, still counted in
 * the console's storage totals with its full storage limit.
 *
 * Falls back to deleting the Cognito user alone when the account cannot sign in (an unverified
 * fixture never had a profile, so nothing is left behind).
 */
export async function removeFixtureAccount(
  cognito: CognitoIdentityProviderClient,
  target: { apiUrl: string; userPoolId: string; email: string; password: string },
) {
  const call = async (path: string, body: unknown, token?: string) => {
    const response = await fetch(target.apiUrl + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error?.code ?? `HTTP ${response.status}`);
    return data;
  };
  try {
    const session = await call('/v1/auth/login', {
      email: target.email,
      password: target.password,
      deviceName: 'Fixture cleanup',
      platform: 'WEB',
    });
    await call(
      '/v1/users/me/delete',
      { operationId: randomUUID(), email: target.email },
      session.accessToken,
    );
    return 'deleted';
  } catch {
    try {
      await cognito.send(
        new AdminDeleteUserCommand({ UserPoolId: target.userPoolId, Username: target.email }),
      );
    } catch (error) {
      if ((error as { name?: string }).name !== 'UserNotFoundException') throw error;
    }
    return 'sign-in removed';
  }
}
