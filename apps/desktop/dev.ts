import { spawn, type ChildProcess } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { context, type BuildOptions } from 'esbuild';
import { bundles, prepare } from './build';
import { developmentExecutable } from './dev-runtime';

const desktop = path.dirname(fileURLToPath(import.meta.url));
process.chdir(desktop);
const executable = await developmentExecutable();
let child: ChildProcess | undefined;
let restarting = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let pending: 'reload' | 'restart' | undefined;

function launch() {
  child = spawn(executable, ['.', ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, HARBOR_DEV_RELOAD: 'true' },
    cwd: desktop,
  });
  child.on('error', (error) => {
    console.error(error.message);
    process.exit(1);
  });
  child.on('exit', (code) => {
    // Quitting the app ends development; a restart for new main-process code does not.
    if (restarting) return;
    process.exit(code ?? 1);
  });
}
async function restart() {
  const old = child;
  if (!old) return;
  restarting = true;
  // The single-instance lock is only free once the old process is gone.
  await new Promise<void>((resolve) => {
    const force = setTimeout(() => old.kill('SIGKILL'), 5000);
    old.once('exit', () => {
      clearTimeout(force);
      resolve();
    });
    old.kill('SIGTERM');
  });
  restarting = false;
  launch();
}
function changed(action: 'reload' | 'restart') {
  if (action === 'restart' || !pending) pending = action;
  clearTimeout(timer);
  // One save often rebuilds several bundles; act once they have all settled.
  timer = setTimeout(() => {
    const next = pending;
    pending = undefined;
    if (next === 'restart') {
      console.log('[dev] main process changed, restarting harbor0');
      void restart();
    } else {
      console.log('[dev] renderer changed, reloading window');
      // The main process watches this stamp and reloads its window.
      void writeFile('dist/.reload', String(Date.now()));
    }
  }, 150);
}
async function watch(options: BuildOptions, action: 'reload' | 'restart') {
  let first: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => (first = resolve));
  const builder = await context({
    ...options,
    logLevel: 'warning',
    plugins: [
      {
        name: 'harbor-dev',
        setup(build) {
          build.onEnd((result) => {
            if (first) {
              first();
              first = undefined;
            } else if (!result.errors.length) changed(action);
          });
        },
      },
    ],
  });
  await builder.watch();
  await ready;
}

await prepare();
await Promise.all([
  watch(bundles.main, 'restart'),
  watch(bundles.preload, 'restart'),
  watch(bundles.renderer, 'reload'),
]);
launch();
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    if (!child?.kill(signal)) process.exit(0);
  });
