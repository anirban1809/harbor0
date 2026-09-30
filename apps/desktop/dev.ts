import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { developmentExecutable } from './dev-runtime';

const child = spawn(await developmentExecutable(), ['.', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
  cwd: path.dirname(fileURLToPath(import.meta.url)),
});
child.on('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal));
