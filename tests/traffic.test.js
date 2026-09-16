/**
 * City traffic.
 *
 * There were no tests here at all, which is how the traffic came to be driving along
 * the bed of the harbour channel twenty-four metres under the water: a vehicle's height
 * came from the terrain alone, and nothing ever asked whether the road it was on was
 * the ground or a bridge deck eighty metres above it.
 *
 * Everything here drives the real TrafficManager at the density the game ships, over
 * the real road surface, in plain Node. None of the driving needs a GPU.
 */
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { TrafficManager } from '../src/world/TrafficManager.js';
import { VEHICLE_CLASSES, VEHICLE_ORDER, PAINT } from '../src/world/Vehicles.js';
import {
  BRIDGE, BRIDGE_LINE, BRIDGE_SPAN, ROAD, bridgeRoadHeight, isAvenue, lineAt,
  lineIndexNear, roadSurfaceAt,
} from '../src/world/Roads.js';
import {
  follow, gapAhead, hasSignals, laneKey, laneOffsetsFor, roadExists, signalFor,
  surfaceUnder, vehicleXZ,
} from '../src/world/Traffic.js';
import { terrainHeight, isWater } from '../src/world/Terrain.js';

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

console.log('\nTraffic');

/** A manager at shipped density, plus a way to run it for a while. */
function city(seed = 7) {
  const scene = new THREE.Group();
  const settings = { preset: { trafficDensity: 1 } };
  return new TrafficManager({ scene, settings, seed });
}
function run(t, cam, seconds) {
  const steps = Math.round(seconds * 60);
  for (let i = 0; i < steps; i++) t.update(1 / 60, cam, i / 60);
}

// --- what they are made of -------------------------------------------------------

test('there is more than one kind of vehicle on the road', () => {
  const t = city();
  assert.ok(VEHICLE_ORDER.length >= 7, `${VEHICLE_ORDER.length} classes`);
  const kinds = new Set(t.ground.map((v) => v.kind));
  assert.equal(kinds.size, VEHICLE_ORDER.length, 'every class is actually spawned');
  // And they are different sizes, which is what reads from the air.
  const lengths = new Set(VEHICLE_ORDER.map((k) => VEHICLE_CLASSES[k].length));
  assert.ok(lengths.size >= 6, `${lengths.size} distinct lengths`);
});

test('the paint is varied, and weighted the way a real car park is', () => {
  const t = city();
  const colours = new Set();
  const finishes = new Set();
  for (const mesh of Object.values(t.groundMeshes)) {
    const c = mesh.instanceColor;
    const f = mesh.geometry.getAttribute('aFinish');
    for (let i = 0; i < mesh.count; i++) {
      colours.add(`${c.getX(i).toFixed(3)},${c.getY(i).toFixed(3)},${c.getZ(i).toFixed(3)}`);
      finishes.add(f.getX(i).toFixed(2));
    }
  }
  assert.ok(colours.size >= 10, `only ${colours.size} distinct colours across the city`);
  // Finish varies per car, so the street is not uniformly showroom-fresh.
  assert.ok(finishes.size >= 20, `only ${finishes.size} distinct paint finishes`);
  // Monochrome dominates, the way it does on a real road.
  const plain = PAINT.filter((p) => p.metal >= 0 && p.color >= 0x7d838b && p.color <= 0xe8ebee);
  assert.ok(plain.length >= 3, 'the palette has whites, silvers and greys in it');
});

// --- where they drive -------------------------------------------------------------

test('vehicles sit on the road, not on the markings and not on the pavement', () => {
  const t = city();
  const cam = new THREE.Vector3(120, 300, -60);
  run(t, cam, 6);
  let checked = 0;
  for (const v of t.ground) {
    if (!v.active || v.turning) continue;
    const off = laneOffsetsFor(v.line)[v.lane];
    assert.ok(off !== undefined, `${v.kind} is in lane ${v.lane} of a road that has none`);
    // Clear of the centre line it would otherwise straddle, and inside the kerb.
    assert.ok(off >= 4, `lane centre only ${off} m off the middle of the road`);
    const half = isAvenue(v.line) ? 30 : ROAD * 0.5;
    assert.ok(off + 1 < half, `lane centre ${off} m is outside a ${half * 2} m road`);
    checked++;
  }
  assert.ok(checked > 100, `only ${checked} vehicles checked`);
});

test('nothing drives on the water', () => {
  const t = city(11);
  // Out over the harbour, where the channel is.
  const cam = new THREE.Vector3(BRIDGE_SPAN.x, 300, BRIDGE_SPAN.z);
  run(t, cam, 10);
  const drowned = [];
  for (const v of t.ground) {
    if (!v.active || v.turning) continue;
    const p = vehicleXZ(v);
    if (!isWater(p.x, p.z)) continue;
    // The one road that crosses water is the bridge, and it is allowed to.
    const surf = roadSurfaceAt(p.x, p.z);
    if (surf.onBridge > 0 && surf.y > 1) continue;
    drowned.push(`${v.kind} at ${p.x.toFixed(0)}, ${p.z.toFixed(0)}`);
  }
  assert.equal(drowned.length, 0, `${drowned.length} in the water: ${drowned.slice(0, 3).join('; ')}`);
});

test('a vehicle is always on the road surface, never through it or above it', () => {
  const t = city(3);
  const cam = new THREE.Vector3(BRIDGE_SPAN.x - 300, 200, BRIDGE_SPAN.z);
  const bad = [];
  for (let i = 0; i < 60 * 12; i++) {
    t.update(1 / 60, cam, i / 60);
    if (i % 60) continue;
    for (const v of t.ground) {
      if (!v.active || v.turning) continue;
      const p = vehicleXZ(v);
      const surf = roadSurfaceAt(p.x, p.z);
      const m = new THREE.Matrix4();
      v.mesh.getMatrixAt(v.index, m);
      const y = m.elements[13];
      if (Math.abs(y - (surf.y + 0.08)) > 0.6) {
        bad.push(`${v.kind} at y ${y.toFixed(1)}, road at ${surf.y.toFixed(1)}`);
      }
    }
  }
  assert.equal(bad.length, 0, `${bad.length} off the road: ${bad.slice(0, 3).join('; ')}`);
});

// --- the bridge -------------------------------------------------------------------

test('the bridge road is one surface, shared by the structure and the traffic', () => {
  // The deck, level across the main span.
  assert.equal(bridgeRoadHeight(0), BRIDGE.DECK_Y);
  assert.equal(bridgeRoadHeight(BRIDGE.SPAN_HALF - 1), BRIDGE.DECK_Y);
  // The approaches come down from it and reach the ground.
  const foot = bridgeRoadHeight(BRIDGE.SPAN_HALF + BRIDGE.GRADE_RUN + BRIDGE.LEVEL_RUN - 1);
  const ground = terrainHeight(
    BRIDGE_SPAN.x + BRIDGE.SPAN_HALF + BRIDGE.GRADE_RUN + BRIDGE.LEVEL_RUN - 1, BRIDGE_SPAN.z,
  );
  assert.ok(foot - ground < 4, `the approach ends ${(foot - ground).toFixed(0)} m above the ground`);
  // And it runs out past the end of the approaches.
  assert.equal(bridgeRoadHeight(BRIDGE_SPAN.half + 40), null);
  // Monotonic: a road that dips in the middle of a climb is a ramp nobody could drive.
  let prev = BRIDGE.DECK_Y;
  for (let d = BRIDGE.SPAN_HALF; d <= BRIDGE_SPAN.half; d += 10) {
    const h = bridgeRoadHeight(d);
    assert.ok(h <= prev + 0.01, `the approach climbs again at ${d} m`);
    prev = h;
  }
});

test('a car crossing the channel is on the deck, seventy metres over the water', () => {
  const line = lineIndexNear(BRIDGE_SPAN.z);
  // Mid-channel, where there is nothing but water underneath.
  const mid = BRIDGE_SPAN.x;
  assert.ok(isWater(mid, lineAt(line)), 'the channel really is water here');
  assert.ok(roadExists(0, line, mid), 'the bridge counts as a road that exists');
  const surf = roadSurfaceAt(mid, BRIDGE_SPAN.z);
  assert.ok(surf.onBridge > 0.9, `only ${surf.onBridge.toFixed(2)} on the bridge at its centre`);
  assert.equal(Math.round(surf.y), BRIDGE.DECK_Y);
  // Terrain alone - what the traffic used to use - is the dredged bed, far below.
  assert.ok(terrainHeight(mid, BRIDGE_SPAN.z) < -20,
    'and the old answer was the bottom of the channel');
});

test('traffic actually crosses the bridge', () => {
  const t = city(21);
  const cam = new THREE.Vector3(BRIDGE_SPAN.x, 160, BRIDGE_SPAN.z);
  let everOnDeck = 0;
  let climbed = 0;
  for (let i = 0; i < 60 * 30; i++) {
    t.update(1 / 60, cam, i / 60);
    if (i % 30) continue;
    for (const v of t.ground) {
      if (!v.active || v.turning) continue;
      const p = vehicleXZ(v);
      const surf = roadSurfaceAt(p.x, p.z);
      if (surf.onBridge > 0.5 && surf.y > BRIDGE.DECK_Y - 2) everOnDeck++;
      else if (surf.onBridge > 0.3 && surf.y > 12) climbed++;
    }
  }
  assert.ok(everOnDeck > 0, 'nothing ever reached the deck');
  assert.ok(climbed > 0, 'nothing was ever seen on an approach ramp');
});

test('a vehicle is on the deck or on the ground, never hovering between them', () => {
  // The bug this catches: the deck is 34 m wide but the grid line it sits on is one of
  // the avenues, which are 60 m with two lanes each way. The outer lane put a fifth of
  // the bridge traffic twenty-two metres off the deck centre - five metres past the
  // parapet - where the surface function was fading from the deck down to the water and
  // handed back forty-eight metres. Eighty-seven cars at a time hung there in mid-air.
  const t = city(7);
  const cam = new THREE.Vector3(BRIDGE_SPAN.x, 120, BRIDGE_SPAN.z);
  run(t, cam, 25);
  const hovering = [];
  for (const v of t.ground) {
    if (!v.active || v.turning) continue;
    const p = vehicleXZ(v);
    const surf = roadSurfaceAt(p.x, p.z);
    if (surf.onBridge <= 0) continue;
    const deck = bridgeRoadHeight(p.x - BRIDGE_SPAN.x);
    const ground = terrainHeight(p.x, p.z);
    const onDeck = deck !== null && Math.abs(surf.y - deck) < 0.5;
    const onGround = Math.abs(surf.y - Math.max(ground, 0)) < 0.5;
    if (!onDeck && !onGround) {
      hovering.push(`${v.kind} at z ${p.z.toFixed(0)}, y ${surf.y.toFixed(1)}`);
    }
  }
  assert.equal(hovering.length, 0,
    `${hovering.length} hovering: ${hovering.slice(0, 3).join('; ')}`);
});

test('the bridge carries one lane each way, however wide the road it is on', () => {
  // The deck is narrower than the avenue that runs onto it, so the lanes have to drop.
  const onSpan = laneOffsetsFor(BRIDGE_LINE, BRIDGE_SPAN.x, 0);
  assert.equal(onSpan.length, 1, `${onSpan.length} lanes each way on a ${BRIDGE.DECK_W} m deck`);
  // Every lane on the deck is comfortably inside the parapets.
  for (const off of onSpan) {
    assert.ok(off + 1.2 < BRIDGE.DECK_W * 0.5,
      `a lane ${off} m off centre on a deck ${BRIDGE.DECK_W} m wide`);
  }
  // Off the bridge the same grid line is the avenue it always was.
  const offSpan = laneOffsetsFor(BRIDGE_LINE, BRIDGE_SPAN.x + BRIDGE_SPAN.half + 500, 0);
  assert.ok(offSpan.length > onSpan.length, 'the road widens again past the approaches');
});

test('a car on the approach leans with the road', () => {
  const t = city(5);
  // A vehicle placed on the graded part of the western approach.
  const v = t.ground[0];
  const line = lineIndexNear(BRIDGE_SPAN.z);
  v.axis = 0; v.line = line; v.side = 1; v.lane = 0; v.active = true;
  v.s = BRIDGE_SPAN.x - BRIDGE.SPAN_HALF - BRIDGE.GRADE_RUN * 0.5;
  const out = surfaceUnder(v, {});
  assert.ok(Math.abs(out.pitch) > 0.02,
    `flat on a graded ramp (pitch ${out.pitch.toFixed(3)} rad)`);
  // Nose up on the way to the deck, which is the direction of travel here.
  assert.ok(out.pitch > 0, 'the nose should be up on the climb');
});

// --- how they drive ---------------------------------------------------------------

test('cars queue behind each other instead of driving through', () => {
  const t = city(13);
  const cam = new THREE.Vector3(120, 300, -60);
  run(t, cam, 12);
  const lanes = new Map();
  for (const v of t.ground) {
    if (!v.active || v.turning) continue;
    const key = laneKey(v);
    if (!lanes.has(key)) lanes.set(key, []);
    lanes.get(key).push(v);
  }
  const overlaps = [];
  for (const arr of lanes.values()) {
    arr.sort((a, b) => (a.s - b.s) * a.side);
    for (let i = 0; i < arr.length - 1; i++) {
      const gap = (arr[i + 1].s - arr[i].s) * arr[i].side
        - (arr[i].length + arr[i + 1].length) * 0.5;
      if (gap < -0.5) overlaps.push(`${arr[i].kind}/${arr[i + 1].kind} overlap ${gap.toFixed(1)} m`);
    }
  }
  assert.equal(overlaps.length, 0, `${overlaps.length}: ${overlaps.slice(0, 3).join('; ')}`);
});

test('the following model closes a gap and holds it', () => {
  const v = { speed: 14, cruise: 14, accel: 2.4, brake: 5 };
  // Nothing ahead and already at the cruise: no reason to do anything.
  assert.ok(Math.abs(follow(v, Infinity, 0)) < 0.01, 'no reason to accelerate at cruise');
  // Below the cruise with the road clear: get up to it.
  assert.ok(follow({ ...v, speed: 6 }, Infinity, 0) > 1, 'accelerates towards the cruise');
  // And a long way behind something, the gap is no reason to brake.
  assert.ok(follow({ ...v, speed: 6 }, 120, 14) > 1, 'a distant car ahead changes nothing');
  // Right behind something stopped: brake hard.
  assert.ok(follow(v, 4, 0) < -3, `brakes at 4 m from a stationary car (${follow(v, 4, 0).toFixed(1)})`);
  // And a slower car ahead settles to its speed rather than into it.
  const closing = follow({ ...v, speed: 16 }, 18, 10);
  assert.ok(closing < 0, 'slows for a slower car ahead');
});

test('signals run a two-phase cycle and the two directions never both go', () => {
  // A junction that has lights at all.
  let i = 0; let j = 0;
  outer: for (i = -8; i < 8; i++) for (j = -8; j < 8; j++) if (hasSignals(i, j)) break outer;
  assert.ok(hasSignals(i, j), 'found a signalled junction');
  let sawGreenX = false; let sawGreenZ = false; let sawRed = false;
  for (let s = 0; s < 60; s += 0.25) {
    const x = signalFor(i, j, 0, s);
    const z = signalFor(i, j, 1, s);
    assert.ok(!(x === 'green' && z === 'green'), `both directions green at ${s}s`);
    if (x === 'green') sawGreenX = true;
    if (z === 'green') sawGreenZ = true;
    if (x === 'red') sawRed = true;
  }
  assert.ok(sawGreenX && sawGreenZ && sawRed, 'the cycle actually cycles');
  // Minor crossroads are unsignalled, or the city is one long queue.
  assert.equal(signalFor(1, 1, 0, 0), 'green', 'a side-street crossing is not signalled');
});

test('a red light stops a car short of the junction, and green releases it', () => {
  const v = { s: 0, side: 1, axis: 0, line: 0, speed: 12, cruise: 12, accel: 2.4, brake: 5, length: 4.5 };
  // Find a signalled junction and a moment when this direction is red.
  let i = 0;
  while (!hasSignals(i, 0) && i < 40) i++;
  let red = -1; let green = -1;
  for (let s = 0; s < 60; s += 0.25) {
    if (red < 0 && signalFor(i, 0, 0, s) === 'red') red = s;
    if (green < 0 && signalFor(i, 0, 0, s) === 'green') green = s;
  }
  assert.ok(red >= 0 && green >= 0, 'found both a red and a green');
  const junction = { index: i, distance: 60 };
  const onRed = gapAhead(v, null, junction, red);
  assert.ok(onRed.gap < 60, 'a red is something to stop for');
  assert.ok(follow(v, onRed.gap, onRed.leadSpeed) < 0, 'and the car slows for it');
  const onGreen = gapAhead(v, null, junction, green);
  assert.equal(onGreen.gap, Infinity, 'a green is not');
});

test('nothing is ever put on a road that is not there', () => {
  const t = city(29);
  for (const cam of [
    new THREE.Vector3(BRIDGE_SPAN.x, 200, BRIDGE_SPAN.z + 600),
    new THREE.Vector3(-3000, 200, 3700),
    new THREE.Vector3(120, 300, -60),
  ]) {
    run(t, cam, 4);
    for (const v of t.ground) {
      if (!v.active || v.turning) continue;
      assert.ok(roadExists(v.axis, v.line, v.s),
        `${v.kind} on a road that does not exist at ${v.s.toFixed(0)}`);
    }
  }
});

test('turns land on a real road, pointing the right way', () => {
  const t = city(17);
  const cam = new THREE.Vector3(120, 300, -60);
  let turnsSeen = 0;
  for (let i = 0; i < 60 * 40; i++) {
    t.update(1 / 60, cam, i / 60);
    for (const v of t.ground) {
      if (!v.active || v.turning) continue;
      if (v._wasTurning) {
        turnsSeen++;
        assert.ok(roadExists(v.axis, v.line, v.s), `${v.kind} turned onto nothing`);
        assert.ok(Math.abs(v.side) === 1, 'and is going one way or the other');
        assert.ok(v.lane < laneOffsetsFor(v.line).length, 'into a lane that exists');
      }
      v._wasTurning = false;
    }
    for (const v of t.ground) if (v.turning) v._wasTurning = true;
  }
  assert.ok(turnsSeen > 0, 'no vehicle ever completed a turn');
});

test('the whole city of traffic costs a fraction of a frame', () => {
  const t = city();
  const cam = new THREE.Vector3(120, 300, -60);
  run(t, cam, 3);
  const t0 = performance.now();
  const steps = 240;
  for (let i = 0; i < steps; i++) t.update(1 / 60, cam, 10 + i / 60);
  const ms = (performance.now() - t0) / steps;
  console.log(`       ${t.ground.filter((v) => v.active).length} vehicles, ${ms.toFixed(3)} ms/step`);
  assert.ok(ms < 4, `${ms.toFixed(2)} ms per step is too much of a frame`);
});

console.log(`\n${passed} traffic assertions passed${process.exitCode ? ', some failed' : ''}`);
