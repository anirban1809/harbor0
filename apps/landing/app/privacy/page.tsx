import type { Metadata } from 'next';
import Link from 'next/link';
import { LegalPage, mail, type LegalSection } from '../legal';

export const metadata: Metadata = {
  title: 'Privacy Policy — harbor0',
  description: 'What harbor0 collects, why, and the choices you have.',
};

// Bump when the policy changes, and say what changed in the notice to users.
const updated = 'October 4, 2026';

const sections: LegalSection[] = [
  [
    'This policy',
    [
      'This policy explains what personal information harbor0 collects when you use the website, the web app, the desktop app, and the API they use (together, the “service”), how we use it, and the choices you have.',
      <>
        It sits alongside our <Link href="/terms">Terms of Service</Link>. In short: your files are
        yours, we collect what we need to run the service, and we don’t sell your data or track you
        for advertising.
      </>,
    ],
  ],
  [
    'What we collect',
    [
      <ul key="collect">
        <li>
          <strong>Account details</strong> — your email address, display name and @username. Your
          password is handled by our sign-in provider and stored only as a salted hash; we never see
          or store it in plain text.
        </li>
        <li>
          <strong>Your files</strong> — the files you upload, sync or back up, their names, sizes,
          folders and saved versions, and who you share them with.
        </li>
        <li>
          <strong>Devices</strong> — the name and platform of each device you sign in on, its
          sessions, the folders you sync or back up from it.
        </li>
        <li>
          <strong>Activity</strong> — a record of actions on your account, such as uploads,
          downloads, shares and sign-ins, shown to you and used for security.
        </li>
        <li>
          <strong>Technical logs</strong> — server logs of requests to the service, which can
          include your IP address, the time and the request made.
        </li>
        <li>
          <strong>Messages</strong> — what you send us when you email us for help.
        </li>
      </ul>,
      'We don’t use advertising or analytics trackers, and we don’t buy data about you from anyone else.',
    ],
  ],
  [
    'How we use it',
    [
      'We use your information to:',
      <ul key="use">
        <li>run the service: store, sync, back up and deliver your files;</li>
        <li>
          let other people find you by @username, and show your name on files you share or send;
        </li>
        <li>
          send you account email — verification codes, password resets, invitations, and notices
          about your account or these policies;
        </li>
        <li>keep the service secure, and prevent fraud, abuse and breaches of our terms;</li>
        <li>answer your questions, and fix problems you report;</li>
        <li>meet our legal obligations.</li>
      </ul>,
      'We don’t look inside your files to profile you, and we don’t use them to train models or target advertising. We don’t sell or rent your personal information.',
    ],
  ],
  [
    'Who can see your information',
    [
      <ul key="see">
        <li>
          <strong>People you share with</strong> — the files and folders you share or send, and your
          display name and @username. Anyone who knows your @username can send you files.
        </li>
        <li>
          <strong>Our staff</strong> — a small team can see your account details, storage use,
          devices and activity to help you and keep the service safe. Our staff tools can’t open
          your files, every staff action is logged, and staff sign-in requires two-factor
          authentication.
        </li>
        <li>
          <strong>Service providers</strong> — the companies below, which process data only on our
          instructions.
        </li>
        <li>
          <strong>The law</strong> — authorities, when we’re legally required to disclose it, or
          when it’s needed to protect someone from serious harm. Where we can, we’ll tell you first.
        </li>
        <li>
          <strong>A new owner</strong> — if harbor0 is sold or merged, under this policy or one that
          protects you at least as well.
        </li>
      </ul>,
    ],
  ],
  [
    'Service providers',
    [
      <ul key="providers">
        <li>
          <strong>Amazon Web Services</strong> (United States) — hosting, the database, sign-in,
          email delivery and server logs.
        </li>
        <li>
          <strong>Cloudflare</strong> (United States) — storage for the contents of your files.
        </li>
      </ul>,
      'We’ll update this list before we add a provider that handles your personal information.',
    ],
  ],
  [
    'Where your data is stored',
    [
      'harbor0 stores your data in the United States. If you live elsewhere, your information is transferred there, and we rely on appropriate safeguards, such as standard contractual clauses, where the law requires them.',
    ],
  ],
  [
    'Security',
    [
      'Data travels to and from harbor0 over encrypted connections, and is encrypted at rest by our storage providers. Sign-in sessions use secure, HTTP-only cookies in the browser, and the operating system’s secure credential store in the desktop app. Access to our infrastructure is limited to the people who need it.',
      'Files are not end-to-end encrypted: harbor0 holds the keys, which is what lets us show previews, build ZIP downloads and deliver shares. No system is perfectly secure; if a breach affects your information, we’ll tell you without undue delay.',
    ],
  ],
  [
    'How long we keep it',
    [
      <ul key="retention">
        <li>Account details and files: while your account is open.</li>
        <li>Files in the trash: until you restore them or empty the trash.</li>
        <li>Transfers nobody accepts: they expire after 30 days.</li>
        <li>Your account activity: 90 days.</li>
        <li>Server logs: about 30 days.</li>
        <li>
          After you delete your account: your files and account data are permanently deleted 30 days
          later.
        </li>
      </ul>,
      'We may keep a minimal record longer where the law requires it, or to resolve a dispute or enforce our terms — for example, a record that an account was closed for abuse.',
    ],
  ],
  [
    'Cookies and local storage',
    [
      'The web app uses cookies only to keep you signed in. Your browser also stores your theme and the state of unfinished uploads on your device. The website remembers your light or dark theme. We use no advertising, analytics or third-party cookies, so there’s nothing to opt out of.',
    ],
  ],
  [
    'Your choices and rights',
    [
      'You can see and change your account details in Settings, download your files at any time, sign devices out, and delete your account.',
      <>
        Depending on where you live — for example under the GDPR in the UK and EU, or state privacy
        laws in the US — you may also have the right to access, correct, delete or receive a copy of
        your personal information, and to object to or restrict how we use it. Email {mail} to make
        a request; we’ll answer within 30 days, and won’t treat you differently for asking. You can
        also complain to your local data protection authority.
      </>,
      'Where the GDPR applies, we rely on performing our contract with you to run the service, on our legitimate interests to keep it secure and improve it, and on legal obligation where the law requires us to act.',
    ],
  ],
  [
    'Children',
    [
      'harbor0 is not for children under 13, or under the minimum age to consent to online services where they live. We don’t knowingly collect their information; if you believe a child has an account, email us and we’ll delete it.',
    ],
  ],
  [
    'Changes to this policy',
    [
      'If we change this policy in a way that materially affects you, we’ll email you or notify you in the app at least 30 days before the change takes effect. The date at the top shows when it last changed.',
    ],
  ],
  ['Contact', [<>Questions or requests about your privacy? Email {mail}.</>]],
];

export default function PrivacyPage() {
  return <LegalPage title="Privacy Policy" updated={updated} sections={sections} />;
}
