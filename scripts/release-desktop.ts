// Releases the Mac desktop app on GitHub and points the landing site's download at it.
//
//   npm run release:desktop                 next patch version
//   npm run release:desktop -- minor        or major, or an exact version such as 0.2.0
//   npm run release:desktop -- --dry-run    build and update the files, but commit and publish nothing
//
// The installer is built from a clean worktree of HEAD, so uncommitted work in this checkout never
// ships. The version bump and the landing page's new link are committed together, the tag is pushed
// and the GitHub release created with the installer, and then main is pushed, which deploys the
// landing site once Validate passes.
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
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

const desktopPackage = 'apps/desktop/package.json';
const lockfile = 'package-lock.json';
const landingPage = 'apps/landing/app/apps/page.tsx';
const released = [desktopPackage, lockfile, landingPage];

// --- Checks -----------------------------------------------------------------------------------
if (git('rev-parse', '--abbrev-ref', 'HEAD') !== 'main') throw new Error('Release from main.');
const dirty = git('status', '--porcelain', '--', ...released);
if (dirty) throw new Error(`Commit or discard the changes to these files first:\n${dirty}`);
if (!dryRun) {
  git('fetch', 'origin', 'main', '--tags');
  // Local commits not yet pushed are fine; they ship with the release.
  try {
    git('merge-base', '--is-ancestor', 'origin/main', 'HEAD');
  } catch {
    throw new Error('origin/main has commits this checkout lacks; pull first.');
  }
}

const current = JSON.parse(await readFile(desktopPackage, 'utf8')).version as string;
const version = (() => {
  if (/^\d+\.\d+\.\d+$/.test(bump)) return bump;
  const [major, minor, patch] = current.split('.').map(Number);
  if (bump === 'major') return `${major + 1}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  if (bump === 'patch') return `${major}.${minor}.${patch + 1}`;
  throw new Error(`Unknown version "${bump}": use patch, minor, major or x.y.z.`);
})();
const tag = `v${version}`;
if (git('tag', '--list', tag)) throw new Error(`${tag} already exists.`);
const repo = gh('repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner');
console.log(`Releasing harbor0 desktop ${current} → ${version}${dryRun ? ' (dry run)' : ''}`);

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
const name = `harbor0-${version}-mac-arm64.dmg`;
const installer = path.join(root, 'apps/desktop/release', name);
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
  await run(
    'npx',
    ['tsx', 'scripts/package-desktop-release.ts', '--mac', 'dmg', '--arm64'],
    worktree,
  );
  // A bundle whose signature doesn't seal its resources is reported as "damaged" once downloaded.
  execFileSync(
    'codesign',
    ['--verify', '--deep', '--strict', 'apps/desktop/release/mac-arm64/harbor0.app'],
    { cwd: worktree, stdio: 'inherit' },
  );
  await mkdir(path.dirname(installer), { recursive: true });
  await copyFile(path.join(worktree, 'apps/desktop/release', name), installer);
} finally {
  git('worktree', 'remove', '--force', worktree);
  await rm(worktree, { recursive: true, force: true });
}

const bytes = (await stat(installer)).size;
const hasher = createHash('sha256');
for await (const chunk of createReadStream(installer)) hasher.update(chunk);
const sha256 = hasher.digest('hex');
const url = `https://github.com/${repo}/releases/download/${tag}/${name}`;
const size = `${Math.round(bytes / 1e6)} MB`;

// --- Point the landing site at the new installer ----------------------------------------------
await setVersion(root);
const page = await readFile(landingPage, 'utf8');
const updated = page.replace(
  /const mac = \{[\s\S]*?\n\};/,
  `const mac = {\n  version: '${version}',\n  size: '${size}',\n  url: '${url}',\n  sha256: '${sha256}',\n};`,
);
if (updated === page) throw new Error(`Could not find the \`mac\` download in ${landingPage}.`);
await writeFile(landingPage, updated);
const manifest = {
  version,
  platform: 'macOS',
  architecture: 'arm64',
  signed: false,
  notarized: false,
  sha256,
  bytes,
  url,
  publishedAt: new Date().toISOString(),
};

if (dryRun) {
  console.log(`\nDry run: built ${installer} and updated ${released.join(', ')}.`);
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
  `harbor0 desktop ${version} for Macs with Apple silicon.`,
  '',
  'The beta build is not signed with Apple, so macOS blocks it on first open: choose **Open Anyway** in System Settings → Privacy & Security.',
  '',
  `SHA-256 of \`${name}\`: \`${sha256}\``,
].join('\n');
gh(
  'release',
  'create',
  tag,
  installer,
  '--repo',
  repo,
  '--verify-tag',
  '--title',
  `harbor0 ${version}`,
  '--notes',
  notes,
  '--generate-notes',
);
const response = await fetch(url, { method: 'HEAD', redirect: 'follow' });
if (!response.ok) throw new Error(`The release download ${url} returned ${response.status}.`);
git('push', 'origin', 'main');
await writeFile('.cloud/desktop-release.json', JSON.stringify(manifest, null, 2) + '\n');

console.log(`\nReleased ${tag}: https://github.com/${repo}/releases/tag/${tag}`);
console.log(`Download: ${url}`);
console.log('The landing site deploys from main once Validate passes.');
