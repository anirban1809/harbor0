import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
const root = process.cwd();
const stage = path.join(root, '.cloud/web-export');
await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
for (const dir of ['app', 'components', 'lib', 'workers']) {
  const source = path.join(root, 'apps/web', dir);
  await cp(source, path.join(stage, dir), {
    recursive: true,
    filter: (file) => file !== path.join(root, 'apps/web/app/api'),
  });
}
await cp('apps/web/package.json', path.join(stage, 'package.json'));
// The isolated export needs the same Tailwind processing as the normal web build.
await cp('apps/web/postcss.config.mjs', path.join(stage, 'postcss.config.mjs'));
const tsconfig = JSON.parse(await readFile('apps/web/tsconfig.json', 'utf8'));
tsconfig.compilerOptions.paths = {
  '@harbor/contracts': [path.join(root, 'packages/contracts/src/index.ts')],
  '@harbor/api-client': [path.join(root, 'packages/api-client/src/index.ts')],
};
await writeFile(path.join(stage, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2));
await writeFile(
  path.join(stage, 'next.config.mjs'),
  `export default ${JSON.stringify({
    output: 'export',
    transpilePackages: ['@harbor/contracts', '@harbor/api-client'],
    images: { unoptimized: true },
    turbopack: { root },
  })};\n`,
);
await new Promise<void>((resolve, reject) => {
  const child = spawn(
    process.execPath,
    [path.join(root, 'node_modules/next/dist/bin/next'), 'build'],
    {
      cwd: stage,
      stdio: 'inherit',
      env: { ...process.env, NODE_ENV: 'production' },
    },
  );
  child.on('error', reject);
  child.on('exit', (code) =>
    code === 0 ? resolve() : reject(new Error(`Static web build exited ${code}`)),
  );
});
const chunks = path.join(stage, 'out/_next/static/chunks');
const styles = (
  await Promise.all(
    (await readdir(chunks))
      .filter((name) => name.endsWith('.css'))
      .map((name) => readFile(path.join(chunks, name), 'utf8')),
  )
).join('\n');
if (
  /@(?:theme|tailwind|source|custom-variant)\b/.test(styles) ||
  !['.sr-only', '.bg-primary', '.rounded-md', '.p-5'].every((selector) => styles.includes(selector))
) {
  throw new Error(
    'Static export is missing compiled Tailwind styles. Check the staged PostCSS configuration before publishing.',
  );
}
console.log('Static export ready at .cloud/web-export/out. Browser APIs are served by Lambda.');
