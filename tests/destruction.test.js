/**
 * Physical destruction of the landmark towers.
 *
 * Every test here drives the real towers - the ones createLandmarks() raises, at the
 * size and strength the game ships - through the real collision grid, so what is
 * being checked is the shipped configuration and not a fixture that happens to
 * behave. Runs in plain Node: none of the destruction system needs a GPU.
 */
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { ObstacleGrid } from '../src/world/CityGenerator.js';
import { createLandmarks } from '../src/world/Landmarks.js';
import { DESTRUCTION, DestructionField, MODULE_STATE, makeImpact } from '../src/world/Destructible.js';
import { DebrisField } from '../src/fx/Debris.js';
import { EventBus } from '../src/core/EventBus.js';
import { LANDMARKS } from '../src/data/regions.js';
import { AIRCRAFT, AIRCRAFT_ORDER } from '../src/data/aircraft.js';
import { terrainHeight } from '../src/world/Terrain.js';

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}\n       ${err.message}`);
    process.exitCode = 1;
  }
}

// The aircraft the tests fly, taken from the catalogue rather than invented: the
// slowest thing the player can own, something from the middle, and the fastest. What
// is being checked is that the shipped aircraft do the right thing to the shipped
// towers - a test against made-up numbers would have gone on passing while flying the
// starter into a tower did nothing at all, which is exactly what happened.
const TRAINER = { speed: AIRCRAFT.skylark.maxSpeed, mass: AIRCRAFT.skylark.mass };
const MIDTIER = { speed: AIRCRAFT.talon.maxSpeed, mass: AIRCRAFT.talon.mass };
const FASTEST = { speed: AIRCRAFT.aurora.maxSpeed, mass: AIRCRAFT.aurora.mass };
const throttled = (craft, frac) => ({ speed: craft.speed * frac, mass: craft.mass });

const TWINS = LANDMARKS.find((l) => l.type === 'twins');
const H = TWINS.height;
const A = H * 0.076;                      // half-width of a shaft
const OFFSET = A + (A * 1.5) * 0.5;       // shaft centre from the pair's centre
const BASE = terrainHeight(TWINS.x, TWINS.z);
const GROUND = (x, z) => terrainHeight(x, z);

/** A world with the real landmarks in it, fresh for every test. */
function world() {
  const grid = new ObstacleGrid();
  const landmarks = createLandmarks(grid);
  const bus = new EventBus();
  const events = [];
  for (const type of ['structure:impact', 'structure:detach', 'structure:landed', 'structure:collapse']) {
    bus.on(type, (e) => events.push({ type, ...e }));
  }
  const field = new DestructionField({ bus });
  for (const b of landmarks.userData.destructibles) field.add(b);
  return { grid, landmarks, field, bus, events, towers: landmarks.userData.destructibles };
}

const DIRS = {
  west: new THREE.Vector3(1, 0, 0), east: new THREE.Vector3(-1, 0, 0),
  north: new THREE.Vector3(0, 0, 1), south: new THREE.Vector3(0, 0, -1),
};

/**
 * Flies something into a tower the way FlightModel would: put a point inside the
 * shaft, ask the collision grid what it hit, and hand the answer to the field. That
 * keeps the whole route under test - grid registration, the `ref` back-pointer and
 * the damage - rather than calling applyImpact() directly.
 */
function fly(w, {
  tower = 0, face = 'west', y = BASE + H * 0.5, speed = 200, mass = 1,
  lat = 0.45, required = true,
}) {
  const tx = TWINS.x + (tower === 0 ? -OFFSET : OFFSET);
  const dir = DIRS[face];
  // Just inside the face it is flying at, offset across it so the hit lands in one
  // column of cells rather than exactly on the seam between two.
  const pos = (face === 'west' || face === 'east')
    ? new THREE.Vector3(tx, y, TWINS.z + A * lat).addScaledVector(dir, -(A - 4))
    : new THREE.Vector3(tx + A * lat, y, TWINS.z).addScaledVector(dir, -(A - 4));
  const hit = w.grid.sample(pos, 6, null);
  if (!hit) {
    assert.ok(!required, 'the collision grid should report the tower at this point');
    return { broke: 0, absorbed: 0, miss: true };
  }
  return w.field.impact({
    point: hit.point, normal: hit.normal, direction: dir, ref: hit.ref, speed, mass,
  });
}

/** Flies a tower's base out from every side until it has nothing left to stand on. */
function levelTheBase(w, tower = 0) {
  const t = w.towers[tower];
  const y = t.origin.y + (t.height / t.levels) * 0.5;
  for (const lat of [-0.45, 0, 0.45]) {
    for (const face of ['west', 'east', 'north', 'south']) {
      if (!t.standing) return;
      fly(w, { tower, face, y, ...FASTEST, lat, required: false });
    }
  }
}

const counts = (t) => {
  const n = { intact: 0, damaged: 0, gone: 0 };
  for (const m of t.modules) {
    if (m.state === MODULE_STATE.INTACT) n.intact++;
    else if (m.intact) { n.intact++; n.damaged++; }
    else n.gone++;
  }
  return n;
};

/** Runs the simulation until nothing is moving, or the budget runs out. */
function settle(w, seconds = 40, dt = 1 / 60) {
  const focus = new THREE.Vector3(TWINS.x, BASE + H * 0.5, TWINS.z + 300);
  let steps = 0;
  for (let t = 0; t < seconds; t += dt) {
    w.field.update(dt, focus, GROUND);
    steps++;
    if (!w.field.anyActive) break;
  }
  return steps;
}

console.log('\nDestruction');

// --- structure ------------------------------------------------------------------
test('the towers are built as a lattice of structural modules', () => {
  const w = world();
  assert.equal(w.towers.length, 2, 'both towers are destructible');
  for (const t of w.towers) {
    assert.equal(t.modules.length, t.levels * t.cells * t.cells);
    assert.ok(t.modules.length >= 32, `${t.name} has enough modules to break up`);
    assert.equal(t.standing, true);
    assert.equal(t.integrity, 1);
  }
});

test('the two towers share one description and differ only in position', () => {
  const w = world();
  const [west, east] = w.towers;
  assert.equal(west.modules.length, east.modules.length);
  assert.equal(west.height, east.height);
  assert.deepEqual(west.moduleSize.toArray(), east.moduleSize.toArray());
  assert.ok(Math.abs(west.origin.x - east.origin.x) > A, 'they stand apart');
  assert.equal(west.origin.z, east.origin.z);
});

test('every module is registered in the collision grid and knows its own module', () => {
  const w = world();
  for (const t of w.towers) {
    for (const m of t.modules) {
      assert.ok(m.colliderIndex >= 0, 'module has a collider');
      assert.equal(w.grid.boxes[m.colliderIndex].ref, m, 'the collider points back at it');
    }
  }
});

test('an intact tower fills the same footprint it always did', () => {
  const w = world();
  const t = w.towers[0];
  let minX = Infinity, maxX = -Infinity, top = -Infinity, bottom = Infinity;
  for (const m of t.modules) {
    minX = Math.min(minX, m.centre.x - m.size.x * 0.5);
    maxX = Math.max(maxX, m.centre.x + m.size.x * 0.5);
    top = Math.max(top, m.centre.y + m.size.y * 0.5);
    bottom = Math.min(bottom, m.centre.y - m.size.y * 0.5);
  }
  assert.ok(Math.abs((maxX - minX) - A * 2) < 0.01, 'full width');
  assert.ok(Math.abs((top - bottom) - H) < 0.01, 'full height');
  assert.ok(Math.abs(bottom - BASE) < 0.01, 'starts at the ground');
});

test('the modules are drawn as instances of one mesh, so a tower is one draw call', () => {
  const w = world();
  for (const t of w.towers) {
    assert.equal(t.shell.mesh.isInstancedMesh, true);
    assert.equal(t.shell.mesh.count, t.modules.length);
  }
});

// --- TESTE 1-3: impact strength against speed -----------------------------------
test('TESTE 1 - a slow impact marks the facade and brings nothing down', () => {
  const w = world();
  const t = w.towers[0];
  fly(w, { ...throttled(TRAINER, 0.4) });
  const n = counts(t);
  assert.equal(n.gone, 0, 'nothing comes away');
  assert.ok(n.damaged > 0, 'but the structure is marked');
  assert.ok(t.integrity < 1 && t.integrity > 0.97, `integrity ${t.integrity}`);
  assert.equal(t.standing, true);
});

test('every aircraft in the game breaks the tower it flies into', () => {
  // The one that matters. The first calibration of this system was set for an
  // airframe heavier and faster than anything the player owns, so the aircraft you
  // actually start the game in delivered an eighth of what a single module can take:
  // you flew into a four-hundred-metre tower at full throttle and it scuffed. Every
  // test in this file passed. This is the one that would not have.
  const report = [];
  for (const id of AIRCRAFT_ORDER) {
    const a = AIRCRAFT[id];
    const w = world();
    const t = w.towers[0];
    const r = fly(w, { y: BASE + H * 0.5, speed: a.maxSpeed, mass: a.mass });
    const gone = counts(t).gone;
    report.push(`${a.name} ${gone}`);
    assert.ok(r.broke >= 1,
      `${a.name} at ${a.maxSpeed} m/s broke nothing (${report.join(', ')})`);
    assert.ok(gone >= 1, `${a.name} left nothing missing`);
    assert.equal(t.standing, true, `${a.name} should not fell a tower in one pass`);
  }
  console.log(`       modules lost to one flat-out pass: ${report.join(' · ')}`);
});

test('the same aircraft flown gently only scars it', () => {
  for (const id of AIRCRAFT_ORDER) {
    const a = AIRCRAFT[id];
    const w = world();
    const t = w.towers[0];
    // A third of top speed is a cruise, not a strike.
    fly(w, { y: BASE + H * 0.5, speed: a.maxSpeed / 3, mass: a.mass });
    assert.ok(t.integrity < 1, `${a.name} left no mark at all`);
  }
});

test('a module that is hit but not broken is visibly scarred', () => {
  const w = world();
  const t = w.towers[0];
  const colours = t.shell.mesh.instanceColor;
  assert.ok(colours, 'the shell carries a per-instance colour');
  const version = colours.version;
  for (let i = 0; i < t.modules.length * 3; i++) {
    assert.equal(colours.array[i], 1, 'an intact tower is untinted everywhere');
  }
  fly(w, { ...throttled(TRAINER, 0.7) });
  const marked = t.modules.filter((m) => m.intact && m.damage > 0);
  assert.ok(marked.length > 0);
  for (const m of marked) {
    assert.ok(colours.array[m.visual * 3] < 1, `module ${m.level}/${m.cell} shows it`);
  }
  assert.ok(colours.version > version, 'and the change is uploaded, once');
});

test('TESTE 2 - a moderate impact damages without punching through', () => {
  const w = world();
  const t = w.towers[0];
  fly(w, { ...throttled(TRAINER, 0.7) });
  const n = counts(t);
  assert.ok(n.damaged >= 2, `${n.damaged} modules damaged`);
  assert.ok(t.integrity < 0.99, 'measurably weaker');
  assert.equal(t.standing, true);
});

test('TESTE 3 - a fast impact punches a hole through the facade', () => {
  const w = world();
  const t = w.towers[0];
  const r = fly(w, { ...MIDTIER });
  assert.ok(r.broke >= 1, `${r.broke} modules broken outright`);
  const n = counts(t);
  assert.ok(n.gone >= 1, 'there is a hole');
  assert.ok(n.intact > t.modules.length * 0.5, 'but most of it is still there');
  assert.equal(t.standing, true, 'a single hit does not fell a tower');
});

test('impact strength rises with energy and then stops rising', () => {
  const p = new THREE.Vector3();
  const slow = makeImpact({ position: p, speed: 60, mass: 1 });
  const fast = makeImpact({ position: p, speed: 200, mass: 1 });
  const absurd = makeImpact({ position: p, speed: 4000, mass: 4 });
  assert.ok(fast.strength > slow.strength * 5, 'energy goes as the square of speed');
  assert.equal(absurd.strength, DESTRUCTION.ENERGY_CEILING, 'and is capped');
  assert.ok(makeImpact({ position: p, speed: 200, mass: 1.4 }).strength > fast.strength,
    'a heavier aircraft hits harder at the same speed');
});

// --- TESTE 4-6: geometry of the hit ---------------------------------------------
test('TESTE 4 - a frontal hit takes out the columns it struck and nothing else', () => {
  const w = world();
  const t = w.towers[0];
  const y = BASE + H * 0.5;
  const r = fly(w, { face: 'west', y, ...FASTEST });
  const broken = t.modules.filter((m) => !m.intact);
  assert.ok(r.broke >= 2, `${r.broke} modules broken by the blast itself`);
  assert.ok(broken.length > r.broke, 'and more came away with them');
  for (const m of broken) {
    assert.ok(m.centre.x <= t.origin.x + 0.01, 'all of it on the side that was hit');
    assert.ok(m.centre.y > y - t.moduleSize.y * 2,
      'and nothing below the hit, because nothing below it lost its support');
  }
  // The far column never hears about it - not even from the fastest jet in the game.
  const far = t.modules.filter((m) => m.centre.x > t.origin.x + t.moduleSize.x * 0.5);
  assert.ok(far.length > 0);
  assert.ok(far.every((m) => m.intact && m.integrity > 0.5), 'the far column stands');
});

test('TESTE 5 - a lateral hit damages the face it came in through', () => {
  const w = world();
  const t = w.towers[0];
  fly(w, { face: 'north', ...FASTEST });
  const broken = t.modules.filter((m) => !m.intact);
  assert.ok(broken.length > 0);
  assert.ok(broken.every((m) => m.centre.z <= t.origin.z + 0.01), 'the struck face gave way');
  const far = t.modules.filter((m) => m.centre.z > t.origin.z + t.moduleSize.z * 0.5);
  assert.ok(far.every((m) => m.intact && m.integrity > 0.5), 'the opposite face stands');
});

test('TESTE 6 - the same hit is survivable low down and not high up', () => {
  const low = world();
  const high = world();
  fly(low, { y: BASE + H * 0.06, ...TRAINER });
  fly(high, { y: BASE + H * 0.75, ...TRAINER });
  const lowLost = counts(low.towers[0]).gone;
  const highLost = counts(high.towers[0]).gone;
  assert.equal(lowLost, 0, 'the thick storeys at the bottom shrug it off');
  assert.ok(highLost > 0, 'the same blow higher up goes through');
  assert.ok(counts(low.towers[0]).damaged > 0, 'they are still marked by it');
});

test('TESTE 6 - the other tower is untouched by a hit on the first', () => {
  const w = world();
  fly(w, { tower: 0, speed: 260, mass: 1.4 });
  assert.equal(counts(w.towers[1]).gone, 0);
  assert.equal(w.towers[1].integrity, 1, 'not a scratch');
});

// --- TESTE 7-9: accumulation, partial loss, propagation -------------------------
test('TESTE 7 - damage accumulates until the facade finally gives way', () => {
  const w = world();
  const t = w.towers[0];
  // The trainer at half throttle: one pass does almost nothing, and the point is that
  // the almost-nothing is kept.
  const seen = [];
  let brokeOn = 0;
  for (let i = 1; i <= 10 && !brokeOn; i++) {
    const r = fly(w, { y: BASE + H * 0.5, ...throttled(TRAINER, 0.5) });
    seen.push(+t.integrity.toFixed(4));
    if (counts(t).gone > 0) brokeOn = i;
  }
  for (let i = 1; i < seen.length; i++) {
    assert.ok(seen[i] < seen[i - 1], `pass ${i + 1} did further damage (${seen.join(' > ')})`);
  }
  assert.ok(brokeOn >= 3, `a half-throttle pass needs repeating (${brokeOn})`);
  assert.ok(brokeOn <= 10, 'but it does get through in the end');
});

test('TESTE 8 - a tower survives losing part of itself', () => {
  const w = world();
  const t = w.towers[0];
  fly(w, { y: BASE + H * 0.55, speed: 250, mass: 1.4 });
  const n = counts(t);
  assert.ok(n.gone > 0 && n.intact > 0, `partial: ${n.gone} gone, ${n.intact} standing`);
  assert.equal(t.standing, true);
  assert.equal(t.collapsed, false);
  // Everything still standing can trace a path to the ground.
  const reachable = t._reachableFromGround();
  for (const m of t.modules) {
    if (m.intact) assert.ok(reachable.has(m), 'nothing is left floating');
  }
});

test('TESTE 9 - a whole storey lost takes everything above it and nothing below', () => {
  const w = world();
  const t = w.towers[0];
  const level = 5;
  const above = t.modules.filter((m) => m.level > level).length;
  const below = t.modules.filter((m) => m.level < level).length;
  // Remove the storey outright and let the structure work out the consequences.
  // Nothing above it can trace a path to the ground any more, and only the flood
  // fill can notice that - the local support rule alone would leave it floating.
  for (const m of t.levelModules(level)) t._detach(m, null);
  t.settleStructure(null);
  const lostAbove = t.modules.filter((m) => m.level > level && !m.intact).length;
  const keptBelow = t.modules.filter((m) => m.level < level && m.intact).length;
  assert.equal(lostAbove, above, `everything above the cut came away (${lostAbove}/${above})`);
  assert.equal(keptBelow, below, `and everything under it stayed (${keptBelow}/${below})`);
  assert.equal(t.standing, true);
});

test('TESTE 9 - a single missing module leaves a hole, not a shear', () => {
  const w = world();
  const t = w.towers[0];
  t._detach(t.at(5, 0, 0), null);
  t.settleStructure(null);
  assert.equal(counts(t).gone, 1, 'its neighbours carry it and nothing else moves');
});

test('TESTE 9 - losing two columns under a corner shears that corner off', () => {
  const w = world();
  const t = w.towers[0];
  const level = 5;
  t._detach(t.at(level, 0, 0), null);
  t._detach(t.at(level, 0, 1), null);
  t.settleStructure(null);
  const gone = counts(t).gone;
  // Two columns, from the cut to the roof: the failure climbs because each storey's
  // neighbours have lost their own support too, which is the whole propagation rule.
  assert.equal(gone, 2 * (t.levels - level), `${gone} modules came away`);
  for (const m of t.modules.filter((x) => x.level < level)) {
    assert.equal(m.intact, true, 'and the structure below is untouched');
  }
});

test('TESTE 9 - an untouched tower never loses a module on its own', () => {
  const w = world();
  const t = w.towers[1];
  t.settleStructure(null);
  assert.equal(counts(t).gone, 0, 'a settle pass on an intact tower changes nothing');
});

// --- TESTE 10: collapse ----------------------------------------------------------
test('TESTE 10 - cutting the tower off at the ankles brings the whole thing down', () => {
  const w = world();
  const t = w.towers[0];
  levelTheBase(w, 0);
  assert.equal(t.standing, false, 'nothing is left holding it up');
  assert.equal(t.collapsed, true);
  assert.ok(w.events.some((e) => e.type === 'structure:collapse'), 'and it said so');
  assert.equal(w.towers[1].standing, true, 'its twin is still there');
});

test('TESTE 10 - the roof cap and the skybridge come down with the structure', () => {
  const w = world();
  const t = w.towers[0];
  const roof = t.props.find((p) => p.supports[0].level === t.levels - 1);
  const bridge = t.props.find((p) => p !== roof);
  assert.ok(roof && bridge, 'both props are registered');
  assert.equal(roof.fallen, false);
  assert.equal(bridge.fallen, false);
  levelTheBase(w, 0);
  assert.equal(roof.fallen, true, 'the roof has nothing under it');
  assert.equal(bridge.fallen, true, 'and one end of the bridge is gone');
});

test('a collapsed tower stops being something to fly into', () => {
  const w = world();
  const t = w.towers[0];
  levelTheBase(w, 0);
  settle(w);
  const probe = new THREE.Vector3(t.origin.x, t.origin.y + H * 0.8, t.origin.z);
  assert.equal(w.grid.sample(probe, 8, null), null, 'the air where it stood is open');
  const twin = w.towers[1];
  const stillThere = new THREE.Vector3(twin.origin.x, twin.origin.y + H * 0.8, twin.origin.z);
  assert.ok(w.grid.sample(stillThere, 8, null), 'its twin still blocks the way');
});

// --- physics ---------------------------------------------------------------------
test('detached modules fall, land on the ground and go to sleep', () => {
  const w = world();
  const t = w.towers[0];
  levelTheBase(w, 0);
  const airborne = t.falling.slice();
  assert.ok(airborne.length > 8, `${airborne.length} bodies in the air`);
  const startY = airborne.map((m) => m.centre.y);
  settle(w);
  for (let i = 0; i < airborne.length; i++) {
    const m = airborne[i];
    assert.ok(m.centre.y < startY[i] + 1, 'it went down, not up');
    assert.ok(m.velocity.length() < 0.01, 'and stopped moving');
    assert.ok(m.centre.y >= GROUND(m.centre.x, m.centre.z) - 0.01, 'never through the floor');
    assert.ok([MODULE_STATE.SETTLED, MODULE_STATE.DESTROYED].includes(m.state), m.state);
  }
});

test('wreckage piles on the stump instead of falling through it', () => {
  const w = world();
  const t = w.towers[0];
  // Take one module out high up and let the column above it come down. Everything
  // below is untouched, so none of it may end up at street level.
  const level = 12;
  for (const m of [t.at(level, 0, 0), t.at(level, 0, 1)]) t._detach(m, null);
  t.settleStructure(null);
  const dropped = t.falling.slice();
  assert.ok(dropped.length >= 4);
  settle(w);
  const stumpTop = t.origin.y + level * (t.height / t.levels);
  for (const m of dropped) {
    assert.ok(m.centre.y > stumpTop,
      `a slab came to rest at ${(m.centre.y - t.origin.y).toFixed(0)} m, under a stump `
      + `${(stumpTop - t.origin.y).toFixed(0)} m tall`);
  }
});

test('the collision grid is a floor as well as a wall', () => {
  // What a falling slab lands on. The grid is asked for the highest surface *under*
  // the body, so a slab shed at storey twelve comes to rest on the first roof it
  // meets rather than dropping through every building between it and the street.
  const grid = new ObstacleGrid();
  grid.add(-10, 10, -10, 10, 0, 100, 'building');     // a tall one
  grid.add(-10, 10, -10, 10, 0, 40, 'building');      // a short one at the same spot
  assert.equal(grid.surfaceBelow(0, 0, Infinity), 100, 'the roof of the tall one');
  assert.equal(grid.surfaceBelow(0, 0, 90), 40, 'from below its roof, the short one');
  assert.equal(grid.surfaceBelow(0, 0, 20), -Infinity, 'from below both, nothing');
  assert.equal(grid.surfaceBelow(500, 500, Infinity), -Infinity, 'open ground');
  grid.remove(0);
  assert.equal(grid.surfaceBelow(0, 0, Infinity), 40, 'a demolished roof stops holding');
});

test('a falling slab comes to rest on the roof under it', () => {
  const w = world();
  const t = w.towers[0];
  const m = t.at(12, 0, 0);
  t._detach(m, null);
  m.velocity.set(-45, 14, -45);                       // thrown clear of the tower
  // A neighbouring roof at 120 m, standing everywhere the tower does not.
  const roofY = t.origin.y + 120;
  const overTower = (x, z) => Math.abs(x - t.origin.x) < t.width * 0.5
    && Math.abs(z - t.origin.z) < t.depth * 0.5;
  const ground = (x, z, ceiling = Infinity) => Math.max(
    GROUND(x, z),
    !overTower(x, z) && roofY <= ceiling ? roofY : -Infinity,
  );
  for (let i = 0; i < 60 * 30 && m.state !== MODULE_STATE.SETTLED; i++) {
    t.update(1 / 60, ground, null, true);
  }
  assert.equal(m.state, MODULE_STATE.SETTLED);
  const floor = ground(m.centre.x, m.centre.z) + m.size.y * 0.5;
  assert.ok(Math.abs(m.centre.y - floor) < 0.5,
    `rested at ${m.centre.y.toFixed(1)}, surface under it ${floor.toFixed(1)}`);
});

test('a slab that misses the building entirely lands in the street', () => {
  const w = world();
  const t = w.towers[0];
  const m = t.at(10, 0, 0);
  t._detach(m, null);
  // Throw it clear of the footprint.
  m.velocity.set(-60, 4, -60);
  settle(w);
  assert.ok(Math.abs(m.centre.x - t.origin.x) > t.width * 0.5, 'it went over the edge');
  const street = GROUND(m.centre.x, m.centre.z) + m.size.y * 0.5;
  assert.ok(Math.abs(m.centre.y - street) < 0.5, `rested at ${m.centre.y}, street ${street}`);
});

test('a settled pile is eventually cleared away', () => {
  const w = world();
  const t = w.towers[0];
  fly(w, { ...FASTEST });
  const dropped = t.falling.length;
  assert.ok(dropped > 0);
  settle(w, DESTRUCTION.SETTLED_LIFETIME + 25);
  assert.equal(t.falling.length, 0, 'the street is clear again');
});

test('nothing is simulated when the player is too far away to see it', () => {
  const w = world();
  const t = w.towers[0];
  fly(w, { ...FASTEST });
  const far = new THREE.Vector3(
    TWINS.x + DESTRUCTION.PHYSICS_ACTIVATION_DISTANCE + 500, 400, TWINS.z);
  w.field.update(1 / 60, far, GROUND);
  for (const m of t.falling) {
    assert.equal(m.state, MODULE_STATE.SETTLED, 'put straight on the ground');
    assert.ok(Math.abs(m.centre.y - (GROUND(m.centre.x, m.centre.z) + m.size.y * 0.5)) < 0.01);
  }
});

test('no more modules are ever simulated than the budget allows', () => {
  const w = world();
  for (let i = 0; i < w.towers.length; i++) {
    const t = w.towers[i];
    levelTheBase(w, i);
    assert.ok(t.falling.length <= DESTRUCTION.MAX_PHYSICAL_MODULES,
      `${t.falling.length} in flight, budget ${DESTRUCTION.MAX_PHYSICAL_MODULES}`);
  }
});

// --- TESTE 11: debris -------------------------------------------------------------
test('TESTE 11 - breaking a module throws debris, within its own budget', () => {
  const scene = new THREE.Scene();
  const debris = new DebrisField({ scene, settings: { preset: { particles: 1 } } });
  const grid = new ObstacleGrid();
  const landmarks = createLandmarks(grid);
  const field = new DestructionField({ debris });
  for (const b of landmarks.userData.destructibles) field.add(b);
  const w = { grid, field, towers: landmarks.userData.destructibles };

  assert.equal(debris.liveCount, 0);
  fly(w, { ...FASTEST });
  debris.update(1 / 60, new THREE.Vector3(TWINS.x, BASE, TWINS.z + 200), GROUND);
  assert.ok(debris.liveCount > 0, 'chunks in the air');

  // Far more than the pool holds, repeatedly: it must never overflow.
  for (let i = 0; i < 60; i++) {
    debris.burst(new THREE.Vector3(TWINS.x, BASE + 200, TWINS.z), new THREE.Vector3(20, 20, 20), 20, 10);
  }
  debris.update(1 / 60, new THREE.Vector3(TWINS.x, BASE, TWINS.z + 200), GROUND);
  assert.ok(debris.liveCount <= debris.capacity, `${debris.liveCount} > ${debris.capacity}`);
});

test('TESTE 11 - debris falls to the street and is recycled', () => {
  const scene = new THREE.Scene();
  const debris = new DebrisField({ scene, settings: { preset: { particles: 1 } } });
  const focus = new THREE.Vector3(TWINS.x, BASE + 50, TWINS.z + 200);
  debris.burst(new THREE.Vector3(TWINS.x, BASE + 300, TWINS.z), new THREE.Vector3(20, 20, 20), 24, 9);
  const live = debris.liveCount;
  assert.ok(live > 0);
  let lowest = Infinity;
  for (let t = 0; t < 14; t += 1 / 60) {
    debris.update(1 / 60, focus, GROUND);
    for (let i = 0; i < debris.capacity; i++) {
      if (debris.alive[i]) lowest = Math.min(lowest, debris.position[i * 3 + 1]);
    }
  }
  assert.ok(lowest < BASE + 300, 'it came down');
  assert.ok(lowest >= GROUND(TWINS.x, TWINS.z) - 1, 'and stopped at the street');
  for (let t = 0; t < 26; t += 1 / 60) debris.update(1 / 60, focus, GROUND);
  assert.equal(debris.liveCount, 0, 'the pool is handed back');
});

test('TESTE 11 - debris out past the draw distance is recycled immediately', () => {
  const scene = new THREE.Scene();
  const debris = new DebrisField({ scene, settings: { preset: { particles: 1 } } });
  debris.burst(new THREE.Vector3(0, 300, 0), new THREE.Vector3(10, 10, 10), 20, 6);
  assert.ok(debris.liveCount > 0, 'chunks were spawned');
  debris.update(1 / 60, new THREE.Vector3(50000, 300, 0), GROUND);
  assert.equal(debris.liveCount, 0, 'nothing kept alive out of sight');
});

// --- TESTE 12: performance --------------------------------------------------------
test('TESTE 12 - a full double collapse stays far inside a frame', () => {
  const scene = new THREE.Scene();
  const debris = new DebrisField({ scene, settings: { preset: { particles: 1 } } });
  const grid = new ObstacleGrid();
  const landmarks = createLandmarks(grid);
  const field = new DestructionField({ debris });
  for (const b of landmarks.userData.destructibles) field.add(b);
  const w = { grid, field, towers: landmarks.userData.destructibles };
  levelTheBase(w, 0);
  levelTheBase(w, 1);
  const bodies = w.towers.reduce((n, t) => n + t.falling.length, 0);
  assert.ok(bodies > 60, `${bodies} bodies falling at once`);

  const focus = new THREE.Vector3(TWINS.x, BASE + 200, TWINS.z + 400);
  const steps = 600;
  const t0 = performance.now();
  for (let i = 0; i < steps; i++) field.update(1 / 60, focus, GROUND);
  const perStep = (performance.now() - t0) / steps;
  // A 60 Hz frame is 16.6 ms and this is one of a dozen systems in it. A tenth of a
  // millisecond is the bar; anything near a millisecond means the integrator has
  // started doing work proportional to something it should not be.
  assert.ok(perStep < 1.0, `${perStep.toFixed(3)} ms per step with everything falling`);
  console.log(`       ${bodies} bodies, ${perStep.toFixed(3)} ms/step, ${debris.capacity} debris slots`);
});

test('an intact world costs nothing per frame', () => {
  const w = world();
  const focus = new THREE.Vector3(TWINS.x, BASE + 200, TWINS.z + 400);
  const t0 = performance.now();
  for (let i = 0; i < 2000; i++) w.field.update(1 / 60, focus, GROUND);
  const perStep = (performance.now() - t0) / 2000;
  assert.ok(perStep < 0.05, `${perStep.toFixed(4)} ms per step with nothing happening`);
});

// --- reset -------------------------------------------------------------------------
test('resetting puts every tower back exactly as it was built', () => {
  const w = world();
  levelTheBase(w, 0);
  levelTheBase(w, 1);
  settle(w);
  assert.equal(w.towers[0].standing, false);

  w.field.reset();
  for (const t of w.towers) {
    assert.equal(t.standing, true);
    assert.equal(t.collapsed, false);
    assert.equal(t.integrity, 1);
    assert.equal(t.falling.length, 0);
    for (const m of t.modules) {
      assert.equal(m.state, MODULE_STATE.INTACT);
      assert.deepEqual(m.centre.toArray(), m.origin.toArray());
    }
    for (const p of t.props) assert.equal(p.fallen, false);
  }
  // And it is solid again.
  const t = w.towers[0];
  const probe = new THREE.Vector3(t.origin.x, t.origin.y + H * 0.8, t.origin.z);
  assert.ok(w.grid.sample(probe, 8, null), 'the collision grid has it back');
});

console.log(`\n${passed} checks passed${process.exitCode ? ', some failed' : ''}\n`);
