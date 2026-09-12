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

// The replacement must go through a function: minified code is full of $& and $1,
// which a string replacement would treat as capture-group references and splice the
// surrounding HTML into the middle of the bundle. That produces a file that looks
// right and does not parse.
// The script moves to the end of the body rather than staying where the module tag
// was. A module is deferred by default and a plain inline script is not, so left in
// the head it would run against a document with no body yet and die reading the
// canvas it is given.
const scripts = [];
for (const [tag, href] of [...html.matchAll(/<script[^>]*src="([^"]+)"[^>]*><\/script>/g)].map((m) => [m[0], m[1]])) {
  scripts.push(safe(await read(href)));
  html = html.replace(tag, () => '');
}
for (const [tag, href] of [...html.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g)].map((m) => [m[0], m[1]])) {
  const css = await read(href);
  html = html.replace(tag, () => `<style>\n${css}\n</style>`);
}
html = html.replace(/<link[^>]*rel="modulepreload"[^>]*>\s*/g, '');
const inline = scripts.map((js) => `<script>\n${js}\n</script>`).join('\n');
html = html.includes('</body>')
  ? html.replace('</body>', () => `${inline}\n</body>`)
  : `${html}\n${inline}`;

await writeFile(OUT, html);

// A second shape of the same build, for hosting as an artifact: the host supplies the
// document wrapper, so this is the title, the styles, the body and the script with the
// outer tags taken off.
if (process.argv.includes('--artifact')) {
  const head = html.match(/<head>([\s\S]*?)<\/head>/i)?.[1] ?? '';
  const body = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? html;
  const title = head.match(/<title>[\s\S]*?<\/title>/i)?.[0] ?? '<title>Skyline Flight</title>';
  const styles = [...head.matchAll(/<style>[\s\S]*?<\/style>/gi)].map((m) => m[0]).join('\n');
  const target = process.argv[process.argv.indexOf('--artifact') + 1];
  if (!target) throw new Error('--artifact needs an output path');
  await writeFile(target, `${title}\n${styles}\n${body}\n`);
  console.log(`artifact page written to ${target}`);
}

await rm(WORK, { recursive: true, force: true });

const kb = Math.round(Buffer.byteLength(html) / 1024);
console.log(`\nSKYLINE-FLIGHT.html — ${kb} KB, one file, no install needed.`);
if (scripts.length === 0 || /src="\.?\/?assets|href="\.?\/?assets/.test(html)) {
  console.error('WARNING: the page still references an external file; it will not work offline.');
  process.exitCode = 1;
}
