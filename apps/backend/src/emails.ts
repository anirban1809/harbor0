import type { CustomMessageTriggerEvent } from 'aws-lambda';
import { BETA_QUOTA } from '@harbor/contracts';
import type { StaffDeletionReason } from '../../../packages/contracts/src/admin';

// Cognito swaps these placeholders for the real values after the trigger returns, so they
// must reach the message verbatim.
const CODE = '{####}';
const USERNAME = '{username}';
const site = 'https://harbor0.com';
const contact = 'contact@harbor0.com';

type Message = {
    subject: string;
    preheader: string;
    heading: string;
    intro: string;
    code?: string;
    list?: [title: string, text: string][];
    details?: [label: string, value: string][];
    action?: { label: string; url: string; };
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
    const list = (message.list ?? [])
        .map(
            ([title, text]) =>
                `<tr><td style="padding:0 0 14px;"><div style="font-size:15px;font-weight:600;color:#16181d;">${title}</div><div style="font-size:14px;line-height:1.5;color:#5d6270;">${text}</div></td></tr>`,
        )
        .join('');
    const details = (message.details ?? [])
        .map(
            ([label, value]) =>
                `<tr><td style="padding:4px 0;color:#5d6270;font-size:13px;width:120px;">${label}</td><td style="padding:4px 0;color:#16181d;font-size:14px;">${value}</td></tr>`,
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
${list ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 10px;">${list}</table>` : ''}
${details ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 12px;">${details}</table>` : ''}
${message.code ? `<div style="margin:0 0 24px;padding:18px;background:#f0f2fe;border-radius:8px;text-align:center;font-family:${mono};font-size:28px;font-weight:600;letter-spacing:0.18em;color:#2b38a6;">${message.code}</div>` : ''}
${message.action
            ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px;"><tr><td style="background:#4353d9;border-radius:8px;"><a href="${message.action.url}" style="display:inline-block;padding:12px 22px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;">${message.action.label}</a></td></tr></table>`
            : ''
        }
<p style="margin:0;font-size:13px;line-height:1.55;color:#5d6270;">${message.footnote}</p>
</td></tr>
<tr><td style="padding:20px 4px 0;font-size:12px;line-height:1.5;color:#8a8f9c;">
harbor0 · File storage, backup, sync, and sharing.<br>
Questions? Write to <a href="mailto:${contact}" style="color:#8a8f9c;">${contact}</a>; replies to this email aren't read.
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

export type Email =
    | { template: 'INVITE'; to: string; sender: string; }
    | { template: 'BETA_INVITE'; to: string; code: string; }
    | { template: 'BETA_WAITLIST'; to: string; }
    | { template: 'WELCOME'; to: string; name: string; quotaBytes: number; }
    | { template: 'ACCOUNT_DELETED'; to: string; name: string; purgeAt: string; }
    | {
        template: 'ACCOUNT_CLOSED';
        to: string;
        name: string;
        purgeAt: string;
        reason: StaffDeletionReason;
    }
    | {
        template: 'STORAGE';
        to: string;
        name: string;
        level: StorageAlertLevel;
        usedBytes: number;
        quotaBytes: number;
    }
    | {
        template: 'BACKUP_STALE';
        to: string;
        name: string;
        device: string;
        folders: { name: string; lastBackupAt: string | null; }[];
    }
    | {
        template: 'NEW_SIGN_IN';
        to: string;
        name: string;
        device: string;
        platform: string;
        at: string;
    }
    | { template: 'PASSWORD_CHANGED'; to: string; name?: string; at: string; }
    | { template: 'SIGNED_OUT'; to: string; name: string; device?: string; };
export type StorageAlertLevel = 80 | 95 | 100;

const greet = (name: string | undefined, sentence: string) =>
    name ? `Hi ${escape(name)}, ${sentence}` : sentence[0].toUpperCase() + sentence.slice(1);
const longDate = (iso: string) =>
    new Date(iso).toLocaleDateString('en-US', { dateStyle: 'long', timeZone: 'UTC' });
const dateTime = (iso: string) =>
    `${new Date(iso).toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short', timeZone: 'UTC' })} UTC`;
const size = (bytes: number) =>
    bytes >= 1e9 ? `${+(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`;
const mailto = `<a href="mailto:${contact}" style="color:#4353d9;">${contact}</a>`;
const platforms: Record<string, string> = {
    WEB: 'Web browser',
    MACOS: 'macOS',
    WINDOWS: 'Windows',
    LINUX: 'Linux',
    IOS: 'iOS',
    ANDROID: 'Android',
};

/** The plain-text part, derived from the same content as the HTML. */
function plainText(message: Message) {
    const text = (html: string) =>
        html
            .replace(/<br\s*\/?>/g, '\n')
            .replace(/<a href="mailto:[^"]*"[^>]*>(.*?)<\/a>/g, '$1')
            .replace(/<a href="([^"]*)"[^>]*>(.*?)<\/a>/g, '$2 ($1)')
            .replace(/<[^>]+>/g, '')
            .replace(
                /&(amp|lt|gt|quot|#39);/g,
                (_, entity: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[entity]!,
            );
    return [
        text(message.heading),
        text(message.intro),
        ...(message.list ?? []).map(([title, body]) => `${text(title)}: ${text(body)}`),
        ...(message.details ?? []).map(([label, value]) => `${text(label)}: ${text(value)}`),
        ...(message.code ? [message.code] : []),
        ...(message.action ? [`${message.action.label}: ${text(message.action.url)}`] : []),
        text(message.footnote),
    ].join('\n\n');
}

function closedMessage(email: Extract<Email, { template: 'ACCOUNT_CLOSED'; }>): Message {
    const purge = longDate(email.purgeAt);
    const account = escape(email.to);
    const details: Message['details'] = [['Files erased on', purge]];
    const mistake = `Your files can't be opened and will be permanently erased on ${purge}. If you think this is a mistake, write to ${mailto} before then.`;
    switch (email.reason) {
        case 'USER_REQUEST':
            return {
                subject: 'Your harbor0 account was deleted',
                preheader: `As you asked, we deleted your harbor0 account. Files are erased on ${purge}.`,
                heading: 'We deleted your account',
                intro: greet(email.name, `as you asked, we deleted your harbor0 account for ${account}.`),
                details,
                footnote: `Until then your files are kept but can't be opened; after that they're permanently erased. Your email address and username are free again, so you can create a new account at any time.<br><br>If you didn't ask us to delete your account, write to ${mailto} right away.`,
            };
        case 'TERMS_VIOLATION':
            return {
                subject: 'Your harbor0 account was closed',
                preheader: 'Your account was closed for breaking the harbor0 terms of use.',
                heading: 'Your account was closed',
                intro: greet(
                    email.name,
                    `we closed your harbor0 account for ${account} because it was used in a way that breaks the harbor0 terms of use.`,
                ),
                details,
                footnote: mistake,
            };
        case 'ABUSE':
            return {
                subject: 'Your harbor0 account was closed',
                preheader: 'Your account was closed because it was used for spam, fraud or abuse.',
                heading: 'Your account was closed',
                intro: greet(
                    email.name,
                    `we closed your harbor0 account for ${account} because it was used for spam, fraud or abuse of other people or of harbor0.`,
                ),
                details,
                footnote: mistake,
            };
        case 'DUPLICATE':
            return {
                subject: 'Your duplicate harbor0 account was closed',
                preheader: 'We closed a duplicate account. Your other account is not affected.',
                heading: 'Your duplicate account was closed',
                intro: greet(
                    email.name,
                    `we closed the harbor0 account for ${account} because it duplicated another account of yours. Your other account isn't affected.`,
                ),
                details,
                footnote: `Files in this account can't be opened and will be permanently erased on ${purge}. If you need something from it, or this wasn't a duplicate, write to ${mailto} before then.`,
            };
        case 'OTHER':
            return {
                subject: 'Your harbor0 account was closed',
                preheader: `Your account was closed. Files are erased on ${purge}.`,
                heading: 'Your account was closed',
                intro: greet(email.name, `the harbor0 team closed your harbor0 account for ${account}.`),
                details,
                footnote: `Your files can't be opened and will be permanently erased on ${purge}. To find out more, or if you think this is a mistake, write to ${mailto} before then.`,
            };
    }
}

function accountMessage(email: Email, webOrigin: string): Message {
    const app = escape(webOrigin);
    const reset = { label: 'Reset your password', url: escape(`${webOrigin}/forgot-password`) };
    switch (email.template) {
        case 'INVITE':
            return {
                subject: 'A file is waiting for you in harbor0',
                preheader: `${escape(email.sender)} sent you files in harbor0.`,
                heading: 'You have files waiting',
                intro: `<strong style="color:#16181d;">${escape(email.sender)}</strong> sent you files in harbor0. Create an account with this email address and verify it to receive them.`,
                action: { label: 'Create your account', url: escape(`${webOrigin}/signup`) },
                footnote:
                    'Invitations expire after 30 days. Files are never available through public links, only in the account that owns this email address.',
            };
        case 'BETA_INVITE':
            return {
                subject: 'Your harbor0 sign-up link',
                preheader: 'Your place in the harbor0 beta is ready.',
                heading: 'You’re in the harbor0 beta',
                intro: `Your place is ready. Create your account with ${escape(email.to)} to get ${size(BETA_QUOTA)} of private storage, yours to keep after the beta.`,
                action: {
                    label: 'Create your account',
                    url: escape(`${webOrigin}/signup?invite=${encodeURIComponent(email.code)}`),
                },
                footnote:
                    'This link works only for this email address. Seats in each beta wave go to whoever signs up first, so use it soon. If you didn’t ask to join, ignore this email.',
            };
        case 'BETA_WAITLIST':
            return {
                subject: 'You’re on the harbor0 waitlist',
                preheader: 'We’ll email your sign-up link when the next beta wave opens.',
                heading: 'You’re on the waitlist',
                intro: `This wave of the harbor0 beta is full. We’ll email ${escape(email.to)} a sign-up link when the next wave opens. Places go in the order people asked.`,
                footnote:
                    'There’s nothing else to do for now. If you didn’t ask to join, ignore this email.',
            };
        case 'WELCOME': {
            const quota = `${Math.round(email.quotaBytes / 1e9)} GB`;
            return {
                subject: 'Welcome to harbor0',
                preheader: `Your account is ready with ${quota} of storage.`,
                heading: `Welcome to harbor0, ${escape(email.name)}`,
                intro: `Your account is ready with ${quota} of storage. Here's how to get started:`,
                list: [
                    ['Upload from your browser', 'Drag files and folders into My Drive.'],
                    [
                        'Sync and back up your computer',
                        'The desktop app keeps a folder in sync and backs up the folders you choose.',
                    ],
                    ['Send files to anyone', 'Share with a harbor0 username or any email address.'],
                ],
                action: { label: 'Open harbor0', url: app },
                footnote: `Get the desktop and mobile apps at <a href="${site}/apps" style="color:#4353d9;">harbor0.com/apps</a>.`,
            };
        }
        case 'ACCOUNT_DELETED': {
            const purge = longDate(email.purgeAt);
            return {
                subject: 'Your harbor0 account was deleted',
                preheader: `Your files will be permanently erased on ${purge}.`,
                heading: 'Your account was deleted',
                intro: greet(
                    email.name,
                    `your harbor0 account for ${escape(email.to)} was deleted and signed out on every device.`,
                ),
                details: [['Files erased on', purge]],
                footnote: `Until then your files are kept but can't be opened; after that they're permanently erased. Your email address and username are free again, so you can create a new account at any time.<br><br>If you didn't delete your account, write to ${mailto} right away.`,
            };
        }
        case 'ACCOUNT_CLOSED':
            return closedMessage(email);
        case 'STORAGE': {
            const used = `${size(email.usedBytes)} of your ${size(email.quotaBytes)}`;
            const details: Message['details'] = [
                ['Used', used],
                ['Available', size(Math.max(0, email.quotaBytes - email.usedBytes))],
            ];
            const footnote =
                'Emptying the trash frees its space right away. Deleting old file versions and files you no longer need helps too.';
            return email.level === 100
                ? {
                    subject: 'Your harbor0 storage is full',
                    preheader: 'New uploads, sync and backups are paused until you free up space.',
                    heading: 'Your storage is full',
                    intro: greet(
                        email.name,
                        `you're using ${used}. New uploads, sync and backups are paused until you free up space.`,
                    ),
                    details,
                    action: { label: 'Free up space', url: escape(`${webOrigin}/storage`) },
                    footnote,
                }
                : {
                    subject: `Your harbor0 storage is ${email.level}% full`,
                    preheader: `You've used ${email.level}% of your storage.`,
                    heading:
                        email.level === 95
                            ? 'Your storage is almost full'
                            : `You've used ${email.level}% of your storage`,
                    intro: greet(
                        email.name,
                        `you're using ${used}. When it's full, new uploads, sync and backups pause until you free up space.`,
                    ),
                    details,
                    action: { label: 'Review your storage', url: escape(`${webOrigin}/storage`) },
                    footnote,
                };
        }
        case 'BACKUP_STALE': {
            const device = escape(email.device);
            const [only] = email.folders;
            const one = email.folders.length === 1;
            const what = one
                ? `a backup of <strong style="color:#16181d;">${escape(only.name)}</strong>`
                : `backups of ${email.folders.length} folders`;
            return {
                subject: one
                    ? `Your backup of “${only.name}” hasn't run in a week`
                    : `Backups from ${email.device} haven't run in a week`,
                preheader: `harbor0 hasn't finished a backup from ${device} for 7 days.`,
                heading: one ? "Your backup hasn't run in a week" : "Your backups haven't run in a week",
                intro: greet(
                    email.name,
                    `harbor0 hasn't finished ${what} from ${device} for 7 days. Changes made since the last backup aren't protected yet.`,
                ),
                details: [
                    ['Computer', device],
                    ...email.folders.map((folder): [string, string] => [
                        escape(folder.name),
                        folder.lastBackupAt ? `Last backup ${longDate(folder.lastBackupAt)}` : 'Never finished',
                    ]),
                ],
                action: { label: 'Check your backups', url: escape(`${webOrigin}/backups`) },
                footnote:
                    'Make sure the computer is on, online and signed in to harbor0, then open the desktop app. If you no longer use this computer, stop backing up its folders in harbor0 and these reminders stop.',
            };
        }
        case 'NEW_SIGN_IN':
            return {
                subject: 'New sign-in to your harbor0 account',
                preheader: `Your account was signed in on ${escape(email.device)}.`,
                heading: 'New sign-in to your account',
                intro: greet(email.name, 'your harbor0 account was just signed in on a new device.'),
                details: [
                    ['Device', escape(email.device)],
                    ['Platform', platforms[email.platform] ?? escape(email.platform)],
                    ['Time', dateTime(email.at)],
                ],
                action: reset,
                footnote: `If this was you, there's nothing to do. If it wasn't, reset your password right away, sign the device out under <a href="${app}/devices" style="color:#4353d9;">Devices</a>, and write to ${mailto}.`,
            };
        case 'PASSWORD_CHANGED':
            return {
                subject: 'Your harbor0 password was changed',
                preheader: 'The password for your harbor0 account was changed.',
                heading: 'Your password was changed',
                intro: greet(
                    email.name,
                    `the password for your harbor0 account was changed on ${dateTime(email.at)}.`,
                ),
                action: reset,
                footnote: `If this was you, there's nothing to do. If it wasn't, reset your password right away and write to ${mailto}.`,
            };
        case 'SIGNED_OUT':
            return {
                subject: email.device
                    ? 'A device was signed out of your harbor0 account'
                    : 'You were signed out of harbor0',
                preheader: 'harbor0 support signed your account out.',
                heading: email.device ? 'A device was signed out' : 'You were signed out everywhere',
                intro: greet(
                    email.name,
                    email.device
                        ? `harbor0 support signed <strong style="color:#16181d;">${escape(email.device)}</strong> out of your account. Sign in again on that device to keep using it.`
                        : 'harbor0 support signed your account out on every device. Sign in again to keep using harbor0.',
                ),
                action: { label: 'Sign in', url: escape(`${webOrigin}/login`) },
                footnote: `This is usually done to protect your account. If you have questions, write to ${mailto}.`,
            };
    }
}

// Mail the maintenance job sends: file invitations and account notices.
export function composeEmail(email: Email, webOrigin: string) {
    const message = accountMessage(email, webOrigin);
    return { subject: message.subject, html: renderEmail(message), text: plainText(message) };
}

function message(event: CustomMessageTriggerEvent): Message | undefined {
    const attributes = event.request.userAttributes;
    const name = attributes.name || attributes.preferred_username;
    const signIn = process.env.SIGN_IN_URL || undefined;
    switch (event.triggerSource) {
        case 'CustomMessage_SignUp':
        case 'CustomMessage_ResendCode':
            return {
                subject: 'Your harbor0 verification code',
                preheader: 'Enter this code to finish creating your harbor0 account.',
                heading: 'Verify your email',
                intro: greet(name, 'enter this code to finish creating your harbor0 account.'),
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
                    name,
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
                intro: greet(name, 'enter this code in harbor0 to confirm this email address.'),
                code: CODE,
                footnote: "If you didn't request this, you can ignore this email.",
            };
        case 'CustomMessage_Authentication':
            return {
                subject: 'Your harbor0 sign-in code',
                preheader: 'Enter this code to finish signing in.',
                heading: 'Finish signing in',
                intro: greet(name, 'enter this code to finish signing in to harbor0.'),
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
                    name,
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
