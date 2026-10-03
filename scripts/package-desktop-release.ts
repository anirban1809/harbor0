import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
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
await run(
  'npx',
  [
    'electron-builder',
    `--config.electronVersion=${electron}`,
    '--publish',
    'never',
    ...process.argv.slice(2),
  ],
  'apps/desktop',
);
