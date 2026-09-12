/**
 * The double-clickable build.
 *
 * SKYLINE-FLIGHT.html is the version most people will ever open, and it is the one
 * least likely to be noticed when it breaks: it is generated, it is not what the dev
 * server serves, and the two ways it has already broken both produced a page that
 * looked fine and did nothing. So this builds it and opens it the way a person does -
 * off the disk, over file:// - and flies it.
 */
import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'SKYLINE-FLIGHT.html');
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.error(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`); }
}

console.log('\nSKYLINE FLIGHT — standalone file\n');
execFileSync('node', [path.join(ROOT, 'tools', 'build-single.mjs')], { cwd: ROOT, stdio: 'inherit' });

const size = statSync(FILE).size;
check('the build produces one file', size > 200_000, `${Math.round(size / 1024)} KB`);

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--no-sandbox', '--disable-gpu-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
         '--enable-unsafe-swiftshader', '--disable-dev-shm-usage', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message.split('\n')[0]));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 160)); });

// file:// is the whole point: no server, no module loading, no fetch.
await page.goto(`file://${FILE}`, { waitUntil: 'domcontentloaded' });
const booted = await page.waitForFunction(
  () => window.__skyline?.state && window.__skyline.state !== 'loading',
  null, { timeout: 120000 },
).then(() => true, () => false);
const boot = booted ? await page.evaluate(() => {
  const g = window.__skyline;
  return { state: g.state, buildings: g.world.cityStats.buildings, save: g.save.available,
    triangles: g.renderer.info.render.triangles };
}) : {};
check('it boots from the disk with no server', booted && boot.state === 'menu', JSON.stringify(boot));
check('the city and the renderer come up', boot.buildings > 1000 && boot.triangles > 50000, JSON.stringify(boot));

if (booted) {
  await page.evaluate(() => window.__skyline._startMission(window.__skyline.progression.recommendedMission()));
  const running = await page.waitForFunction(
    () => window.__skyline.missions.state === 'running', null, { timeout: 90000 },
  ).then(() => true, () => false);
  await page.keyboard.down('w');
  await new Promise((r) => setTimeout(r, 4000));
  await page.keyboard.up('w');
  const flying = await page.evaluate(() => ({
    speed: Math.round(window.__skyline.flight.airspeed * 3.6),
    hud: document.getElementById('hud')?.classList.contains('hidden') === false,
  }));
  check('a mission runs and the aircraft flies', running && flying.speed > 60 && flying.hud, JSON.stringify(flying));

  await page.evaluate(() => { window.__skyline.progression.data.credits = 4242; window.__skyline.save.flush(); });
  await page.reload({ waitUntil: 'domcontentloaded' });
  const reloaded = await page.waitForFunction(
    () => window.__skyline?.state && window.__skyline.state !== 'loading', null, { timeout: 120000 },
  ).then(() => true, () => false);
  const saved = reloaded ? await page.evaluate(() => window.__skyline.progression.data.credits) : null;
  check('progress survives closing and reopening the file', saved === 4242, `credits=${saved}`);
}

check('no errors on the page', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();

console.log(`\n${passed} checks passed, ${failed} failed\n`);
if (failed > 0) process.exitCode = 1;
