import {
  Check,
  Clock,
  History,
  Lock,
  RefreshCw,
  RotateCcw,
  Search,
  Users,
  type LucideIcon,
} from 'lucide-react';
import type { StaticImageData } from 'next/image';
import backupsDark from './shots/backups-dark.png';
import backupsHistoryDark from './shots/backups-history-dark.png';
import backupsHistoryLight from './shots/backups-history-light.png';
import backupsLight from './shots/backups-light.png';
import driveDark from './shots/drive-dark.png';
import driveLight from './shots/drive-light.png';
import driveVersionsDark from './shots/drive-versions-dark.png';
import driveVersionsLight from './shots/drive-versions-light.png';
import sharedDark from './shots/shared-dark.png';
import sharedLight from './shots/shared-light.png';
import sharedSentDark from './shots/shared-sent-dark.png';
import sharedSentLight from './shots/shared-sent-light.png';
import syncDark from './shots/sync-dark.png';
import syncLight from './shots/sync-light.png';

// The screenshots come from `tsx scripts/landing-shots.ts`.
export type Picture = { shot: StaticImageData; darkShot: StaticImageData; alt: string };
export type Note = { icon: LucideIcon; title: string; text: string };
export type Feature = Picture & {
  /** Also the page address: `/drive`, `/sync`, ... */
  id: string;
  name: string;
  tint: string;
  /** One line for the home page row. */
  text: string;
  notes: [Note, Note];
  // Everything below is only shown on the feature's own page.
  tagline: string;
  lede: string;
  platforms: string[];
  steps: [string, string][];
  more: Picture & { title: string; text: string };
  facts: [string, string][];
  questions: [string, string][];
};

export const features: Feature[] = [
  {
    id: 'drive',
    name: 'Drive',
    tint: 'var(--primary)',
    text: 'Every file in one place, with search, previews and version history.',
    shot: driveLight,
    darkShot: driveDark,
    alt: 'My Drive, listing folders and files',
    notes: [
      { icon: Search, title: 'Search', text: 'Find any file from anywhere with ⌘K.' },
      { icon: History, title: 'Version history', text: 'Go back to any earlier copy.' },
    ],
    tagline: 'Every file in one place.',
    lede: 'Upload, organise, preview and find your files from the browser or the desktop app.',
    platforms: ['Web', 'Desktop'],
    steps: [
      [
        'Upload',
        'Add files or a whole folder. Large uploads can be paused, resumed or cancelled, and they retry on their own.',
      ],
      [
        'Organise',
        'Sort files into folders, rename and move them, and star the ones you use most. Search finds files and folders by name.',
      ],
      [
        'Open anywhere',
        'Preview text, images, audio and video in place. Download a single file, or a whole folder as one ZIP.',
      ],
    ],
    more: {
      title: 'Every save keeps the old copy.',
      text: 'Uploading a new version of a file never overwrites the last one. Open Version history from a file’s menu to download an earlier copy or restore it as the current one. Old versions are never removed automatically.',
      shot: driveVersionsLight,
      darkShot: driveVersionsDark,
      alt: 'The version history of a file, with Download and Restore for each version',
    },
    facts: [
      [
        'Storage',
        '50 GB free during the beta. Every version, backups and the trash count towards it.',
      ],
      ['Previews', 'Text up to 1 MB, images, audio and video. Other formats download instead.'],
      [
        'ZIP downloads',
        'A folder downloads as one ZIP with its subfolders intact. The prepared ZIP is kept for 24 hours.',
      ],
      ['Trash', 'Deleted files wait in the trash until you restore or permanently remove them.'],
      ['Three views', 'My Drive separates Cloud files, Backup folders and Sync folders.'],
      ['Stable links', 'A folder keeps the same address when it is renamed or moved.'],
    ],
    questions: [
      ['Do old versions use my storage?', 'Yes. Every saved version counts towards your storage.'],
      [
        'Does search look inside files?',
        'No. Search matches the names of files and folders, not their contents.',
      ],
      [
        'What happens to a format that cannot be previewed?',
        'The viewer offers a download instead.',
      ],
    ],
  },
  {
    id: 'sync',
    name: 'Sync',
    tint: 'var(--success)',
    text: 'Pick a folder once and it stays in step on all your computers, and with the people you share it with.',
    shot: syncLight,
    darkShot: syncDark,
    alt: 'The desktop app listing synced folders and their status',
    notes: [
      { icon: Check, title: 'Up to date', text: 'Nothing to press. Changes go out as you save.' },
      { icon: Users, title: 'Shared folders', text: 'Sync one folder between accounts.' },
    ],
    tagline: 'Set it up once. Then forget it’s there.',
    lede: 'Choose a folder in the desktop app and it stays in step on all your computers, and with everyone you share it with. There is no cloud location to set up and no button to press.',
    platforms: ['Desktop'],
    steps: [
      [
        'Pick a folder',
        'Choose Add folder to sync and pick any folder on your computer. That is the whole setup.',
      ],
      [
        'Keep working',
        'Save, add, rename and delete as you always do. Each change is picked up on its own, and anything done offline goes out when you reconnect.',
      ],
      [
        'It’s everywhere',
        'Your other computers, and everyone you share the folder with, get the change. Each file is checked before it replaces the old one.',
      ],
    ],
    more: {
      title: 'Sync with other accounts, not just your own computers.',
      text: 'Share a synced folder with a colleague, a family member or your own second account. They accept the invitation and pick a folder on their computer. From then on you all add, edit, rename and delete in the same folder, and only you decide who is in it.',
      shot: sharedLight,
      darkShot: sharedDark,
      alt: 'An invitation to a shared folder with two-way sync, waiting to be accepted',
    },
    facts: [
      [
        'Nothing to press',
        'No sync button and no schedule. Each folder shows Up to date once every change has arrived.',
      ],
      [
        'Conflicts are safe',
        'If a file changes in two places at once, both versions are kept and the app asks you to review them.',
      ],
      [
        'Invite anyone',
        'Invite any harbor0 account by email or username, with up to 20 active invitations per owner.',
      ],
      [
        'Owner’s storage',
        'A shared folder counts only against its owner’s storage, whoever adds the files.',
      ],
      [
        'Leaving is clean',
        'When access is removed, sync stops and the files already on each computer stay there.',
      ],
      [
        'Several accounts',
        'Sign in to a different account on the same computer and it keeps its own sync folders. Sign back in and yours are as you left them.',
      ],
      ['Your rules', 'Pause sync whenever you like, and leave chosen subfolders out.'],
      [
        'Between computers',
        'The cloud holds a temporary copy only until every computer has the file. To keep one in the cloud too, use Copy to cloud in My Drive, or back the folder up.',
      ],
    ],
    questions: [
      [
        'Do I need the desktop app?',
        'Yes, on every computer that syncs, including those of the people you share with. Synced folders can also be browsed on the web under My Drive.',
      ],
      [
        'Does the person I share with need an account?',
        'Yes. Invite them by the email address or username of their harbor0 account. They accept in the desktop app.',
      ],
      [
        'Can two harbor0 accounts use one computer?',
        'Yes, one signed in at a time. Each account keeps its own sync folders, so choose a different local folder for each.',
      ],
      [
        'Are deletions synced too?',
        'Yes. Deleting a file removes it on your other computers and for everyone in a shared folder.',
      ],
    ],
  },
  {
    id: 'backups',
    name: 'Backups',
    tint: '#0e7490',
    text: 'Pick a folder once and every version is saved on its own, from all your computers. Restore any of them later.',
    shot: backupsLight,
    darkShot: backupsDark,
    alt: 'The Backups page with a backed-up folder and the saved versions of one file',
    notes: [
      { icon: Clock, title: 'Automatic', text: 'Nothing to press. Versions save themselves.' },
      { icon: RotateCcw, title: 'Restore', text: 'Bring back any saved version.' },
    ],
    tagline: 'Pick a folder. Your backup is done.',
    lede: 'Point the desktop app at a folder you already use. From then on every change is saved as a new version on its own, and nothing you delete on your computer is lost.',
    platforms: ['Desktop', 'Web (browse and download)'],
    steps: [
      [
        'Pick a folder',
        'Choose Add folder in Backups and pick a folder you already use. Nothing moves and nothing changes on your computer.',
      ],
      [
        'Forget about it',
        'An hour after you stop editing a file, the new version is saved. Need it sooner? Back up now saves straight away.',
      ],
      [
        'Go back in time',
        'Open any file to see every saved version. Restore puts one back where it was; Download saves a separate copy.',
      ],
    ],
    more: {
      title: 'See exactly what was saved, and when.',
      text: 'History lists every backup run with the files it saved. Backups from all your computers sit together in one account, and any version can be downloaded from the web, wherever you are.',
      shot: backupsHistoryLight,
      darkShot: backupsHistoryDark,
      alt: 'The History tab of a backup folder, listing a run and the files it saved',
    },
    facts: [
      ['Nothing to press', 'No schedule to set. Each folder shows when it was last backed up.'],
      ['Deleting is safe', 'Deleting a file on your computer leaves every saved version intact.'],
      [
        'All your computers',
        'Back up folders from each of your computers. They appear together in Backups, with the computer each came from.',
      ],
      [
        'Restore in place',
        'Restoring puts the file back in its original folder, once that computer is online with backups running.',
      ],
      ['Download anywhere', 'Download any saved version from the web, on any computer.'],
      [
        'Protected',
        'Backed-up folders are read-only in My Drive, so nothing changes them by accident. Only the source computer adds versions.',
      ],
      [
        'Your rules',
        'Pause a folder’s backups whenever you like. Stop backing up keeps your files and every saved version, and the folder becomes an ordinary Cloud folder.',
      ],
      ['Storage', 'Saved versions count towards your storage and are never removed automatically.'],
    ],
    questions: [
      [
        'How is this different from Sync?',
        'Sync keeps a folder identical on several computers, deletions included. Backups only save versions from one computer and never delete them.',
      ],
      [
        'Can I back up more than one computer?',
        'Yes. Install the desktop app on each one and add its folders. Every backup appears in your account.',
      ],
      [
        'What if I delete a file by accident?',
        'Its saved versions stay. Open the folder in Backups, find the file, and restore or download it.',
      ],
      [
        'Can I get a file back on a different computer?',
        'Yes. Sign in on the web and download any saved version.',
      ],
    ],
  },
  {
    id: 'share',
    name: 'Share',
    tint: 'var(--warning)',
    text: 'Send files to people by username or email, or sync a shared folder both ways.',
    shot: sharedLight,
    darkShot: sharedDark,
    alt: 'The Shared page with a folder invitation and received files',
    notes: [
      { icon: RefreshCw, title: 'Two-way sync', text: 'Shared folders update for everyone.' },
      { icon: Lock, title: 'Private', text: 'Signed-in people only, no public links.' },
    ],
    tagline: 'Send files to people, not to links.',
    lede: 'Send files and folders to a username or an email address. Only the person you chose, signed in, can open them.',
    platforms: ['Web', 'Desktop'],
    steps: [
      ['Send', 'Pick files or folders and enter the recipient’s exact username or email address.'],
      [
        'They decide',
        'The recipient accepts or declines. If the email has no account yet, the files wait until they sign up and verify that address.',
      ],
      [
        'They keep a copy',
        'Accepted files can be downloaded, or saved to their own My Drive without uploading anything again.',
      ],
    ],
    more: {
      title: 'Keep track of what you sent.',
      text: 'The Sent tab shows every transfer, who it went to, whether it was accepted and when it expires. Cancel one that has not been accepted yet.',
      shot: sharedSentLight,
      darkShot: sharedSentDark,
      alt: 'The Sent tab listing three transfers with their recipients and status',
    },
    facts: [
      ['No public links', 'Files are only ever shared with signed-in people you name.'],
      ['Expiry', 'A transfer expires 30 days after it is sent.'],
      [
        'Shared folders',
        'In the desktop app, open a synced folder’s menu and choose Share folder. The other person accepts and picks a local folder.',
      ],
      [
        'Two-way sync',
        'Everyone in a shared folder can add, edit, rename and delete. Conflicting edits are kept.',
      ],
      [
        'Owner’s storage',
        'A shared folder uses the owner’s storage, and only the owner manages access. Removing access stops sync and leaves the other person’s local files in place.',
      ],
      [
        'Notifications',
        'The desktop app checks for incoming files and invitations every 10 seconds while you are signed in.',
      ],
    ],
    questions: [
      [
        'Does the other person need an account?',
        'Yes. Files sent to an email address wait until that person signs up and verifies it.',
      ],
      [
        'Whose storage do saved files use?',
        'Saving received files to My Drive makes a copy that belongs to the recipient and counts towards their storage.',
      ],
      [
        'Can I take back something I sent?',
        'You can cancel a transfer that has not been accepted. For a shared folder, the owner can remove access at any time.',
      ],
    ],
  },
];
