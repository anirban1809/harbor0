import type { Metadata } from 'next';
import Link from 'next/link';
import { LegalPage, mail, type LegalSection } from '../legal';

export const metadata: Metadata = {
  title: 'Terms of Service — harbor0',
  description: 'The terms for using harbor0.',
};

// Bump when the terms change, and say what changed in the notice to users.
const updated = 'October 4, 2026';

const sections: LegalSection[] = [
  [
    'Agreeing to these terms',
    [
      'These terms govern your use of harbor0 — the website, the web app, the desktop app, and the API they use (together, the “service”). By creating an account or using the service, you agree to them. If you don’t agree, don’t use the service.',
      <>
        Our <Link href="/privacy">Privacy Policy</Link> explains what information we collect and how
        we use it.
      </>,
      'You must be at least 13 years old, or the minimum age to consent to online services where you live if that is higher. If you use harbor0 for an organisation, you confirm you may accept these terms on its behalf.',
    ],
  ],
  [
    'The beta',
    [
      'harbor0 is in beta. Features may change, break or be removed, and the service may be unavailable at times. Keep another copy of anything you can’t afford to lose.',
      'Accounts created during the beta get 50 GB of storage at no charge, and keep it after the beta ends. We may cap the number of beta accounts and offer sign-ups by invitation or waitlist.',
    ],
  ],
  [
    'Your account',
    [
      'Give accurate details when you sign up and keep your password secret. You are responsible for what happens under your account, including on devices you have signed in to. Tell us at once if you think someone else has access to it.',
      'Your @username lets other people send you files. We may reclaim or change a username that impersonates someone, infringes a trademark, or is otherwise misleading.',
    ],
  ],
  [
    'Your files',
    [
      'You keep every right you have in the files you store. You give us only the permission we need to run the service for you: to store, copy, process, sync, back up, preview and transmit your files, and to deliver them to the people you share them with.',
      'Your files are private unless you share them. We don’t sell your files or use them to train models or target advertising. Our staff don’t look at your files except when you ask us to, when needed to keep the service secure or investigate a breach of these terms, or when the law requires it.',
      'When you share a file or folder, or send a transfer, the recipient can see, download and keep copies of it. Shared sync folders change for everyone in them, so an edit or deletion by one member applies to all.',
    ],
  ],
  [
    'Storage, trash and deletion',
    [
      'Your account has a storage limit. Files in the trash, saved versions and backups count toward it. When you reach the limit, new uploads, syncs and backups may stop until you free up space or get more.',
      'Deleted files go to the trash and stay there until you restore them or empty it. Emptying the trash, or deleting a file from it, is permanent. Transfers that aren’t accepted expire after 30 days.',
      'You can delete your account at any time in Settings. Your files are permanently deleted 30 days later, and cannot be recovered after that. Copies in our infrastructure’s routine backups and logs expire on their own schedules.',
    ],
  ],
  [
    'Acceptable use',
    [
      'Don’t use harbor0 to:',
      <ul key="rules">
        <li>store or share anything illegal, including child sexual abuse material;</li>
        <li>infringe anyone’s copyright, trademark, privacy or other rights;</li>
        <li>distribute malware, or phish, spam or harass people;</li>
        <li>share files with people who haven’t agreed to receive them, at scale;</li>
        <li>
          probe, scan or test the service’s security without our written permission, or get around
          storage limits, rate limits or access controls;
        </li>
        <li>
          overload or disrupt the service, or access it other than through our apps and documented
          API;
        </li>
        <li>resell the service, or run a public file host or content-delivery network on it.</li>
      </ul>,
      'We may remove content, or suspend or close accounts, that break these rules. Where we can, we’ll tell you first and give you a chance to fix the problem and download your files. We report child sexual abuse material to the authorities.',
    ],
  ],
  [
    'Copyright complaints',
    [
      <>
        If you believe files on harbor0 infringe your copyright, email {mail} with your contact
        details, a description of the work, enough information for us to find the files, and a
        statement, made in good faith and under penalty of perjury, that you own the rights or act
        for the owner. We may remove the files and close the accounts of repeat infringers.
      </>,
    ],
  ],
  [
    'Paid plans',
    [
      'The beta is free. If we introduce paid storage, we’ll publish the prices and terms before charging anything, and you’ll only pay for a plan you choose. Your beta storage stays free either way.',
    ],
  ],
  [
    'Our software',
    [
      'We give you a personal, non-exclusive, non-transferable licence to use our apps to access the service while you have an account. The apps may update themselves. Don’t copy, modify, or reverse engineer them except where the law allows it. Beta builds of the desktop app may not be signed or notarised by the operating system vendor.',
    ],
  ],
  [
    'Ending the service',
    [
      'You can stop using harbor0 and delete your account at any time.',
      'We may suspend or close your account for a serious or repeated breach of these terms, or if the law requires it. If we discontinue the service, or close your account for any reason other than a breach, we’ll give you at least 30 days’ notice so you can download your files.',
    ],
  ],
  [
    'No warranty',
    [
      'The service is provided “as is” and “as available”. To the fullest extent the law allows, we make no warranties, express or implied, including about merchantability, fitness for a particular purpose, non-infringement, or that the service will be uninterrupted, error-free or never lose data.',
    ],
  ],
  [
    'Limitation of liability',
    [
      'To the fullest extent the law allows, harbor0 is not liable for indirect, incidental, special, consequential or punitive damages, or for lost profits, revenue or data. Our total liability for any claim about the service is limited to the greater of the amount you paid us in the 12 months before the claim and US$50.',
      'Nothing in these terms limits liability that can’t be limited by law, or takes away rights you have as a consumer that can’t be waived.',
    ],
  ],
  [
    'Indemnity',
    [
      'If someone brings a claim against us because of your files or your breach of these terms, you agree to cover our reasonable costs of dealing with it, to the extent the law allows.',
    ],
  ],
  [
    'Changes to these terms',
    [
      'We may update these terms as the service changes. For changes that materially affect you, we’ll email you or notify you in the app at least 30 days before they take effect. If you keep using harbor0 after that, you accept the new terms; if you don’t, you can delete your account.',
    ],
  ],
  [
    'General',
    [
      'These terms are the whole agreement between you and us about the service. If part of them can’t be enforced, the rest still applies. If we don’t enforce a term straight away, we haven’t waived it. You may not transfer these terms without our consent; we may transfer them to whoever takes over the service.',
    ],
  ],
  ['Contact', [<>Questions about these terms? Email {mail}.</>]],
];

export default function TermsPage() {
  return <LegalPage title="Terms of Service" updated={updated} sections={sections} />;
}
