import { afterEach, expect, it, vi } from 'vitest';
import { CognitoAuth } from '../src/auth';

afterEach(() => vi.useRealTimers());

function cognito(attributes: Record<string, string>) {
  const auth = new CognitoAuth('us-east-1_pool', 'client');
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const verify = vi.fn(async () => ({ sub: 'user', origin_jti: 'device', exp }));
  const send = vi.fn(async () => ({
    UserAttributes: Object.entries(attributes).map(([Name, Value]) => ({ Name, Value })),
  }));
  Object.assign(auth, { verifier: { verify }, client: { send } });
  return { auth, verify, send };
}

it('reuses the Cognito profile briefly but verifies the token on every request', async () => {
  vi.useFakeTimers();
  const { auth, verify, send } = cognito({ email: 'a@example.test', email_verified: 'true' });
  const first = await auth.identity('token');
  expect(await auth.identity('token')).toEqual(first);
  expect(verify).toHaveBeenCalledTimes(2);
  expect(send).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(61_000);
  await auth.identity('token');
  expect(send).toHaveBeenCalledTimes(2);
});

it('never caches an unverified account or a token that fails verification', async () => {
  const { auth, verify, send } = cognito({ email: 'a@example.test', email_verified: 'false' });
  await auth.identity('token');
  await auth.identity('token');
  expect(send).toHaveBeenCalledTimes(2);
  verify.mockRejectedValueOnce(new Error('expired'));
  await expect(auth.identity('token')).rejects.toMatchObject({ code: 'AUTH_INVALID' });
});
