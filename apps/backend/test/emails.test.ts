import { expect, it } from 'vitest';
import type { CustomMessageTriggerEvent } from 'aws-lambda';
import { composeEmail, customMessage } from '../src/emails';

function event(
  triggerSource: CustomMessageTriggerEvent['triggerSource'],
  userAttributes: Record<string, string> = {},
) {
  return {
    triggerSource,
    request: { userAttributes, codeParameter: '{####}', usernameParameter: '{username}' },
    response: { smsMessage: null, emailMessage: null, emailSubject: null },
  } as unknown as CustomMessageTriggerEvent;
}

it('brands every code email and keeps the code placeholder for Cognito to fill', async () => {
  for (const source of [
    'CustomMessage_SignUp',
    'CustomMessage_ResendCode',
    'CustomMessage_ForgotPassword',
    'CustomMessage_UpdateUserAttribute',
    'CustomMessage_VerifyUserAttribute',
    'CustomMessage_Authentication',
  ] as const) {
    const { response } = await customMessage(event(source));
    expect(response.emailSubject).toMatch(/harbor0/);
    expect(response.emailMessage).toContain('{####}');
    expect(response.emailMessage).toContain('https://harbor0.com/icon.png');
  }
});

it('includes the username and temporary password in staff invitations', async () => {
  process.env.SIGN_IN_URL = 'https://admin.harbor0.com';
  const { response } = await customMessage(event('CustomMessage_AdminCreateUser'));
  delete process.env.SIGN_IN_URL;
  expect(response.emailMessage).toContain('{username}');
  expect(response.emailMessage).toContain('{####}');
  expect(response.emailMessage).toContain('href="https://admin.harbor0.com"');
});

it('escapes names users chose themselves', async () => {
  const { response } = await customMessage(
    event('CustomMessage_SignUp', { preferred_username: '<b>x</b>' }),
  );
  expect(response.emailMessage).toContain('Hi &lt;b&gt;x&lt;/b&gt;,');
});

it('renders file invitations with an escaped sender, a sign-up link and a plain-text part', () => {
  const email = composeEmail(
    { template: 'INVITE', to: 'a@example.test', sender: '<Sam & Co>' },
    'https://app.harbor0.com',
  );
  expect(email.html).toContain('&lt;Sam &amp; Co&gt;');
  expect(email.html).not.toContain('<Sam');
  expect(email.html).toContain('href="https://app.harbor0.com/signup"');
  expect(email.html).not.toContain('{####}');
  expect(email.text).toContain('<Sam & Co> sent you files');
});

it('welcomes new accounts with their storage and a link to the app', () => {
  const email = composeEmail(
    { template: 'WELCOME', to: 'a@example.test', name: 'Ada', quotaBytes: 50_000_000_000 },
    'https://app.harbor0.com',
  );
  expect(email.subject).toBe('Welcome to harbor0');
  expect(email.html).toContain('Welcome to harbor0, Ada');
  expect(email.html).toContain('50 GB of storage');
  expect(email.html).toContain('href="https://app.harbor0.com"');
  expect(email.text).toContain('50 GB of storage');
});

it('tells deleted accounts when their files are erased', () => {
  const email = composeEmail(
    {
      template: 'ACCOUNT_DELETED',
      to: 'a@example.test',
      name: 'Ada',
      purgeAt: '2026-11-02T10:00:00.000Z',
    },
    'https://app.harbor0.com',
  );
  expect(email.subject).toBe('Your harbor0 account was deleted');
  expect(email.html).toContain('November 2, 2026');
  expect(email.text).toContain('November 2, 2026');
  expect(email.html).toContain('mailto:contact@harbor0.com');
  expect(email.text).toContain("If you didn't delete your account, write to contact@harbor0.com");
});
