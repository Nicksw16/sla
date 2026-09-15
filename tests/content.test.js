/**
 * Content validation. Catches authoring mistakes in mission and aircraft data that
 * would only show up in play: a gate inside a mountain, an unreachable unlock, a
 * star threshold nobody can hit. Runs in plain Node.
 */
import assert from 'node:assert/strict';
import { MISSIONS, MISSION_BY_ID, TOTAL_STARS, gradeMission } from '../src/data/missions.js';
import { AIRCRAFT, AIRCRAFT_ORDER, TIERS } from '../src/data/aircraft.js';
import { UPGRADE_TREE, UPGRADE_ORDER, applyUpgrades, PAINTS, upgradeCost } from '../src/data/upgrades.js';
import { REGIONS, REGION_ORDER, LANDMARKS, RUNWAY } from '../src/data/regions.js';
import { WEATHER } from '../src/data/weather.js';
import { SECRETS, SECRET_BY_ID, SECRET_RADIUS, SECRET_REWARD } from '../src/data/secrets.js';
import { collisionHeight, isOnRunway, terrainHeight } from '../src/world/Terrain.js';
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

test('a fully upgraded aircraft stays below the class above it', () => {
  // Upgrades must help without replacing the aircraft progression (§54). The roster
  // runs in pairs - within a class the second aircraft is a side-grade, not a strict
  // improvement - so the rung to clear is two along, which is the next class.
  const maxLevels = Object.fromEntries(UPGRADE_ORDER.map((k) => [k, UPGRADE_TREE[k].levels]));
  for (let i = 0; i < AIRCRAFT_ORDER.length - 2; i++) {
    const maxed = applyUpgrades(AIRCRAFT[AIRCRAFT_ORDER[i]], maxLevels);
    const above = AIRCRAFT[AIRCRAFT_ORDER[i + 2]];
    assert.ok(maxed.maxSpeed < above.maxSpeed,
      `maxed ${AIRCRAFT_ORDER[i]} (${maxed.maxSpeed.toFixed(0)}) beats stock ${above.id} (${above.maxSpeed})`);
  }
});

test('the store catalogue is ordered and every class is filled', () => {
  // What the store screen promises: prices and star gates only ever go up as you read
  // down the list, and each class holds exactly the two aircraft it advertises.
  let lastPrice = -1;
  let lastStars = -1;
  let lastTier = 0;
  for (const id of AIRCRAFT_ORDER) {
    const a = AIRCRAFT[id];
    assert.ok(a.price > lastPrice, `${id} is not dearer than the aircraft before it`);
    assert.ok(a.requiresStars >= lastStars, `${id} needs fewer stars than the aircraft before it`);
    assert.ok(a.tier >= lastTier, `${id} is in a lower class than the aircraft before it`);
    assert.ok(TIERS.some((t) => t.tier === a.tier), `${id} is in class ${a.tier}, which the store does not sell`);
    lastPrice = a.price; lastStars = a.requiresStars; lastTier = a.tier;
  }
  for (const t of TIERS) {
    const members = AIRCRAFT_ORDER.filter((id) => AIRCRAFT[id].tier === t.tier);
    assert.equal(members.length, 2, `class ${t.name} holds ${members.length} aircraft`);
  }
  assert.equal(AIRCRAFT_ORDER.length, 10, 'the catalogue is not ten aircraft');
});

test('every class is a real step up from the one below', () => {
  // A side-grade inside a class is fine. A class that does not beat the one below it
  // would make the money pointless.
  for (let t = 2; t <= TIERS.length; t++) {
    const below = AIRCRAFT_ORDER.filter((id) => AIRCRAFT[id].tier === t - 1).map((id) => AIRCRAFT[id]);
    const here = AIRCRAFT_ORDER.filter((id) => AIRCRAFT[id].tier === t).map((id) => AIRCRAFT[id]);
    const slowestHere = Math.min(...here.map((a) => a.maxSpeed));
    const fastestBelow = Math.max(...below.map((a) => a.maxSpeed));
    assert.ok(slowestHere > fastestBelow * 1.04,
      `class ${t} tops out at ${slowestHere} against ${fastestBelow} in class ${t - 1}`);
  }
});

test('each class is affordable by the time it unlocks', () => {
  // The gate that matters is not the total: it is whether the money is there when the
  // game says you may buy. For each class, three-starring everything open at its star
  // gate has to cover the cheaper of its two aircraft - otherwise the store dangles
  // something the campaign never pays for (§49).
  for (const t of TIERS) {
    const cheapest = AIRCRAFT_ORDER
      .filter((id) => AIRCRAFT[id].tier === t.tier)
      .map((id) => AIRCRAFT[id])
      .sort((a, b) => a.price - b.price)[0];
    const earnable = MISSIONS
      .filter((m) => (m.unlock?.stars ?? 0) <= cheapest.requiresStars)
      .reduce((sum, m) => sum + m.rewards.credits * 2 + Math.round(m.rewards.credits * 0.5), 0);
    assert.ok(earnable >= cheapest.price,
      `${cheapest.id} costs ${cheapest.price} but only ${earnable} is earnable by ${cheapest.requiresStars} stars`);
  }
});

test('the flagship stays out of reach of one clean campaign', () => {
  // The opposite failure: nothing left to want. The dearest aircraft is deliberately
  // more than a single three-starred run pays for, beacons included (§151).
  const campaign = MISSIONS.reduce((sum, m) =>
    sum + m.rewards.credits * 2 + Math.round(m.rewards.credits * 0.5), 0) + SECRETS.length * SECRET_REWARD.credits;
  const dearest = Math.max(...AIRCRAFT_ORDER.map((id) => AIRCRAFT[id].price));
  assert.ok(dearest > campaign * 0.9,
    `the dearest aircraft costs ${dearest} against ${campaign} of campaign money`);
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

test('the bridge stands on the channel bed and its road reaches the ground', () => {
  // The bridge shipped floating. Its deck sat at a fraction of the landmark height
  // with nothing at all beneath it, and its approach ramps were two flat slabs hanging
  // in mid-air a hundred and fifty metres off each end, at a height matching neither
  // the deck nor the shore. Nothing here failed, because nothing here looked: the
  // beacon under the deck was reachable and every gate was in clear air, which is all
  // the tests above ask. What follows asks the question a player asks by looking at it -
  // is this thing holding itself up, and can you drive onto it.
  const { grid } = generateCity({ seed: 20260912 });
  createLandmarks(grid);
  const L = LANDMARKS.find((l) => l.id === 'bridge');

  // The lowest and highest structure the grid reports on the bridge's centreline.
  const column = (x) => {
    let low = null; let high = null;
    for (let y = -40; y < 300; y += 1) {
      if (grid.sample({ x, y, z: L.z }, 1)) { if (low === null) low = y; high = y; }
    }
    return { low, high };
  };
  const roadTop = (x) => {
    // The road itself, ignoring anything standing above it: the first ceiling found
    // walking up from just above the ground.
    let top = null;
    for (let y = Math.max(terrainHeight(x, L.z), 0) + 1; y < 120; y += 1) {
      if (grid.sample({ x, y, z: L.z }, 1)) top = y; else if (top !== null) break;
    }
    return top;
  };

  // --- the main span is carried by piers founded on the bed, not by nothing.
  const bed = terrainHeight(L.x, L.z);
  assert.ok(bed < -10, `the channel should be dredged here, not ${bed.toFixed(0)} m`);
  const deck = roadTop(L.x);
  assert.ok(deck > 40 && deck < 160, `the deck is at ${deck} m, which is no height for a road`);
  let piers = 0;
  for (let x = L.x - 420; x <= L.x + 420; x += 5) {
    const { low } = column(x);
    if (low !== null && low < bed + 6) piers++;
  }
  assert.ok(piers >= 2, `nothing carries the deck down to the bed (${piers} soundings)`);

  // --- and the gap under it is still open water, which is the whole point of it.
  for (const x of [L.x - 120, L.x, L.x + 120]) {
    assert.ok(!grid.sample({ x, y: 30, z: L.z }, 8), `the channel is blocked at x ${x}`);
  }

  // --- the road is continuous from the deck out to where it meets the ground, and
  // every metre of it is either on the ground or standing on something.
  for (const side of [-1, 1]) {
    let landed = null;
    for (let d = 0; d <= 1100 && landed === null; d += 10) {
      const x = L.x + side * (420 + d);
      const top = roadTop(x);
      assert.ok(top !== null, `the road stops in mid-air ${d} m out from the deck (side ${side})`);
      const ground = Math.max(terrainHeight(x, L.z), 0);
      // Either the slab is resting on the ground, or the column below it is filled by
      // a pier within half a bay of here.
      const resting = top - ground < 12;
      let propped = false;
      for (let b = -22; b <= 22 && !propped; b += 4) {
        const { low } = column(x + b);
        propped = low !== null && low < ground + 6;
      }
      assert.ok(resting || propped,
        `the road floats ${(top - ground).toFixed(0)} m up at ${d} m out (side ${side})`);
      // Where the slab is down on the ground the approach is over; past that it is a
      // street like any other, and not this test's business.
      if (resting) landed = d;
    }
    assert.ok(landed !== null && landed >= 400 && landed <= 1000,
      `the road meets the ground ${landed} m out, which is not a grade a road could climb`);
    // And it climbs: the road is higher every step of the way back to the deck.
    let prev = 0;
    for (let d = landed; d >= 0; d -= 40) {
      const top = roadTop(L.x + side * (420 + d));
      assert.ok(top >= prev - 1, `the approach dips at ${d} m out (side ${side})`);
      prev = top;
    }
  }
});

test('no mission leg flies through a tall landmark', () => {
  // The checkpoint test above only asks whether the gates themselves are clear. It
  // says nothing about the straight line between two gates, which is where an
  // aircraft actually spends the run - and when the Gemini Towers first went up they
  // stood squarely across the opening leg of Rooftop Slalom, ten metres off its
  // centreline. Every checkpoint was still in open air, so nothing failed here; what
  // failed was the end-to-end suite, where the scripted pilot flew into a tower on
  // its way to gate two and the mission ended as a crash, taking the scoring, payout
  // and save assertions down with it. Eleven lines of geometry beats reading that
  // cascade backwards.
  // These are the landmarks' own registered collider half-extents, not a guess and
  // not a comfort margin. The question being asked is the objective one - does the
  // straight line between two gates pass through solid structure - because how close
  // is too close for comfort is a design decision, and several routes deliberately
  // graze a landmark. Financial Canyon, for one, threads past the Obelisk with about
  // five metres to spare, and that is authored, not accidental.
  const FOOTPRINT = {
    twins: 94,           // two shafts of +/-34m, standing +/-60m either side of centre
    skylineTower: 20,
    obelisk: 22,
    tower: 30,
  };
  const planDistance = (p, q, c) => {
    const vx = q.x - p.x;
    const vz = q.z - p.z;
    const wx = c.x - p.x;
    const wz = c.z - p.z;
    const len2 = vx * vx + vz * vz;
    const t = len2 ? Math.max(0, Math.min(1, (wx * vx + wz * vz) / len2)) : 0;
    return Math.hypot(p.x + vx * t - c.x, p.z + vz * t - c.z);
  };

  for (const m of MISSIONS) {
    if (!m.route || m.route.length < 2) continue;
    for (let i = 0; i < m.route.length - 1; i++) {
      const p = m.route[i];
      const q = m.route[i + 1];
      for (const L of LANDMARKS) {
        const radius = FOOTPRINT[L.id];
        if (!radius) continue;
        const d = planDistance(p, q, L);
        // Only a concern where the leg is low enough to meet the structure.
        const legTop = Math.max(p.y, q.y);
        const ground = collisionHeight(L.x, L.z);
        if (legTop > ground + L.height + 40) continue;
        assert.ok(d > radius,
          `${m.id} leg ${i}->${i + 1} passes ${d.toFixed(0)}m from ${L.id} `
          + `(needs ${radius}m), at ${legTop.toFixed(0)}m against a ${L.height}m structure`);
      }
    }
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
