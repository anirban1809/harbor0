import { copyFile, cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { desktopConfiguration } from '../apps/desktop/src/config';
import { readOutputs } from '../infra/environment';

const output = await readOutputs('storage');
const web = await readOutputs('web').then(
  (outputs) => outputs as { WebUrl?: string },
  () => undefined,
);
const settings = {
  HARBOR_API_URL: output.ApiUrl,
  // Optional: enables the sign-in screen's account creation and password reset links.
  ...(web?.WebUrl && { HARBOR_WEB_URL: web.WebUrl }),
};
if (!desktopConfiguration(settings, true).configured)
  throw new Error('Deploy the backend before packaging a release.');
async function run(command: string, args: string[], cwd?: string) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', env: process.env });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)),
    );
  });
}
await run('npm', ['run', 'build', '-w', '@harbor/desktop']);
await writeFile('apps/desktop/dist/desktop-config.json', JSON.stringify(settings, null, 2) + '\n');
const electron = JSON.parse(await readFile('node_modules/electron/package.json', 'utf8')).version;
// The monorepo's dependency range is not a release version; use the installed runtime exactly.
const builderArgs = [
  `--config.electronVersion=${electron}`,
  '--publish',
  'never',
  ...process.argv.slice(2),
];
if (!process.argv.includes('--linux'))
  await run('npx', ['electron-builder', ...builderArgs], 'apps/desktop');
else {
  // The rpm needs rpmbuild, so Linux packages are built in electron-builder's x64 Linux image.
  // Docker can't read ~/Documents on macOS, so the app is staged in a temporary folder; it needs
  // no node_modules, since esbuild bundles everything into dist.
  const builder = JSON.parse(
    await readFile('node_modules/electron-builder/package.json', 'utf8'),
  ).version;
  const stage = await mkdtemp(path.join(os.tmpdir(), 'harbor0-linux-'));
  try {
    await cp('apps/desktop', stage, {
      recursive: true,
      filter: (source) => !/[/\\](node_modules|release)$/.test(source),
    });
    await run('docker', [
      'run',
      '--rm',
      '--platform',
      'linux/amd64',
      '-v',
      `${stage}:/app`,
      '-w',
      '/app',
      'electronuserland/builder:20',
      'npx',
      '-y',
      `electron-builder@${builder}`,
      ...builderArgs,
    ]);
    for (const file of await readdir(path.join(stage, 'release')))
      if (/-linux-.+\.(AppImage|deb|rpm)$/.test(file))
        await copyFile(path.join(stage, 'release', file), path.join('apps/desktop/release', file));
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
