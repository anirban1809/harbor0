// Releases the Mac, Windows and Linux desktop apps on GitHub and points the landing site's downloads
// at them.
//
//   npm run release:desktop                 next patch version
//   npm run release:desktop -- minor        or major, or an exact version such as 0.2.0
//   npm run release:desktop -- --dry-run    build and update the files, but commit and publish nothing
//   npm run release:desktop -- --test       a test build of the next patch version, such as 0.1.9-test
//                                           (then 0.1.9-test.2, …); takes minor, major or x.y.z too
//   npm run release:desktop -- --test --linux  a test build that also has the Linux packages
//
// Releases always have Linux packages, built in Docker: AppImage, deb and rpm for x64, and AppImage
// and deb for arm64. Linux apps don't update themselves; people install new versions by hand.
//
// The installers are built from a clean worktree of HEAD, so uncommitted work in this checkout never
// ships. Both come from this Mac: an Apple silicon DMG and an x64 NSIS installer (which also runs on
// Windows on Arm). Installed apps find the new version through the GitHub release and update themselves. The version bump and the landing page's new link are committed together, the tag is pushed
// and the GitHub release created with the installer, and then main is pushed, which deploys the
// landing site once Validate passes.
//
// A test build is for trying new features before they ship. It can be released from any branch,
// and is a GitHub pre-release only: the landing site, main and the version in package.json are left
// alone (the version bump is committed only on the tag). Production apps never update to it, since
// they only look at the latest full release; test apps update to newer test builds and to the
// production release that follows them. Install the first test build by hand from its release page.
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const testBuild = args.includes('--test');
const linux = !testBuild || args.includes('--linux');
const bump = args.find((arg) => !arg.startsWith('--')) ?? 'patch';

const git = (...command: string[]) =>
  execFileSync('git', command, { cwd: root, encoding: 'utf8' }).trim();
const gh = (...command: string[]) =>
  execFileSync('gh', command, { cwd: root, encoding: 'utf8' }).trim();
async function run(command: string, commandArgs: string[], cwd: string) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd,
      stdio: 'inherit',
      env: process.env,
    });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)),
    );
  });
}

// Large uploads to GitHub sometimes stall until it gives up (HTTP 408), so the release is created
// as a draft, each installer is uploaded with retries, and only then is the release published.
async function publishRelease(files: string[], createArgs: string[], publishArgs: string[]) {
  gh('release', 'create', tag, '--repo', repo, '--verify-tag', '--draft', ...createArgs);
  for (const file of files)
    for (let attempt = 1; ; attempt++) {
      try {
        execFileSync('gh', ['release', 'upload', tag, file, '--clobber', '--repo', repo], {
          cwd: root,
          stdio: 'inherit',
        });
        break;
      } catch (error) {
        if (attempt === 5) throw error;
        console.log(`Uploading ${path.basename(file)} failed; retrying (${attempt} of 4).`);
      }
    }
  gh('release', 'edit', tag, '--repo', repo, '--draft=false', ...publishArgs);
}

const desktopPackage = 'apps/desktop/package.json';
const lockfile = 'package-lock.json';
const landingPage = 'apps/landing/app/apps/page.tsx';
const released = [desktopPackage, lockfile, landingPage];

// --- Checks -----------------------------------------------------------------------------------
if (!testBuild) {
  if (git('rev-parse', '--abbrev-ref', 'HEAD') !== 'main') throw new Error('Release from main.');
  const dirty = git('status', '--porcelain', '--', ...released);
  if (dirty) throw new Error(`Commit or discard the changes to these files first:\n${dirty}`);
}
if (!dryRun) git('fetch', 'origin', '--tags');
if (!dryRun && !testBuild) {
  git('fetch', 'origin', 'main');
  // Local commits not yet pushed are fine; they ship with the release.
  try {
    git('merge-base', '--is-ancestor', 'origin/main', 'HEAD');
  } catch {
    throw new Error('origin/main has commits this checkout lacks; pull first.');
  }
}

const current = JSON.parse(await readFile(desktopPackage, 'utf8')).version as string;
const release = (() => {
  if (/^\d+\.\d+\.\d+$/.test(bump)) return bump;
  const [major, minor, patch] = current.split('.').map(Number);
  if (bump === 'major') return `${major + 1}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  if (bump === 'patch') return `${major}.${minor}.${patch + 1}`;
  throw new Error(`Unknown version "${bump}": use patch, minor, major or x.y.z.`);
})();
// Test builds of one release are numbered: x.y.z-test, then x.y.z-test.2, x.y.z-test.3, …
const version = (() => {
  if (!testBuild) return release;
  if (git('tag', '--list', `v${release}`)) throw new Error(`v${release} is already released.`);
  const builds = git('tag', '--list', `v${release}-test*`)
    .split('\n')
    .map((tag) => /^v\d+\.\d+\.\d+-test(?:\.(\d+))?$/.exec(tag))
    .filter((match) => match !== null)
    .map((match) => Number(match[1] ?? 1));
  return builds.length ? `${release}-test.${Math.max(...builds) + 1}` : `${release}-test`;
})();
const tag = `v${version}`;
if (git('tag', '--list', tag)) throw new Error(`${tag} already exists.`);
// A release's generated notes cover everything since the last release, not since a test build.
const previousRelease = git('tag', '--list', 'v*', '--sort=-v:refname')
  .split('\n')
  .find((existing) => /^v\d+\.\d+\.\d+$/.test(existing));
const repo = gh('repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner');
console.log(
  `Releasing harbor0 desktop ${current} → ${version}${testBuild ? ' (test build)' : ''}${dryRun ? ' (dry run)' : ''}`,
);

async function setVersion(directory: string) {
  const file = path.join(directory, desktopPackage);
  const pkg = JSON.parse(await readFile(file, 'utf8'));
  pkg.version = version;
  await writeFile(file, JSON.stringify(pkg, null, 2) + '\n');
  const lockPath = path.join(directory, lockfile);
  const lock = JSON.parse(await readFile(lockPath, 'utf8'));
  lock.packages['apps/desktop'].version = version;
  await writeFile(lockPath, JSON.stringify(lock, null, 2) + '\n');
}

// --- Build from a clean worktree of HEAD ------------------------------------------------------
const targets = [
  {
    key: 'mac',
    platform: 'macOS',
    architecture: 'arm64',
    name: `harbor0-${version}-mac-arm64.dmg`,
    build: ['--mac', 'dmg', '--arm64'],
  },
  {
    key: 'windows',
    platform: 'Windows',
    architecture: 'x64',
    name: `harbor0-${version}-win-x64.exe`,
    build: ['--win', 'nsis', '--x64'],
  },
  // One Linux build per architecture makes all of its packages.
  ...(linux
    ? [
        {
          key: 'linuxAppImage',
          platform: 'Linux (AppImage)',
          architecture: 'x64',
          name: `harbor0-${version}-linux-x86_64.AppImage`,
          build: ['--linux', 'AppImage', 'deb', 'rpm', '--x64'],
        },
        {
          key: 'linuxDeb',
          platform: 'Linux (deb)',
          architecture: 'x64',
          name: `harbor0-${version}-linux-amd64.deb`,
          build: null,
        },
        {
          key: 'linuxRpm',
          platform: 'Linux (rpm)',
          architecture: 'x64',
          name: `harbor0-${version}-linux-x86_64.rpm`,
          build: null,
        },
        // arm64 is for Ubuntu and Debian on ARM machines, such as VMs on Apple silicon Macs.
        {
          key: 'linuxAppImageArm64',
          platform: 'Linux (AppImage)',
          architecture: 'arm64',
          name: `harbor0-${version}-linux-arm64.AppImage`,
          build: ['--linux', 'AppImage', 'deb', '--arm64'],
        },
        {
          key: 'linuxDebArm64',
          platform: 'Linux (deb)',
          architecture: 'arm64',
          name: `harbor0-${version}-linux-arm64.deb`,
          build: null,
        },
      ]
    : []),
];
const worktree = await mkdtemp(path.join(os.tmpdir(), 'harbor0-release-'));
try {
  git('worktree', 'add', '--detach', worktree, 'HEAD');
  // Reuse the installed dependencies, and the deploy outputs the build reads its API URL from.
  await symlink(path.join(root, 'node_modules'), path.join(worktree, 'node_modules'));
  await symlink(
    path.join(root, 'apps/desktop/node_modules'),
    path.join(worktree, 'apps/desktop/node_modules'),
  );
  await mkdir(path.join(worktree, '.cloud'), { recursive: true });
  for (const file of ['outputs.json', 'web-outputs.json'])
    await copyFile(path.join(root, '.cloud', file), path.join(worktree, '.cloud', file));
  await setVersion(worktree);
  await mkdir(path.join(root, 'apps/desktop/release'), { recursive: true });
  for (const target of targets) {
    if (target.build)
      await run('npx', ['tsx', 'scripts/package-desktop-release.ts', ...target.build], worktree);
    // A bundle whose signature doesn't seal its resources is reported as "damaged" once downloaded.
    if (target.key === 'mac')
      execFileSync(
        'codesign',
        ['--verify', '--deep', '--strict', 'apps/desktop/release/mac-arm64/harbor0.app'],
        { cwd: worktree, stdio: 'inherit' },
      );
    await copyFile(
      path.join(worktree, 'apps/desktop/release', target.name),
      path.join(root, 'apps/desktop/release', target.name),
    );
  }
  // A test build's version lives only on its tag: commit the bump in the worktree, off any branch.
  if (testBuild && !dryRun) {
    execFileSync('git', ['add', desktopPackage, lockfile], { cwd: worktree });
    execFileSync('git', ['commit', '-m', `chore(desktop): test build ${tag}`], { cwd: worktree });
    execFileSync('git', ['tag', '-a', tag, '-m', `harbor0 desktop test build ${version}`], {
      cwd: worktree,
    });
  }
} finally {
  git('worktree', 'remove', '--force', worktree);
  await rm(worktree, { recursive: true, force: true });
}

const installers = [];
for (const target of targets) {
  const file = path.join(root, 'apps/desktop/release', target.name);
  const bytes = (await stat(file)).size;
  const hasher = createHash('sha256');
  for await (const chunk of createReadStream(file)) hasher.update(chunk);
  installers.push({
    ...target,
    file,
    bytes,
    sha256: hasher.digest('hex'),
    url: `https://github.com/${repo}/releases/download/${tag}/${target.name}`,
  });
}

if (testBuild) {
  if (dryRun) {
    console.log(`\nDry run: built ${installers.map((i) => i.file).join(' and ')}.`);
    console.log('Nothing was tagged or published.');
    process.exit(0);
  }
  git('push', 'origin', tag);
  await publishRelease(
    installers.map((i) => i.file),
    [
      '--prerelease',
      '--title',
      `harbor0 ${version} (test build)`,
      '--notes',
      [
        `Test build of harbor0 desktop ${version}, for trying new features before they ship. Not for general use.`,
        '',
        'Test builds update themselves to newer test builds and to the next release. Released apps never update to a test build.',
        ...(linux
          ? [
              '',
              'Linux packages are x64 (AppImage, deb, rpm) and arm64 (AppImage, deb) and don’t update themselves: install newer builds from their release page. On GNOME without the AppIndicator extension there is no tray icon, so closing the window asks whether to keep syncing.',
            ]
          : []),
        '',
        ...installers.map(({ name, sha256 }) => `SHA-256 of \`${name}\`: \`${sha256}\``),
      ].join('\n'),
    ],
    ['--latest=false'],
  );
  for (const { url } of installers) {
    const response = await fetch(url, { method: 'HEAD', redirect: 'follow' });
    if (!response.ok) throw new Error(`The release download ${url} returned ${response.status}.`);
  }
  console.log(`\nReleased test build ${tag}: https://github.com/${repo}/releases/tag/${tag}`);
  for (const { platform, url } of installers) console.log(`${platform}: ${url}`);
  process.exit(0);
}

// --- Point the landing site at the new installers ---------------------------------------------
await setVersion(root);
let page = await readFile(landingPage, 'utf8');
for (const { key, bytes, url, sha256 } of installers) {
  const updated = page.replace(
    new RegExp(`const ${key}: Download \\| null = (?:null|\\{[\\s\\S]*?\\n\\});`),
    `const ${key}: Download | null = {\n  version: '${version}',\n  size: '${Math.round(bytes / 1e6)} MB',\n  url: '${url}',\n  sha256: '${sha256}',\n};`,
  );
  if (updated === page)
    throw new Error(`Could not find the \`${key}\` download in ${landingPage}.`);
  page = updated;
}
await writeFile(landingPage, page);
const manifest = {
  version,
  publishedAt: new Date().toISOString(),
  installers: installers.map(({ platform, architecture, bytes, sha256, url }) => ({
    platform,
    architecture,
    signed: false,
    sha256,
    bytes,
    url,
  })),
};

if (dryRun) {
  console.log(
    `\nDry run: built ${installers.map((i) => i.file).join(' and ')} and updated ${released.join(', ')}.`,
  );
  console.log(
    `Nothing was committed or published. Revert with: git checkout -- ${released.join(' ')}`,
  );
  process.exit(0);
}

// --- Commit, tag, release, deploy -------------------------------------------------------------
git('commit', '-m', `chore(desktop): release ${tag}`, '--', ...released);
git('tag', '-a', tag, '-m', `harbor0 desktop ${version}`);
// The tag goes first so the download exists before the landing site links to it.
git('push', 'origin', tag);
const notes = [
  `harbor0 desktop ${version} for Macs with Apple silicon, 64-bit Windows 10 and 11, and Linux.`,
  '',
  'The beta builds are not code-signed:',
  '- macOS blocks the app on first open: choose **Open Anyway** in System Settings → Privacy & Security.',
  '- Windows SmartScreen says “Windows protected your PC”: choose **More info**, then **Run anyway**.',
  '',
  'Linux: the `.deb` is for Ubuntu and Debian, the `.rpm` for Fedora, and the AppImage runs on most other distributions. `amd64`, `x86_64` and `x64` are the same build, for ordinary 64-bit Intel and AMD PCs; `arm64` is for ARM computers, including Linux VMs on Apple silicon Macs.',
  '',
  'Installed Mac and Windows apps update themselves from Settings. On Linux, install new versions from the release page.',
  '',
  ...installers.map(({ name, sha256 }) => `SHA-256 of \`${name}\`: \`${sha256}\``),
].join('\n');
await publishRelease(
  installers.map((i) => i.file),
  [
    '--title',
    `harbor0 ${version}`,
    '--notes',
    notes,
    '--generate-notes',
    ...(previousRelease ? ['--notes-start-tag', previousRelease] : []),
  ],
  ['--latest'],
);
for (const { url } of installers) {
  const response = await fetch(url, { method: 'HEAD', redirect: 'follow' });
  if (!response.ok) throw new Error(`The release download ${url} returned ${response.status}.`);
}
git('push', 'origin', 'main');
await writeFile('.cloud/desktop-release.json', JSON.stringify(manifest, null, 2) + '\n');

console.log(`\nReleased ${tag}: https://github.com/${repo}/releases/tag/${tag}`);
for (const { platform, url } of installers) console.log(`${platform}: ${url}`);
console.log('The landing site deploys from main once Validate passes.');
