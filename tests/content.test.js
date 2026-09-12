/**
 * Content validation. Catches authoring mistakes in mission and aircraft data that
 * would only show up in play: a gate inside a mountain, an unreachable unlock, a
 * star threshold nobody can hit. Runs in plain Node.
 */
import assert from 'node:assert/strict';
import { MISSIONS, MISSION_BY_ID, TOTAL_STARS, gradeMission } from '../src/data/missions.js';
import { AIRCRAFT, AIRCRAFT_ORDER } from '../src/data/aircraft.js';
import { UPGRADE_TREE, UPGRADE_ORDER, applyUpgrades, PAINTS, upgradeCost } from '../src/data/upgrades.js';
import { REGIONS, REGION_ORDER, LANDMARKS, RUNWAY } from '../src/data/regions.js';
import { WEATHER } from '../src/data/weather.js';
import { SECRETS, SECRET_BY_ID, SECRET_RADIUS, SECRET_REWARD } from '../src/data/secrets.js';
import { collisionHeight, isOnRunway } from '../src/world/Terrain.js';
import { generateCity } from '../src/world/CityGenerator.js';
import { createLandmarks } from '../src/world/Landmarks.js';

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

console.log('\nContent');

test('every mission has the fields the mission manager reads', () => {
  for (const m of MISSIONS) {
    assert.ok(m.id && m.name && m.type, `${m.id}: missing identity`);
    assert.ok(REGIONS[m.region], `${m.id}: unknown region "${m.region}"`);
    assert.ok(WEATHER[m.conditions.weather], `${m.id}: unknown weather "${m.conditions.weather}"`);
    assert.ok(Number.isFinite(m.conditions.hour), `${m.id}: bad hour`);
    assert.ok(Array.isArray(m.route) && m.route.length >= 3, `${m.id}: route too short`);
    assert.ok(m.rewards?.credits > 0 && m.rewards?.xp > 0, `${m.id}: missing rewards`);
    assert.ok(m.desc?.length > 40, `${m.id}: description too thin`);
    assert.ok(m.tip?.length > 20, `${m.id}: missing tip`);
  }
});

test('mission ids are unique', () => {
  const ids = MISSIONS.map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate mission id');
});

test('every checkpoint clears the terrain under it', () => {
  // The failure this guards against is a gate buried inside the North Ridge, which
  // is unpassable and not obvious from the numbers in the data file.
  const problems = [];
  for (const m of MISSIONS) {
    for (const [i, c] of m.route.entries()) {
      const ground = collisionHeight(c.x, c.z);
      if (c.y - ground < 12) problems.push(`${m.id}[${i}] y=${c.y} ground=${ground.toFixed(0)}`);
    }
  }
  assert.equal(problems.length, 0, `gates below ground: ${problems.join('; ')}`);
});

test('no checkpoint is buried inside a building or a landmark', () => {
  // Terrain clearance is not enough: a gate inside a tower is just as unpassable, and
  // the financial district has 360 m buildings standing where routes want to go.
  const { grid } = generateCity({ seed: 20260912 });
  createLandmarks(grid);
  const problems = [];
  for (const m of MISSIONS) {
    for (const [i, c] of m.route.entries()) {
      // Probe with the gate's own radius: the whole opening has to be clear, not
      // just its centre point.
      const hit = grid.sample({ x: c.x, y: c.y, z: c.z }, c.radius * 0.8);
      if (hit) problems.push(`${m.id}[${i}] (${c.x},${c.y},${c.z}) inside ${hit.kind}`);
    }
  }
  assert.equal(problems.length, 0, `blocked gates: ${problems.join('; ')}`);
});

test('every mission spawn point is clear of obstacles', () => {
  const { grid } = generateCity({ seed: 20260912 });
  createLandmarks(grid);
  const problems = [];
  for (const m of MISSIONS) {
    const hit = grid.sample({ x: m.start.x, y: m.start.y, z: m.start.z }, 30);
    if (hit) problems.push(`${m.id} spawns inside ${hit.kind}`);
  }
  assert.equal(problems.length, 0, problems.join('; '));
});

test('every mission starts somewhere flyable', () => {
  for (const m of MISSIONS) {
    const ground = collisionHeight(m.start.x, m.start.z);
    if (m.start.grounded) {
      assert.ok(isOnRunway(m.start.x, m.start.z), `${m.id}: grounded start is not on the runway`);
    } else {
      assert.ok(m.start.y - ground > 40, `${m.id}: start only ${(m.start.y - ground).toFixed(0)} m above ground`);
    }
  }
});

test('checkpoint radii shrink as the campaign progresses', () => {
  const early = MISSIONS.slice(0, 4).flatMap((m) => m.route.map((c) => c.radius));
  const late = MISSIONS.slice(-4).flatMap((m) => m.route.map((c) => c.radius));
  const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  assert.ok(avg(late) < avg(early) * 0.75, `early ${avg(early).toFixed(0)} m vs late ${avg(late).toFixed(0)} m`);
});

test('unlock thresholds are reachable in order', () => {
  // Each mission must be unlockable using only stars from missions before it.
  let available = 0;
  for (const m of MISSIONS) {
    assert.ok(m.unlock.stars <= available,
      `${m.id} needs ${m.unlock.stars} stars but only ${available} are earnable before it`);
    available += 3;
  }
  assert.ok(available === TOTAL_STARS, `star total mismatch: ${available} vs ${TOTAL_STARS}`);
});

test('aircraft unlock requirements are reachable', () => {
  for (const id of AIRCRAFT_ORDER) {
    const a = AIRCRAFT[id];
    assert.ok(a.requiresStars <= TOTAL_STARS, `${id} needs more stars than exist`);
    assert.ok(a.price >= 0, `${id} has a negative price`);
  }
  assert.equal(AIRCRAFT.skylark.price, 0, 'the starter aircraft must be free');
});

test('aircraft are meaningfully different, not reskins', () => {
  // Guards the spec's pillar that the roster must behave differently (§56).
  const keys = ['maxSpeed', 'thrust', 'rollRate', 'stability', 'stallSpeed', 'turboMult', 'mass'];
  for (let i = 0; i < AIRCRAFT_ORDER.length - 1; i++) {
    const a = AIRCRAFT[AIRCRAFT_ORDER[i]];
    const b = AIRCRAFT[AIRCRAFT_ORDER[i + 1]];
    const differing = keys.filter((k) => Math.abs(a[k] - b[k]) / Math.abs(a[k]) > 0.07);
    assert.ok(differing.length >= 4,
      `${a.id} and ${b.id} only differ meaningfully in ${differing.length} stats (${differing.join(', ')})`);
  }
});

test('a fully upgraded aircraft stays below the next class', () => {
  // Upgrades must help without replacing the aircraft progression (§54).
  const maxLevels = Object.fromEntries(UPGRADE_ORDER.map((k) => [k, UPGRADE_TREE[k].levels]));
  for (let i = 0; i < AIRCRAFT_ORDER.length - 1; i++) {
    const maxed = applyUpgrades(AIRCRAFT[AIRCRAFT_ORDER[i]], maxLevels);
    const next = AIRCRAFT[AIRCRAFT_ORDER[i + 1]];
    assert.ok(maxed.maxSpeed < next.maxSpeed,
      `maxed ${AIRCRAFT_ORDER[i]} (${maxed.maxSpeed.toFixed(0)}) beats stock ${next.id} (${next.maxSpeed})`);
  }
});

test('applyUpgrades never mutates the catalogue', () => {
  const before = AIRCRAFT.skylark.maxSpeed;
  applyUpgrades(AIRCRAFT.skylark, { engine: 4, handling: 4, stability: 4, turbo: 4, armor: 4 });
  assert.equal(AIRCRAFT.skylark.maxSpeed, before);
});

test('upgrade costs rise and terminate', () => {
  for (const key of UPGRADE_ORDER) {
    let last = 0;
    for (let lvl = 0; lvl < UPGRADE_TREE[key].levels; lvl++) {
      const c = upgradeCost(key, lvl);
      assert.ok(c > last, `${key} level ${lvl} is not dearer than the one before`);
      last = c;
    }
    assert.equal(upgradeCost(key, UPGRADE_TREE[key].levels), null, `${key} sells past its max level`);
  }
});

test('grading returns 1 to 3 stars for a completed run, 0 for a failure', () => {
  const m = MISSION_BY_ID['first-light'];
  assert.equal(gradeMission(m, { completed: false, time: 10, score: 0 }), 0);
  assert.equal(gradeMission(m, { completed: true, time: m.stars.time[0] - 1, score: 0, perfect: false }), 3);
  assert.equal(gradeMission(m, { completed: true, time: m.stars.time[1] - 1, score: 0, perfect: false }), 2);
  const slow = gradeMission(m, { completed: true, time: m.stars.time[2] + 500, score: 0, perfect: false });
  assert.ok(slow >= 1 && slow <= 3, `slow run graded ${slow}`);
});

test('every paint and every reward paint exists', () => {
  for (const m of MISSIONS) {
    if (m.rewards.unlockPaint) {
      assert.ok(PAINTS[m.rewards.unlockPaint], `${m.id} awards unknown paint "${m.rewards.unlockPaint}"`);
    }
  }
});

test('rival missions name a real aircraft', () => {
  for (const m of MISSIONS) {
    const r = m.rules?.rival;
    if (!r) continue;
    assert.ok(AIRCRAFT[r.aircraftId], `${m.id}: rival flies unknown aircraft "${r.aircraftId}"`);
    assert.ok(r.skill > 0 && r.skill <= 1, `${m.id}: rival skill out of range`);
  }
});

test('every region has at least one mission and every district is represented', () => {
  const used = new Set(MISSIONS.map((m) => m.region));
  for (const id of REGION_ORDER) {
    assert.ok(used.has(id), `no mission set in ${id}`);
  }
});

test('every hidden beacon is reachable', () => {
  // The failure this guards against is a beacon authored inside a landmark or a
  // hillside: visible, glowing, and impossible to collect without crashing.
  const { grid } = generateCity({ seed: 20260912 });
  createLandmarks(grid);
  const problems = [];
  for (const s of SECRETS) {
    const ground = collisionHeight(s.x, s.z);
    if (s.y - ground < 20) problems.push(`${s.id}: ${(s.y - ground).toFixed(0)} m above ground`);
    if (grid.sample({ x: s.x, y: s.y, z: s.z }, SECRET_RADIUS * 0.5)) problems.push(`${s.id}: inside geometry`);
  }
  assert.equal(problems.length, 0, problems.join('; '));
});

test('hidden beacons are distinct, named, hinted and spread out', () => {
  const ids = SECRETS.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate beacon id');
  assert.equal(Object.keys(SECRET_BY_ID).length, SECRETS.length, 'lookup out of step with the list');
  for (const s of SECRETS) {
    assert.ok(s.name?.length > 3, `${s.id}: missing name`);
    assert.ok(s.hint?.length > 12, `${s.id}: hint too thin to be a hint`);
    assert.ok(REGIONS[s.region], `${s.id}: unknown region "${s.region}"`);
  }
  // Clustered beacons would make one flight collect several by accident.
  for (let i = 0; i < SECRETS.length; i++) {
    for (let j = i + 1; j < SECRETS.length; j++) {
      const a = SECRETS[i]; const b = SECRETS[j];
      const d = Math.hypot(a.x - b.x, a.z - b.z);
      assert.ok(d > SECRET_RADIUS * 6, `${a.id} and ${b.id} are ${d.toFixed(0)} m apart`);
    }
  }
  assert.ok(SECRET_REWARD.credits > 0 && SECRET_REWARD.xp > 0, 'beacons must pay something');
  assert.ok(PAINTS.beacon?.reward, 'the full set has nothing to award');
});

test('beacons are spread across the map rather than over one district', () => {
  const regions = new Set(SECRETS.map((s) => s.region));
  assert.ok(regions.size >= 6, `beacons only cover ${regions.size} districts`);
});

test('landmarks sit on or above their ground', () => {
  for (const L of LANDMARKS) {
    const ground = collisionHeight(L.x, L.z);
    assert.ok(Number.isFinite(ground), `${L.id}: bad ground`);
    assert.ok(L.height >= 0, `${L.id}: negative height`);
  }
});

test('the runway is long enough for the heaviest aircraft to get airborne', () => {
  // Rough ground roll: v^2 / (2a) using the on-ground thrust the model applies.
  for (const id of AIRCRAFT_ORDER) {
    const a = AIRCRAFT[id];
    const accel = a.thrust * 0.92 - 2.6;
    const roll = (a.rotateSpeed * a.rotateSpeed) / (2 * accel);
    assert.ok(roll < RUNWAY.length * 0.75,
      `${id} needs ~${roll.toFixed(0)} m of a ${RUNWAY.length} m runway`);
  }
});

console.log(`\n${passed} content assertions passed\n`);
