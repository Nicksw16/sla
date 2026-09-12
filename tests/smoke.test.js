/**
 * Headless end-to-end test.
 *
 * Serves the production build, drives it in Chromium, and checks the things that
 * would make the game unshippable if they broke (spec §127-128: verify spawn,
 * controls, checkpoints, collisions, mission flow, save, loading, UI, upgrades,
 * aircraft and region changes).
 *
 * The flight section steers with real key events rather than poking the simulation,
 * because "can a keyboard actually fly this aircraft through a gate" is the question
 * worth answering. The test reads the bearing to the next checkpoint and holds the
 * keys a player would hold — it is a crude pilot, but it is a pilot.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
// The mission catalogue is pure data with no browser dependencies, so the test can
// read it directly rather than trying to discover mission ids through the DOM.
import { MISSIONS } from '../src/data/missions.js';
import { SECRETS } from '../src/data/secrets.js';
import { AIRCRAFT_ORDER, TIERS } from '../src/data/aircraft.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const SHOTS = path.join(ROOT, 'tests', '__screenshots__');

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
};

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`);
  }
}

function serve(dir) {
  const server = createServer(async (req, res) => {
    try {
      const url = decodeURIComponent(req.url.split('?')[0]);
      let file = path.join(dir, url === '/' ? 'index.html' : url);
      if (!file.startsWith(dir)) { res.writeHead(403).end(); return; }
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Bounds any interaction with the page.
 *
 * Nothing that talks to a browser tab here can be trusted to return: page.evaluate has
 * no timeout of its own, and key events queue behind the same blocked main thread. On a
 * page rendering at two frames a second either can wait indefinitely, which turns a
 * failing run into a hanging one - no output, no failure, no end. Every call goes
 * through this.
 */
function bounded(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms)),
  ]);
}

const pressKey = (page, key) => bounded(page.keyboard.press(key), 20000, `press ${key}`);
const holdKey = (page, key) => bounded(page.keyboard.down(key), 20000, `hold ${key}`);
const releaseKey = (page, key) => bounded(page.keyboard.up(key), 20000, `release ${key}`);
const evaluate = (page, fn, arg, ms = 30000) => bounded(page.evaluate(fn, arg), ms, 'page.evaluate');

/**
 * Waits for a predicate instead of sleeping a guessed number of milliseconds.
 * Under software rendering a single frame can take longer than any sleep worth
 * writing, so "press the key, sleep 250 ms, read the state" tests the renderer.
 */
async function waitFor(page, fn, arg = null, timeout = 8000) {
  try {
    await page.waitForFunction(fn, arg, { timeout });
    return true;
  } catch {
    return false;
  }
}

/** Clicks within the active screen. The same data-action appears on several screens. */
const clickActive = (page, action) => page.click(`.screen.active [data-action="${action}"]`);

/**
 * Whole-run deadline.
 *
 * The individual guards cover the calls that are known to block, but there are enough
 * interactions with the page that the only way to promise this run ends is to promise
 * it directly. A run that hangs silently is worse than one that fails: it tells you
 * nothing, and it holds everything behind it.
 */
function armDeadline(minutes) {
  const timer = setTimeout(() => {
    console.error(`\nrun exceeded its ${minutes} minute deadline`);
    console.error(`${passed} checks passed, ${failed} failed before it stalled\n`);
    process.exit(1);
  }, minutes * 60000);
  timer.unref?.();
  return timer;
}

async function main() {
  const deadline = armDeadline(Number(process.env.DEADLINE_MINUTES ?? 45));
  if (!existsSync(DIST)) {
    console.error('dist/ not found — run `npm run build` first.');
    process.exit(1);
  }
  const { server, port } = await serve(DIST);
  const base = `http://127.0.0.1:${port}/`;

  const browser = await chromium.launch({
    executablePath: CHROME,
    args: [
      '--no-sandbox', '--disable-gpu-sandbox',
      // Software WebGL: there is no GPU in this environment.
      '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
      '--disable-dev-shm-usage', '--mute-audio',
    ],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => pageErrors.push(e.message));

  console.log('\nSKYLINE FLIGHT — headless end-to-end\n');
  console.log('  loading', base);
  await page.goto(base, { waitUntil: 'domcontentloaded' });

  // ---------------------------------------------------------------- boot
  await page.waitForFunction(
    () => window.__skyline && window.__skyline.state && window.__skyline.state !== 'loading',
    null, { timeout: 120000 },
  );
  const boot = await page.evaluate(() => {
    const g = window.__skyline;
    return {
      state: g.state,
      buildings: g.world.cityStats.buildings,
      colliders: g.world.grid.count,
      aircraft: g.spec.name,
      checkpointPool: g.checkpoints.pool.length,
      hasRenderer: !!g.renderer,
      drawCalls: g.renderer.info.render.calls,
      triangles: g.renderer.info.render.triangles,
      audioReady: g.audio.ready || g.audio.failed,
      missionCount: g.ui ? undefined : undefined,
    };
  });
  check('the game boots and reaches the menu', boot.state === 'menu', `state=${boot.state}`);
  check('the city generated', boot.buildings > 1000, `${boot.buildings} buildings`);
  check('collision data generated', boot.colliders > 1000, `${boot.colliders} colliders`);
  check('an aircraft is loaded', !!boot.aircraft, boot.aircraft);
  check('the scene renders', boot.drawCalls > 0 && boot.triangles > 0,
    `${boot.drawCalls} draw calls, ${boot.triangles} triangles`);
  console.log(`       ${boot.buildings} buildings · ${boot.triangles.toLocaleString()} triangles · ${boot.drawCalls} draw calls`);

  await page.screenshot({ path: path.join(SHOTS, '01-menu.png') });

  // ---------------------------------------------------------------- menus
  await clickActive(page, 'map');
  await sleep(400);
  const map = await page.evaluate(() => ({
    active: document.getElementById('screen-map').classList.contains('active'),
    cells: document.querySelectorAll('.map-cell').length,
    locked: document.querySelectorAll('.map-cell.locked').length,
    missions: document.querySelectorAll('.mission-row').length,
  }));
  check('the map screen lists all nine districts', map.active && map.cells === 9, JSON.stringify(map));
  check('locked districts are shown as locked', map.locked > 0, `${map.locked} locked`);
  check('the selected district lists its missions', map.missions > 0, `${map.missions} rows`);
  await page.screenshot({ path: path.join(SHOTS, '02-map.png') });

  await clickActive(page, 'back');
  await sleep(250);
  await clickActive(page, 'hangar');
  await sleep(700);
  const hangar = await page.evaluate(() => ({
    active: document.getElementById('screen-hangar').classList.contains('active'),
    cards: document.querySelectorAll('.hangar-card').length,
    upgrades: document.querySelectorAll('.upgrade-row').length,
    stats: document.querySelectorAll('.stat-line').length,
    hasModel: !!window.__skyline.hangar.model,
    state: window.__skyline.state,
  }));
  check('the hangar lists every aircraft',
    hangar.active && hangar.cards === AIRCRAFT_ORDER.length, JSON.stringify(hangar));
  check('the hangar shows upgrades and stats', hangar.upgrades === 5 && hangar.stats >= 7, JSON.stringify(hangar));
  check('the hangar renders the actual aircraft model', hangar.hasModel);
  await page.screenshot({ path: path.join(SHOTS, '03-hangar.png') });

  // Paint change must reach the flown aircraft.
  await page.evaluate(() => {
    document.querySelector('.hangar-tabs [data-tab="paint"]').click();
  });
  await sleep(250);
  await page.evaluate(() => {
    document.querySelector('.paint-swatch[data-action="applyPaint"][data-paint="ember"]')?.click();
  });
  await sleep(300);
  const paint = await page.evaluate(() => window.__skyline.progression.activePaint());
  check('a livery can be applied', paint === 'ember', `paint=${paint}`);

  await clickActive(page, 'back');
  await sleep(250);
  await clickActive(page, 'settings');
  await sleep(400);
  const settings = await page.evaluate(() => ({
    active: document.getElementById('screen-settings').classList.contains('active'),
    rows: document.querySelectorAll('.setting-row').length,
  }));
  check('the settings screen renders', settings.active && settings.rows > 12, JSON.stringify(settings));

  // Changing quality must not break rendering.
  await page.evaluate(() => document.querySelector('[data-action="set"][data-key="quality"][data-value="low"]').click());
  await sleep(600);
  const afterQuality = await page.evaluate(() => ({
    quality: window.__skyline.settings.get('quality'),
    calls: window.__skyline.renderer.info.render.calls,
  }));
  check('quality can be changed at runtime', afterQuality.quality === 'low' && afterQuality.calls > 0, JSON.stringify(afterQuality));
  await page.evaluate(() => document.querySelector('[data-action="set"][data-key="quality"][data-value="high"]').click());
  await sleep(400);

  await clickActive(page, 'back');
  await sleep(250);

  // ---------------------------------------------------------------- controls
  await page.evaluate(() => window.__skyline._startMission('first-light'));
  await page.waitForFunction(() => window.__skyline.state === 'playing', null, { timeout: 30000 });
  await sleep(500);
  const spawn = await page.evaluate(() => {
    const g = window.__skyline;
    return {
      hudVisible: g.hud.visible,
      alt: g.flight.position.y,
      speed: g.flight.airspeed,
      gates: g.checkpoints.total,
      state: g.missions.state,
    };
  });
  check('a mission starts and the HUD appears', spawn.hudVisible && spawn.gates === 6, JSON.stringify(spawn));
  check('the aircraft spawns airborne and moving', spawn.alt > 100 && spawn.speed > 20, JSON.stringify(spawn));

  // Drop to the low preset for the flying sections. The renderer here is SwiftShader
  // on a CPU and runs at a couple of frames a second on the high preset; since the
  // simulation clamps dt per frame, that makes game time crawl relative to wall time.
  // Fidelity is already covered by the checks above; what follows is about behaviour.
  await page.evaluate(() => window.__skyline.settings.set('quality', 'low'));
  await sleep(1500);

  // Wait out the countdown. Three seconds of game time, but see above.
  const started = await waitFor(page, () => window.__skyline.missions.state === 'running', null, 120000);
  check('the mission countdown completes and the run starts', started,
    `mission state ${await page.evaluate(() => window.__skyline.missions.state)}`);

  // These checks assert direction, and read the control surface as well as the
  // attitude. Under software rendering the frame rate is low enough that a fixed
  // attitude threshold is a measure of the renderer, not of the controls.
  const axisCheck = async (name, key, read, expectSign, ms = 1400) => {
    const before = await evaluate(page, read);
    await holdKey(page, key);
    await sleep(ms);
    const during = await evaluate(page, read);
    await releaseKey(page, key);
    await sleep(400);
    const delta = (during.value - before.value) * expectSign;
    const deflected = during.control * expectSign;
    check(name, delta > 0.004 && deflected > 0.25,
      `value ${before.value.toFixed(3)} -> ${during.value.toFixed(3)}, surface ${during.control.toFixed(2)}`);
  };

  await axisCheck('W opens the throttle', 'w',
    () => ({ value: window.__skyline.flight.throttleCmd, control: 1 }), 1, 900);
  await axisCheck('D banks the aircraft right', 'd',
    () => ({ value: window.__skyline.flight.bank, control: window.__skyline.flight.control.roll }), 1);
  await axisCheck('A banks the aircraft left', 'a',
    () => ({ value: window.__skyline.flight.bank, control: window.__skyline.flight.control.roll }), -1);
  await axisCheck('the up arrow raises the nose', 'ArrowUp',
    () => ({ value: window.__skyline.flight.pitchAngle, control: window.__skyline.flight.control.pitch }), 1);
  await axisCheck('Q applies left rudder', 'q',
    () => ({ value: window.__skyline.flight.heading, control: window.__skyline.flight.control.yaw }), -1);

  // Level the wings again before flying the route.
  await holdKey(page, 'z');
  await sleep(1500);
  await releaseKey(page, 'z');
  const levelled = await page.evaluate(() => Math.abs(window.__skyline.flight.bank));
  check('Z levels the wings', levelled < 0.3, `bank ${levelled.toFixed(2)} rad`);

  const turbo0 = await evaluate(page, () => window.__skyline.turbo.energy);
  await holdKey(page, 'Shift');
  await sleep(900);
  await releaseKey(page, 'Shift');
  const turboState = await page.evaluate(() => ({ e: window.__skyline.turbo.energy, used: window.__skyline.turbo.totalUsed }));
  check('Shift burns turbo', turboState.e < turbo0 && turboState.used > 0,
    `${turbo0.toFixed(0)} -> ${turboState.e.toFixed(0)}`);

  await pressKey(page, 'c');
  const cycled = await waitFor(page, () => window.__skyline.cameraController.mode !== 'chase');
  const camMode = await page.evaluate(() => window.__skyline.cameraController.mode);
  check('C cycles the camera', cycled, `mode=${camMode}`);
  // Back round to the chase camera for the flying section.
  for (let i = 0; i < 3 && (await page.evaluate(() => window.__skyline.cameraController.mode)) !== 'chase'; i++) {
    await pressKey(page, 'c');
    await waitFor(page, () => true, null, 600);
    await sleep(400);
  }

  // ---------------------------------------------------------------- flying it
  console.log('\n  flying the mission with keyboard input…');
  // Generous budget: the route is about 50 s of game time, but software rendering
  // runs several times slower than real time, and the scripted pilot is not efficient.
  // FAST=1 shortens the hand-flown section when the point of the run is the rest of
  // the suite; the mission is then completed on rails below either way.
  const flightBudget = process.env.FAST === '1' ? 60000 : 480000;
  const flight = await flyMission(page, flightBudget);
  check('checkpoints can be flown through', flight.passed > 0, `${flight.passed}/${flight.total} gates`);
  const expectedGates = process.env.FAST === '1' ? 1 : 4;
  check('the route can be flown on the keyboard', flight.passed >= expectedGates,
    `${flight.passed}/${flight.total} gates flown by the scripted pilot in ${flightBudget / 1000} s`);

  // If the scripted pilot ran out of budget, fly the remainder deterministically.
  // The point of the checks below is the mission pipeline - completion, scoring,
  // grading, payout, the results screen - and that should not hinge on how well a
  // bang-bang keyboard controller polling at 12 Hz happens to do on a given run.
  // The flying itself is already evidenced by the gates above.
  let completion = flight;
  if (!flight.completed) {
    console.log('       pilot ran out of budget; completing the route on rails to exercise the pipeline');
    const railed = await page.evaluate(async () => {
      const g = window.__skyline;
      const route = g.missions.mission.route;
      // Walk the aircraft through each remaining gate along the gate's own axis, in
      // steps small enough that the real segment-crossing test is what registers it.
      for (let i = g.checkpoints.index; i < route.length; i++) {
        const cp = route[i];
        const n = g.checkpoints.checkpoints[i].normal;
        for (let t = -3; t <= 3; t++) {
          g.flight.position.set(cp.x + n.x * t * 25, cp.y + n.y * t * 25, cp.z + n.z * t * 25);
          await new Promise((r) => requestAnimationFrame(r));
        }
      }
      await new Promise((r) => setTimeout(r, 800));
      const res = g.missions.result ?? g._pendingResult?.result ?? {};
      return { completed: !!res.completed, state: g.missions.state, stars: res.stars ?? 0,
        score: res.score ?? 0, time: res.time ?? 0, passed: g.checkpoints.index, total: route.length };
    });
    completion = railed;
  }
  check('the mission completes and is graded', completion.completed,
    JSON.stringify({ state: completion.state, passed: completion.passed, total: completion.total }));
  const flightResult = completion;
  if (flightResult.completed) {
    console.log(`       finished in ${flightResult.time.toFixed(1)} s, ${flightResult.stars} star(s), `
      + `score ${Math.round(flightResult.score).toLocaleString()}`);
  }
  await page.screenshot({ path: path.join(SHOTS, '04-flying.png') });

  // ---------------------------------------------------------------- results
  await page.waitForFunction(() => window.__skyline.state === 'results', null, { timeout: 30000 }).catch(() => {});
  const results = await page.evaluate(() => {
    const g = window.__skyline;
    return {
      state: g.state,
      visible: document.getElementById('screen-results').classList.contains('active'),
      stars: document.querySelectorAll('#results-stars .star.on').length,
      rows: document.querySelectorAll('#results-rows .rr').length,
      credits: g.progression.credits,
      totalStars: g.progression.totalStars,
      saved: g.progression.data.stars['first-light'] ?? 0,
    };
  });
  check('the results screen appears', results.visible, JSON.stringify(results));
  check('stars are awarded and shown', results.stars > 0 && results.totalStars > 0, JSON.stringify(results));
  check('credits are paid out', results.credits > 0, `${results.credits} CR`);
  check('the score breakdown is itemised', results.rows >= 4, `${results.rows} rows`);
  await page.screenshot({ path: path.join(SHOTS, '05-results.png') });

  // ---------------------------------------------------------------- persistence
  const stored = await page.evaluate(() => {
    const raw = localStorage.getItem('skylineflight.save.v1');
    return raw ? JSON.parse(raw) : null;
  });
  check('progress is written to storage', !!stored && stored.credits > 0,
    stored ? `${stored.credits} CR, ${Object.keys(stored.stars).length} mission(s) starred` : 'nothing stored');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__skyline && window.__skyline.state === 'menu', null, { timeout: 120000 });
  const reloaded = await page.evaluate(() => {
    const g = window.__skyline;
    return { credits: g.progression.credits, stars: g.progression.totalStars, rating: g.progression.rating.name };
  });
  check('progress survives a reload', reloaded.credits > 0 && reloaded.stars > 0, JSON.stringify(reloaded));

  // A corrupt primary slot must fall back to the backup rather than wipe progress.
  await page.evaluate(() => localStorage.setItem('skylineflight.save.v1', '{ this is not json'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__skyline && window.__skyline.state === 'menu', null, { timeout: 120000 });
  const recovered = await page.evaluate(() => ({
    credits: window.__skyline.progression.credits,
    recovered: window.__skyline.save.recovered,
  }));
  check('a corrupt save recovers from the backup slot', recovered.credits > 0 && recovered.recovered,
    JSON.stringify(recovered));

  // ---------------------------------------------------------------- upgrades
  const upgrade = await page.evaluate(() => {
    const g = window.__skyline;
    g.progression.data.credits = 60000;
    const before = g.progression.activeSpec().maxSpeed;
    const out = g.progression.buyUpgrade('skylark', 'engine');
    g._rebuildAircraftModel();
    return { out, before, after: g.progression.activeSpec().maxSpeed, flown: g.flight.spec.maxSpeed };
  });
  check('an upgrade can be bought and reaches the flown aircraft',
    upgrade.out.ok && upgrade.after > upgrade.before && Math.abs(upgrade.flown - upgrade.after) < 0.01,
    JSON.stringify(upgrade));

  // Grant every star so the locked half of the campaign can be exercised. Granting
  // only the missions already played leaves the star total at three, and everything
  // gated above that silently refuses to start.
  const buy = await page.evaluate((ids) => {
    const g = window.__skyline;
    g.progression.data.credits = 200000;
    for (const id of ids) g.progression.data.stars[id] = 3;
    const out = g.progression.buyAircraft('vector');
    g._rebuildAircraftModel();
    return {
      out, active: g.progression.data.activeAircraft, flown: g.flight.spec.name,
      totalStars: g.progression.totalStars, rating: g.progression.rating.name,
      raceUnlocked: g.progression.isMissionUnlocked('rival-downtown'),
    };
  }, MISSIONS.map((m) => m.id));
  check('a new aircraft can be bought and becomes the flown aircraft',
    buy.out.ok !== false && buy.active === 'vector' && buy.flown.includes('VECTOR'), JSON.stringify(buy));
  check('a full star count unlocks the late campaign and the top rating',
    buy.totalStars === MISSIONS.length * 3 && buy.raceUnlocked && buy.rating === 'SKYLINE MASTER',
    JSON.stringify(buy));

  // ---------------------------------------------------------------- rival
  // The rival has its own FlightModel and has only been exercised in Node until here.
  await page.evaluate(() => window.__skyline._startMission('rival-downtown'));
  const rivalStarted = await waitFor(page, () => window.__skyline.state === 'playing', null, 30000);
  const rivalBefore = await page.evaluate(() => {
    const r = window.__skyline.missions.rival;
    return r ? { name: r.name, aircraft: r.spec.name, pos: r.position.toArray(), inScene: !!r.mesh.parent, target: r.target } : null;
  });
  check('a race mission spawns the rival', rivalStarted && !!rivalBefore && rivalBefore.inScene,
    JSON.stringify(rivalBefore));
  await waitFor(page, () => window.__skyline.missions.state === 'running', null, 120000);
  // Wait for it to actually get going. Asserting that it had already passed a gate a
  // few seconds in was measuring wall time: at these frame rates, with dt clamped per
  // frame, that is a fraction of a second of game time and it is still on the first leg.
  const rivalMoved = await waitFor(page,
    () => window.__skyline.missions.rival?.progress > 0.01, null, 120000);
  const rivalFlying = await evaluate(page, () => {
    const r = window.__skyline.missions.rival;
    const st = window.__skyline.missions.status();
    return r ? {
      progress: Number((r.progress ?? 0).toFixed(3)),
      speed: Math.round(r.flight.airspeed * 3.6),
      topSpeed: Math.round(r.spec.maxSpeed * 3.6),
      gap: st.rivalGap?.metres ?? null,
      hudVisible: !document.getElementById('hud-rival').classList.contains('hidden'),
    } : null;
  });
  // The no-cheating property: it flies, and it does not exceed its own aircraft's
  // capability. Its top speed comes from the same catalogue the player buys from.
  check('the rival flies its own aircraft under the same physics',
    !!rivalFlying && rivalMoved && rivalFlying.speed > 100
      && rivalFlying.speed <= rivalFlying.topSpeed * 1.35,
    JSON.stringify(rivalFlying));
  check('the HUD reports the gap to the rival', !!rivalFlying?.hudVisible && rivalFlying.gap !== null,
    JSON.stringify(rivalFlying));
  await page.screenshot({ path: path.join(SHOTS, '08-rival.png') });

  // ---------------------------------------------------------------- free flight
  await page.evaluate(() => window.__skyline._startFreeFlight());
  await page.waitForFunction(() => window.__skyline.state === 'playing', null, { timeout: 30000 });
  await holdKey(page, 'w');
  await sleep(2500);
  await releaseKey(page, 'w');
  const free = await page.evaluate(() => {
    const g = window.__skyline;
    return {
      freeFlight: g.missions.freeFlight,
      moving: g.flight.airspeed,
      hasTimer: g.missions.status().hasTimeLimit,
      region: g.world.regionAt(g.flight.position.x, g.flight.position.z)?.short ?? null,
      particles: g.particles.liveCount ?? 0,
    };
  });
  check('free flight runs with no clock', free.freeFlight && !free.hasTimer && free.moving > 20, JSON.stringify(free));
  await page.screenshot({ path: path.join(SHOTS, '06-freeflight.png') });

  // ---------------------------------------------------------------- pause
  await pressKey(page, 'Escape');
  const didPause = await waitFor(page, () => window.__skyline.state === 'paused');
  const paused = await page.evaluate(() => ({
    state: window.__skyline.state,
    visible: document.getElementById('screen-pause').classList.contains('active'),
  }));
  check('Escape pauses and shows the pause screen', didPause && paused.visible, JSON.stringify(paused));
  await clickActive(page, 'resume');
  const didResume = await waitFor(page, () => window.__skyline.state === 'playing');
  check('the game resumes', didResume, `state=${await page.evaluate(() => window.__skyline.state)}`);

  // ---------------------------------------------------------------- collisions
  // Point the aircraft at Skyline Tower and let the physics take it there. Waiting on
  // the hit rather than sleeping: 580 m at 110 m/s is six seconds of *game* time, which
  // is a good deal longer than that on the wall clock here.
  await page.evaluate(() => {
    const g = window.__skyline;
    window.__hits = [];
    window.__hpBefore = g.damage.hp;
    window.__offHits = g.bus.on('damage:hit', (e) => window.__hits.push({ band: e.band, damage: Math.round(e.damage) }));
    g.flight.position.set(120, 300, 520);
    g.flight.quaternion.identity();
    g.flight.airspeed = 110;
    g.flight._impactCooldown = 0;
  });
  const hitTower = await waitFor(page, () => window.__hits.length > 0, null, 120000);
  const collision2 = await page.evaluate(() => {
    window.__offHits?.();
    return { hits: window.__hits, hpBefore: window.__hpBefore, hp: window.__skyline.damage.hp };
  });
  check('flying into a building causes damage',
    hitTower && collision2.hits.length > 0 && collision2.hp < collision2.hpBefore,
    JSON.stringify(collision2).slice(0, 220));

  // ---------------------------------------------------------------- conditions
  const weatherRuns = [];
  for (const [weather, hour] of [['storm', 21], ['rain', 16], ['clear', 12.5], ['fog', 7]]) {
    const out = await page.evaluate(async ([w, h]) => {
      const g = window.__skyline;
      g.world.setConditions({ weather: w, hour: h, instant: true });
      await new Promise((r) => setTimeout(r, 900));
      return {
        weather: g.world.weather.id,
        wind: Number(g.world.weather.wind.length().toFixed(1)),
        fogFar: Math.round(g.scene.fog.far),
        night: Number(g.world.night.toFixed(2)),
        rainVisible: g.world.weather.rain.visible,
        calls: g.renderer.info.render.calls,
      };
    }, [weather, hour]);
    weatherRuns.push({ weather, ...out });
  }
  const allRendered = weatherRuns.every((r) => r.calls > 0);
  const stormy = weatherRuns.find((r) => r.weather === 'storm');
  const clear = weatherRuns.find((r) => r.weather === 'clear');
  check('every weather state renders', allRendered, JSON.stringify(weatherRuns.map((r) => r.weather)));
  check('a storm cuts visibility and raises the wind',
    stormy.fogFar < clear.fogFar && stormy.wind > clear.wind,
    `storm fog ${stormy.fogFar}m wind ${stormy.wind} vs clear fog ${clear.fogFar}m wind ${clear.wind}`);
  check('night falls', stormy.night > 0.5, `night=${stormy.night}`);
  await page.evaluate(() => window.__skyline.world.setConditions({ weather: 'storm', hour: 21.5, instant: true }));
  await sleep(1200);
  await page.screenshot({ path: path.join(SHOTS, '07-night-storm.png') });

  // ----------------------------------------------------------------- the store
  const store = await evaluate(page, () => {
    const g = window.__skyline;
    g._onUiAction('tomenu');
    g._onUiAction('store');
    // By now the run has granted every star and a pile of credits, so nothing would be
    // locked. Take them away for the reading, then give them back: the point of the
    // check is what a new player sees.
    const stars = g.progression.data.stars;
    const credits = g.progression.data.credits;
    g.progression.data.stars = {};
    g.progression.data.credits = 0;
    g.ui.renderStore();
    const poor = {
      locked: document.querySelectorAll('.store-card.locked').length,
      priced: [...document.querySelectorAll('.store-card')].some((c) => /CR/.test(c.textContent)),
    };
    g.progression.data.stars = stars;
    g.progression.data.credits = credits;
    g.ui.renderStore();
    return {
      state: g.state,
      classes: document.querySelectorAll('.store-class').length,
      cards: document.querySelectorAll('.store-card').length,
      sheetRows: document.querySelectorAll('.sd-row').length,
      bars: document.querySelectorAll('.sd-bars .stat-line').length,
      ...poor,
    };
  });
  check('the store lists the whole catalogue by class',
    store.state === 'store' && store.cards === AIRCRAFT_ORDER.length && store.classes === TIERS.length,
    JSON.stringify(store));
  check('the store shows the full specification and locks what is not earned',
    store.sheetRows >= 18 && store.bars >= 6 && store.locked > 0 && store.priced, JSON.stringify(store));

  const purchase = await evaluate(page, () => {
    const g = window.__skyline;
    const dearest = [...document.querySelectorAll('.store-card')].pop().dataset.aircraft;
    g.progression.data.credits = 400000;
    g._onUiAction('storeSelect', { aircraft: dearest });
    const before = { credits: g.progression.data.credits, owned: g.progression.data.ownedAircraft.length };
    g._onUiAction('buyStoreAircraft', { aircraft: dearest });
    return {
      dearest, before,
      credits: g.progression.data.credits,
      owned: g.progression.data.ownedAircraft.length,
      active: g.progression.data.activeAircraft,
      flownTopSpeed: Math.round(g.flight.spec.maxSpeed * 3.6),
    };
  });
  check('an aircraft can be bought in the store and is flown straight away',
    purchase.owned === purchase.before.owned + 1 && purchase.credits < purchase.before.credits
      && purchase.active === purchase.dearest && purchase.flownTopSpeed > 800, JSON.stringify(purchase));

  const swap = await evaluate(page, () => {
    const g = window.__skyline;
    g._onUiAction('storeSelect', { aircraft: 'skylark' });
    g._onUiAction('selectAircraft', { aircraft: 'skylark' });
    return { active: g.progression.data.activeAircraft, flown: g.flight.spec.name, state: g.state };
  });
  check('an owned aircraft can be flown again from the store',
    swap.active === 'skylark' && swap.flown.includes('SKYLARK') && swap.state === 'store', JSON.stringify(swap));

  // ------------------------------------------------------------- hidden beacons
  // Back into the air first: beacons are only collected while the simulation runs, and
  // the store section above left the game sitting on a menu.
  await evaluate(page, () => window.__skyline._startFreeFlight());
  await waitFor(page, () => window.__skyline.state === 'playing', null, 60000);
  // Flown to rather than teleported onto where it matters: the aircraft is placed at
  // the beacon and the proximity test has to fire on its own in the next frames.
  const beacon = await evaluate(page, async (b) => {
    const g = window.__skyline;
    const before = { found: g.progression.secretsFound, credits: g.progression.data.credits };
    g.flight.position.set(b.x, b.y, b.z);
    await new Promise((r) => setTimeout(r, 900));
    return {
      before, found: g.progression.secretsFound, credits: g.progression.data.credits,
      saved: g.progression.data.secrets.includes(b.id),
      drawn: !!g.scene.getObjectByName('secretBeacons'),
    };
  }, SECRETS[0]);
  check('a hidden beacon can be found and pays out',
    beacon.drawn && beacon.found === beacon.before.found + 1 && beacon.saved
      && beacon.credits > beacon.before.credits, JSON.stringify(beacon));

  const beaconStats = await evaluate(page, () => {
    const g = window.__skyline;
    g._onUiAction('tomenu');
    g._onUiAction('stats');
    return {
      rows: document.querySelectorAll('.beacon-row').length,
      found: document.querySelectorAll('.beacon-row.got').length,
      hinted: [...document.querySelectorAll('.beacon-hint')].every((e) => e.textContent.length > 12),
    };
  });
  check('the statistics screen lists every beacon with a hint',
    beaconStats.rows === SECRETS.length && beaconStats.found >= 1 && beaconStats.hinted,
    JSON.stringify(beaconStats));

  // ------------------------------------------------------- free flight setup
  const ffScreen = await evaluate(page, () => {
    const g = window.__skyline;
    g._onUiAction('tomenu');
    g._onUiAction('freeflight');
    g._onUiAction('ffSet', { key: 'weather', value: 'storm' });
    g._onUiAction('ffSet', { key: 'hour', value: '22' });
    return {
      state: g.state,
      title: document.getElementById('ff-title').textContent,
      weather: g.ui.freeFlight.weather,
      hour: g.ui.freeFlight.hour,
      districts: document.querySelectorAll('[data-action="ffSet"][data-key="region"]').length,
    };
  });
  check('free flight can be set up before launching',
    ffScreen.state === 'freeflight' && ffScreen.weather === 'storm' && ffScreen.hour === 22
      && ffScreen.districts >= 1, JSON.stringify(ffScreen));

  await evaluate(page, () => window.__skyline._onUiAction('ffLaunch'));
  await waitFor(page, () => window.__skyline.state === 'playing', null, 60000);
  const ffLaunched = await evaluate(page, () => ({
    weather: window.__skyline.world.weather.id,
    freeFlight: window.__skyline.missions.freeFlight,
    night: Number(window.__skyline.world.night.toFixed(2)),
  }));
  check('the chosen conditions reach the flight',
    ffLaunched.freeFlight && ffLaunched.weather === 'storm' && ffLaunched.night > 0.5,
    JSON.stringify(ffLaunched));

  // ------------------------------------------------------------- the campaign ends
  const champion = await evaluate(page, () => {
    const g = window.__skyline;
    g.progression.data.championship.completed = true;
    g.progression.data.championship.celebrated = false;
    g.state = 'results';
    g._onUiAction('tomenu');           // leaving the results goes through the celebration
    const shown = {
      state: g.state,
      visible: document.getElementById('screen-champion').classList.contains('active'),
      rows: document.querySelectorAll('#champion-rows .rr').length,
      unlocks: document.querySelectorAll('#champion-unlocks .unlock-line').length,
      celebrated: g.progression.data.championship.celebrated,
    };
    g._onUiAction('freeflight');
    shown.masterTitle = document.getElementById('ff-title').textContent;
    shown.masterDistricts = document.querySelectorAll('[data-action="ffSet"][data-key="region"]').length;
    g._onUiAction('tomenu');
    return shown;
  });
  check('winning the championship shows the celebration once',
    champion.visible && champion.state === 'champion' && champion.rows >= 5
      && champion.unlocks >= 3 && champion.celebrated, JSON.stringify(champion));
  check('being champion unlocks free flight master',
    champion.masterTitle === 'FREE FLIGHT MASTER' && champion.masterDistricts === 9,
    JSON.stringify({ title: champion.masterTitle, districts: champion.masterDistricts }));

  // ---------------------------------------------------------------- takeoff
  console.log('\n  testing takeoff from the runway…');
  // The free-flight crash above arms a respawn that fires 2.6 s later. Arm it again
  // deliberately: starting a mission has to cancel it. Left running it lands during the
  // countdown and teleports the aircraft off the runway into the air over downtown -
  // which is how this ran for one build, as an intermittent failure here.
  await evaluate(page, () => {
    const g = window.__skyline;
    g._freeFlightRespawn = 2.6;
    g._startMission('departure');
  });
  // Waiting on the spawn rather than sleeping: the mission state flips to countdown a
  // fade before the aircraft is placed, so a fixed sleep reads one or the other.
  const spawned = await waitFor(page, () => {
    const g = window.__skyline;
    return g.missions.mission?.id === 'departure' && g.flight.grounded;
  }, null, 60000);
  const takeoff = await evaluate(page, () => {
    const g = window.__skyline;
    return {
      grounded: g.flight.grounded, state: g.missions.state, name: g.missions.mission?.name,
      onRunway: g.world.isRunway(g.flight.position.x, g.flight.position.z),
      respawnPending: Number(g._freeFlightRespawn.toFixed(1)),
    };
  });
  check('a takeoff mission starts the aircraft on the ground',
    spawned && takeoff.grounded && takeoff.onRunway, JSON.stringify(takeoff));

  // The countdown is three seconds of game time, longer than the respawn it has to
  // outlive, so reaching the start of the run still on the concrete is the proof.
  await waitFor(page, () => window.__skyline.missions.state === 'running', null, 120000);
  const survived = await evaluate(page, () => {
    const g = window.__skyline;
    return {
      grounded: g.flight.grounded, respawnPending: Number(g._freeFlightRespawn.toFixed(1)),
      alt: Math.round(g.flight.position.y),
    };
  });
  check('a pending free-flight respawn cannot hijack a mission start',
    survived.grounded && survived.respawnPending === 0, JSON.stringify(survived));
  await holdKey(page, 'w');
  await sleep(9000);
  await holdKey(page, 'ArrowUp');
  await sleep(6000);
  await releaseKey(page, 'ArrowUp');
  await releaseKey(page, 'w');
  const airborne = await page.evaluate(() => ({
    grounded: window.__skyline.flight.grounded,
    alt: Math.round(window.__skyline.flight.position.y),
    speed: Math.round(window.__skyline.flight.airspeed * 3.6),
  }));
  check('the aircraft rotates and gets airborne', !airborne.grounded && airborne.alt > 20, JSON.stringify(airborne));

  // ---------------------------------------------------------------- stability
  const fps = await page.evaluate(() => Math.round(window.__skyline.fps));
  console.log(`\n       software-rendered frame rate: ${fps} fps (no GPU in this environment)`);
  check('no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 4).join(' | '));
  const realErrors = consoleErrors.filter((t) =>
    !/WebGL|SwiftShader|GPU stall|Automatic fallback|deprecated|AudioContext|fallback to software/i.test(t));
  check('no console errors', realErrors.length === 0, realErrors.slice(0, 4).join(' | '));

  clearTimeout(deadline);
  await browser.close();
  server.close();

  console.log(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
}

/**
 * Flies the loaded mission using key events only.
 *
 * Reads the bearing and elevation to the next gate each tick and holds the keys a
 * player would hold. Deliberately simple: if a controller this crude can complete the
 * first mission, the controls are not the obstacle.
 */
async function flyMission(page, budgetMs) {
  const deadline = Date.now() + budgetMs;
  const held = new Set();
  const setKeys = async (wanted) => {
    for (const k of held) if (!wanted.has(k)) { await releaseKey(page, k); held.delete(k); }
    for (const k of wanted) if (!held.has(k)) { await holdKey(page, k); held.add(k); }
  };

  let lastPassed = 0;
  let lastReport = Date.now();
  while (Date.now() < deadline) {
    let s;
    try {
      s = await evaluate(page, () => {
      const g = window.__skyline;
      const st = g.missions.status();
      if (!st.nav) {
        return { done: true, state: g.missions.state, passed: st.checkpointIndex, total: st.checkpointTotal };
      }
      const f = g.flight;
      const to = st.nav.position.clone().sub(f.position);
      const local = to.clone().applyQuaternion(f.quaternion.clone().invert());
      return {
        done: false,
        state: g.missions.state,
        passed: st.checkpointIndex,
        total: st.checkpointTotal,
        bearing: Math.atan2(local.x, -local.z),
        elevation: Math.atan2(local.y, Math.hypot(local.x, local.z)),
        bank: f.bank,
        speed: f.airspeed,
        maxSpeed: f.spec.maxSpeed,
        dist: st.nav.distance,
        agl: f.aboveGround,
        stall: f.stallFactor,
      };
      });
    } catch (err) {
      console.log(`       ${err.message}; the page is not keeping up, ending the hand-flown section`);
      break;
    }

    if (s.done || s.state === 'success' || s.state === 'failed') {
      await setKeys(new Set());
      break;
    }
    if (s.passed > lastPassed) {
      lastPassed = s.passed;
      console.log(`       gate ${s.passed}/${s.total} at ${Math.round(s.speed * 3.6)} km/h`);
    }
    // Periodic state dump, so a stalled pilot is visible rather than silent.
    if (Date.now() - lastReport > 15000) {
      lastReport = Date.now();
      console.log(`       on gate ${s.passed + 1}: ${Math.round(s.dist)} m out, `
        + `bearing ${(s.bearing * 57.3).toFixed(0)} deg, elev ${(s.elevation * 57.3).toFixed(0)} deg, `
        + `${Math.round(s.speed * 3.6)} km/h, ${Math.round(s.agl)} m agl`);
    }

    const want = new Set();
    // Roll toward a bank angle proportional to the bearing error.
    const targetBank = Math.max(-0.85, Math.min(0.85, s.bearing * 1.6));
    if (targetBank - s.bank > 0.08) want.add('d');
    else if (targetBank - s.bank < -0.08) want.add('a');
    // Pitch toward the gate. The ground reflex is deliberately tight: at 140 m it
    // fired over every tall building downtown and pulled the aircraft off the gate.
    const wantClimb = s.agl < 70 ? 0.3 : s.elevation + Math.abs(s.bank) * 0.14;
    if (wantClimb > 0.05) want.add('ArrowUp');
    else if (wantClimb < -0.06) want.add('ArrowDown');
    // Keep the throttle up, and ease off only if genuinely overspeeding into a corner.
    if (s.speed < s.maxSpeed * 0.82 || s.stall > 0.2) want.add('w');
    else if (Math.abs(s.bearing) > 0.7 && s.dist < 300) want.add('s');

    try {
      await setKeys(want);
    } catch (err) {
      console.log(`       ${err.message}; ending the hand-flown section`);
      break;
    }
    await sleep(80);
  }

  await setKeys(new Set()).catch(() => {});
  return page.evaluate(() => {
    const g = window.__skyline;
    const r = g.missions.result ?? g._pendingResult?.result ?? {};
    const st = g.missions.status();
    return {
      completed: !!r.completed,
      state: g.missions.state,
      passed: st.checkpointIndex,
      total: st.checkpointTotal,
      time: r.time ?? 0,
      stars: r.stars ?? 0,
      score: r.score ?? 0,
      reason: r.reason ?? null,
    };
  });
}

main().catch(async (err) => {
  console.error('\nsmoke test crashed:', err);
  process.exit(1);
});
