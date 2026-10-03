import { expect, it } from 'vitest';
import type { CustomMessageTriggerEvent } from 'aws-lambda';
import { customMessage, invitationEmail } from '../src/emails';

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
  const email = invitationEmail('<Sam & Co>', 'https://app.harbor0.com');
  expect(email.html).toContain('&lt;Sam &amp; Co&gt;');
  expect(email.html).not.toContain('<Sam');
  expect(email.html).toContain('href="https://app.harbor0.com/signup"');
  expect(email.html).not.toContain('{####}');
  expect(email.text).toContain('<Sam & Co> sent you files');
});
