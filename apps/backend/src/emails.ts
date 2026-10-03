import type { CustomMessageTriggerEvent } from 'aws-lambda';

// Cognito swaps these placeholders for the real values after the trigger returns, so they
// must reach the message verbatim.
const CODE = '{####}';
const USERNAME = '{username}';
const site = 'https://harbor0.com';

type Message = {
  subject: string;
  preheader: string;
  heading: string;
  intro: string;
  code?: string;
  details?: [label: string, value: string][];
  action?: { label: string; url: string };
  footnote: string;
};

const escape = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  );

const font = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const mono = "'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace";

// Table layout with inline styles: the subset every mail client renders the same way.
export function renderEmail(message: Message) {
  const details = (message.details ?? [])
    .map(
      ([label, value]) =>
        `<tr><td style="padding:4px 0;color:#5d6270;font-size:13px;width:120px;">${label}</td><td style="padding:4px 0;color:#16181d;font-size:14px;font-family:${mono};">${value}</td></tr>`,
    )
    .join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${message.subject}</title>
</head>
<body style="margin:0;padding:0;background:#f4f5f7;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${message.preheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f5f7;">
<tr><td align="center" style="padding:40px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;font-family:${font};">
<tr><td style="padding:0 4px 20px;">
<a href="${site}" style="text-decoration:none;color:#16181d;"><img src="${site}/icon.png" width="28" height="28" alt="" style="vertical-align:middle;border:0;"><span style="vertical-align:middle;margin-left:8px;font-size:19px;font-weight:650;letter-spacing:-0.02em;color:#16181d;">harbor0</span></a>
</td></tr>
<tr><td style="background:#ffffff;border:1px solid #e3e5ea;border-radius:12px;padding:32px;">
<h1 style="margin:0 0 12px;font-size:22px;line-height:1.3;font-weight:650;letter-spacing:-0.01em;color:#16181d;">${message.heading}</h1>
<p style="margin:0 0 24px;font-size:15px;line-height:1.55;color:#3d414b;">${message.intro}</p>
${details ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 12px;">${details}</table>` : ''}
${message.code ? `<div style="margin:0 0 24px;padding:18px;background:#f0f2fe;border-radius:8px;text-align:center;font-family:${mono};font-size:28px;font-weight:600;letter-spacing:0.18em;color:#2b38a6;">${message.code}</div>` : ''}
${
  message.action
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px;"><tr><td style="background:#4353d9;border-radius:8px;"><a href="${message.action.url}" style="display:inline-block;padding:12px 22px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;">${message.action.label}</a></td></tr></table>`
    : ''
}
<p style="margin:0;font-size:13px;line-height:1.55;color:#5d6270;">${message.footnote}</p>
</td></tr>
<tr><td style="padding:20px 4px 0;font-size:12px;line-height:1.5;color:#8a8f9c;">
harbor0 · File storage, backup, sync, and sharing.<br>
This is an automated message from <a href="${site}" style="color:#8a8f9c;">harbor0.com</a>; replies aren't read.
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

// Sent by the maintenance job when someone sends files to an address without an account.
export function invitationEmail(sender: string, webOrigin: string) {
  const subject = 'A file is waiting for you in harbor0';
  return {
    subject,
    html: renderEmail({
      subject,
      preheader: `${escape(sender)} sent you files in harbor0.`,
      heading: 'You have files waiting',
      intro: `<strong style="color:#16181d;">${escape(sender)}</strong> sent you files in harbor0. Create an account with this email address and verify it to receive them.`,
      action: { label: 'Create your account', url: escape(`${webOrigin}/signup`) },
      footnote:
        'Invitations expire after 30 days. Files are never available through public links, only in the account that owns this email address.',
    }),
    text: `${sender} sent you files in harbor0. Create an account with this email address and verify it to receive them. Sign in at ${webOrigin}. Invitations expire after 30 days. Files are never available through public links.`,
  };
}

function message(event: CustomMessageTriggerEvent): Message | undefined {
  const attributes = event.request.userAttributes;
  const name = attributes.name || attributes.preferred_username;
  const greet = (sentence: string) =>
    name ? `Hi ${escape(name)}, ${sentence}` : sentence[0].toUpperCase() + sentence.slice(1);
  const signIn = process.env.SIGN_IN_URL || undefined;
  switch (event.triggerSource) {
    case 'CustomMessage_SignUp':
    case 'CustomMessage_ResendCode':
      return {
        subject: 'Your harbor0 verification code',
        preheader: 'Enter this code to finish creating your harbor0 account.',
        heading: 'Verify your email',
        intro: greet('enter this code to finish creating your harbor0 account.'),
        code: CODE,
        footnote:
          "The code expires in 24 hours. If you didn't create a harbor0 account, you can ignore this email.",
      };
    case 'CustomMessage_ForgotPassword':
      return {
        subject: 'Reset your harbor0 password',
        preheader: 'Use this code to choose a new password.',
        heading: 'Reset your password',
        intro: greet(
          'someone asked to reset the password for your harbor0 account. Use this code to choose a new one.',
        ),
        code: CODE,
        footnote:
          "The code expires in 1 hour. If you didn't ask for this, ignore this email — your password stays the same.",
      };
    case 'CustomMessage_UpdateUserAttribute':
    case 'CustomMessage_VerifyUserAttribute':
      return {
        subject: 'Confirm your harbor0 email address',
        preheader: 'Enter this code to confirm your email address.',
        heading: 'Confirm your email address',
        intro: greet('enter this code in harbor0 to confirm this email address.'),
        code: CODE,
        footnote: "If you didn't request this, you can ignore this email.",
      };
    case 'CustomMessage_Authentication':
      return {
        subject: 'Your harbor0 sign-in code',
        preheader: 'Enter this code to finish signing in.',
        heading: 'Finish signing in',
        intro: greet('enter this code to finish signing in to harbor0.'),
        code: CODE,
        footnote:
          "If you aren't signing in right now, someone may know your password — change it as soon as you can.",
      };
    case 'CustomMessage_AdminCreateUser':
      return {
        subject: 'Your harbor0 console account',
        preheader: 'An administrator added you to the harbor0 management console.',
        heading: 'Welcome to the harbor0 console',
        intro: greet(
          'an administrator added you to the harbor0 management console. Sign in with your email and this temporary password, then set your own password and add an authenticator app.',
        ),
        details: [['Email', USERNAME]],
        code: CODE,
        action: signIn ? { label: 'Open the console', url: escape(signIn) } : undefined,
        footnote:
          'The temporary password expires in 3 days. After that, ask an administrator to send a new one.',
      };
  }
}

export async function customMessage(event: CustomMessageTriggerEvent) {
  const content = message(event);
  if (content) {
    event.response.emailSubject = content.subject;
    event.response.emailMessage = renderEmail(content);
  }
  return event;
}
