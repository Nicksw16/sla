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

async function main() {
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
  check('the hangar lists every aircraft', hangar.active && hangar.cards === 5, JSON.stringify(hangar));
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

  // Wait out the countdown, then verify each control axis does what it says.
  await page.waitForFunction(() => window.__skyline.missions.state === 'running', null, { timeout: 20000 });

  // These checks assert direction, and read the control surface as well as the
  // attitude. Under software rendering the frame rate is low enough that a fixed
  // attitude threshold is a measure of the renderer, not of the controls.
  const axisCheck = async (name, key, read, expectSign, ms = 1400) => {
    const before = await page.evaluate(read);
    await page.keyboard.down(key);
    await sleep(ms);
    const during = await page.evaluate(read);
    await page.keyboard.up(key);
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
  await page.keyboard.down('z');
  await sleep(1500);
  await page.keyboard.up('z');
  const levelled = await page.evaluate(() => Math.abs(window.__skyline.flight.bank));
  check('Z levels the wings', levelled < 0.3, `bank ${levelled.toFixed(2)} rad`);

  const turbo0 = await page.evaluate(() => window.__skyline.turbo.energy);
  await page.keyboard.down('Shift');
  await sleep(900);
  await page.keyboard.up('Shift');
  const turboState = await page.evaluate(() => ({ e: window.__skyline.turbo.energy, used: window.__skyline.turbo.totalUsed }));
  check('Shift burns turbo', turboState.e < turbo0 && turboState.used > 0,
    `${turbo0.toFixed(0)} -> ${turboState.e.toFixed(0)}`);

  await page.keyboard.press('c');
  const cycled = await waitFor(page, () => window.__skyline.cameraController.mode !== 'chase');
  const camMode = await page.evaluate(() => window.__skyline.cameraController.mode);
  check('C cycles the camera', cycled, `mode=${camMode}`);
  // Back round to the chase camera for the flying section.
  for (let i = 0; i < 3 && (await page.evaluate(() => window.__skyline.cameraController.mode)) !== 'chase'; i++) {
    await page.keyboard.press('c');
    await waitFor(page, () => true, null, 600);
    await sleep(400);
  }

  // ---------------------------------------------------------------- flying it
  console.log('\n  flying the mission with keyboard input…');
  const flight = await flyMission(page, 210000);
  check('checkpoints can be flown through', flight.passed > 0, `${flight.passed}/${flight.total} gates`);
  check('the mission completes', flight.completed, JSON.stringify({
    state: flight.state, passed: flight.passed, total: flight.total, reason: flight.reason,
  }));
  if (flight.completed) {
    console.log(`       finished in ${flight.time.toFixed(1)} s, ${flight.stars} star(s), score ${flight.score.toLocaleString()}`);
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

  const buy = await page.evaluate(() => {
    const g = window.__skyline;
    g.progression.data.credits = 200000;
    for (const m of Object.keys(g.progression.data.stars)) g.progression.data.stars[m] = 3;
    // Enough stars for the whole roster.
    const { MISSIONS } = g.__missions ?? {};
    const out = g.progression.buyAircraft('vector');
    g._rebuildAircraftModel();
    return { out, active: g.progression.data.activeAircraft, flown: g.flight.spec.name, engines: g.spec.model.engines };
  });
  check('a new aircraft can be bought and becomes the flown aircraft',
    buy.out.ok !== false && buy.active === 'vector' && buy.flown.includes('VECTOR'), JSON.stringify(buy));

  // ---------------------------------------------------------------- free flight
  await page.evaluate(() => window.__skyline._startFreeFlight());
  await page.waitForFunction(() => window.__skyline.state === 'playing', null, { timeout: 30000 });
  await page.keyboard.down('w');
  await sleep(2500);
  await page.keyboard.up('w');
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
  await page.keyboard.press('Escape');
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
  const collision2 = await page.evaluate(async () => {
    const g = window.__skyline;
    const hits = [];
    const off = g.bus.on('damage:hit', (e) => hits.push({ band: e.band, damage: Math.round(e.damage) }));
    const hpBefore = g.damage.hp;
    // Point the aircraft at Skyline Tower from close range and let physics do the rest.
    g.flight.position.set(120, 300, 520);
    g.flight.quaternion.identity();
    g.flight.airspeed = 110;
    g.flight._impactCooldown = 0;
    await new Promise((r) => setTimeout(r, 6000));
    off();
    return { hits, hpBefore, hp: g.damage.hp };
  });
  check('flying into a building causes damage',
    collision2.hits.length > 0 && collision2.hp < collision2.hpBefore,
    JSON.stringify(collision2).slice(0, 200));

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

  // ---------------------------------------------------------------- landing
  console.log('\n  testing takeoff from the runway…');
  const takeoff = await page.evaluate(async () => {
    const g = window.__skyline;
    g._startMission('departure');
    await new Promise((r) => setTimeout(r, 1200));
    return { grounded: g.flight.grounded, state: g.missions.state, name: g.missions.mission?.name };
  });
  check('a takeoff mission starts the aircraft on the ground', takeoff.grounded, JSON.stringify(takeoff));

  await page.waitForFunction(() => window.__skyline.missions.state === 'running', null, { timeout: 20000 }).catch(() => {});
  await page.keyboard.down('w');
  await sleep(9000);
  await page.keyboard.down('ArrowUp');
  await sleep(6000);
  await page.keyboard.up('ArrowUp');
  await page.keyboard.up('w');
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
    for (const k of held) if (!wanted.has(k)) { await page.keyboard.up(k); held.delete(k); }
    for (const k of wanted) if (!held.has(k)) { await page.keyboard.down(k); held.add(k); }
  };

  let lastPassed = 0;
  let lastReport = Date.now();
  while (Date.now() < deadline) {
    const s = await page.evaluate(() => {
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

    await setKeys(want);
    await sleep(80);
  }

  await setKeys(new Set());
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
