import { build, context } from 'esbuild';
import { cp, mkdir } from 'node:fs/promises';
await mkdir('media/katex', { recursive: true });
await cp('node_modules/katex/dist/katex.min.css', 'media/katex/katex.min.css');
await cp('node_modules/katex/dist/fonts', 'media/katex/fonts', { recursive: true });
const options = { entryPoints: ['src/extension.ts'], bundle: true, platform: 'node', target: 'node20', format: 'cjs', external: ['vscode'], outfile: 'dist/extension.js', sourcemap: true, logLevel: 'info' };
if (process.argv.includes('--watch')) { const ctx = await context(options); await ctx.watch(); }
else {
  await build(options);
  if (process.argv.includes('--test')) {
    await build({ ...options, entryPoints: ['test/core.test.ts', 'test/host.test.ts', 'test/live-host.test.ts', 'test/sidebar.test.ts'], outfile: undefined, outdir: 'dist-tests' });
  }
}
