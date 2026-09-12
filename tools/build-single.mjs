/**
 * Builds the whole game into one HTML file that runs by double-clicking it.
 *
 * The normal build is a page plus two scripts and a stylesheet, which a browser will
 * only load over http. Opened straight off the disk it fails on module security rules,
 * which is exactly the situation for someone who just wants to play. So this build
 * emits a classic script instead of a module, then folds the script and the stylesheet
 * into the page: one file, no server, no install, works offline.
 */
import { build } from 'vite';
import { readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORK = path.join(ROOT, '.single-build');
const OUT = path.join(ROOT, 'SKYLINE-FLIGHT.html');

await build({
  configFile: false,
  root: ROOT,
  base: './',
  logLevel: 'warn',
  build: {
    target: 'es2022',
    outDir: WORK,
    emptyOutDir: true,
    assetsInlineLimit: 0,
    cssCodeSplit: false,
    modulePreload: { polyfill: false },
    rollupOptions: {
      output: { format: 'iife', inlineDynamicImports: true, entryFileNames: 'app.js', assetFileNames: 'app[extname]' },
    },
  },
});

const read = async (href) => readFile(path.join(WORK, href.replace(/^\.?\//, '')), 'utf8');
let html = await readFile(path.join(WORK, 'index.html'), 'utf8');

// A closing script tag inside the bundle would end the inline block early.
const safe = (js) => js.replace(/<\/script/gi, '<\\/script');

for (const [tag, href] of [...html.matchAll(/<script[^>]*src="([^"]+)"[^>]*><\/script>/g)].map((m) => [m[0], m[1]])) {
  html = html.replace(tag, `<script>\n${safe(await read(href))}\n</script>`);
}
for (const [tag, href] of [...html.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g)].map((m) => [m[0], m[1]])) {
  html = html.replace(tag, `<style>\n${await read(href)}\n</style>`);
}
html = html.replace(/<link[^>]*rel="modulepreload"[^>]*>\s*/g, '');

await writeFile(OUT, html);
await rm(WORK, { recursive: true, force: true });

const kb = Math.round(Buffer.byteLength(html) / 1024);
console.log(`\nSKYLINE-FLIGHT.html — ${kb} KB, one file, no install needed.`);
if (/src="|href="\.\/assets/.test(html)) {
  console.error('WARNING: the page still references an external file; it will not work offline.');
  process.exitCode = 1;
}
