import { build } from 'esbuild';
await build({
  entryPoints: ['apps/backend/src/handler.ts'],
  outfile: 'dist/backend/index.js',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: true,
});
