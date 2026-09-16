/**
 * Northgate Bridge, as something that can be brought down.
 *
 * The thing being checked here is that it comes apart from wherever it was hit. A
 * suspension bridge is a chain rather than a stack, so the support question - can this
 * piece trace a path to the ground? - is asked over the hangers, the cable and the
 * pylons instead of over the deck below, and the answers are what decide whether a hit
 * leaves a hole you can fly through or drops half a span into the channel.
 *
 * Plain Node, against the real bridge the game builds.
 */
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { ObstacleGrid } from '../src/world/CityGenerator.js';
import { createLandmarks } from '../src/world/Landmarks.js';
import { DestructionField, MODULE_STATE } from '../src/world/Destructible.js';
import { EventBus } from '../src/core/EventBus.js';
import { DebrisField } from '../src/fx/Debris.js';
import {
  BRIDGE, BRIDGE_SPAN, clearDeckGaps, deckGone, lineIndexNear, roadSurfaceAt,
} from '../src/world/Roads.js';
import { roadExists } from '../src/world/Traffic.js';
import { AIRCRAFT } from '../src/data/aircraft.js';
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

console.log('\nBridge');

const PIER_X = BRIDGE.SPAN_HALF * BRIDGE.PIER_FRAC;

/** The real bridge, wired to the real destruction field. */
function build() {
  clearDeckGaps();
  const grid = new ObstacleGrid();
  const landmarks = createLandmarks(grid);
  const events = [];
  const bus = new EventBus();
  for (const t of ['structure:impact', 'structure:detach', 'structure:collapse']) {
    bus.on(t, (e) => events.push({ type: t, ...e }));
  }
  // With a debris field, not without one. Every event the destruction system emits is
  // consumed here, and `this.debris?.burst(...)` never evaluates its arguments when
  // debris is missing - so a malformed event sails through a test that leaves it out.
  // One did: the pylon event carried no object for the burst to come from.
  const debris = new DebrisField({
    scene: new THREE.Group(), settings: { preset: { particles: 1 } },
  });
  const field = new DestructionField({ bus, debris });
  for (const b of landmarks.userData.destructibles) field.add(b);
  return { grid, field, deck: landmarks.userData.bridge, events };
}

function hit(w, x, y, { id = 'aurora', seconds = 10 } = {}) {
  const c = AIRCRAFT[id];
  const p = new THREE.Vector3(x, y, BRIDGE_SPAN.z);
  const result = w.field.impact({
    point: p, normal: new THREE.Vector3(-1, 0, 0), direction: new THREE.Vector3(1, 0, 0),
    speed: c.maxSpeed, mass: c.mass,
  });
  const ground = (gx, gz, ceil = Infinity) =>
    Math.max(terrainHeight(gx, gz), w.grid.surfaceBelow(gx, gz, ceil));
  for (let i = 0; i < 60 * seconds; i++) w.field.update(1 / 60, p, ground);
  return result;
}

/** Where the deck is missing, as distances from the middle of the bridge. */
const holeAt = (w) => w.deck.segments.filter((s) => !s.intact)
  .map((s) => s.home.x - BRIDGE_SPAN.x).sort((a, b) => a - b);

// --- how it is put together -------------------------------------------------------

test('the roadway is segments, not one slab', () => {
  const w = build();
  assert.ok(w.deck, 'the bridge is a destructible structure');
  assert.ok(w.deck.segments.length > 40, `${w.deck.segments.length} segments`);
  const span = w.deck.segments.filter((s) => s.onSpan);
  assert.ok(span.length > 20, `${span.length} of them over the main span`);
  // Each one blocks on its own, or a hole in the deck is not a hole you can fly through.
  const boxed = w.deck.segments.filter((s) => s.colliderIndex >= 0);
  assert.equal(boxed.length, w.deck.segments.length, 'every segment has its own collider');
  assert.equal(w.deck.standing, true);
});

test('an intact bridge is a road from one bank to the other', () => {
  build();
  const line = lineIndexNear(BRIDGE_SPAN.z);
  for (const dx of [-900, -400, 0, 400, 900]) {
    assert.ok(roadExists(0, line, BRIDGE_SPAN.x + dx), `no road at ${dx} m`);
  }
});

// --- where it falls ----------------------------------------------------------------

test('a hit on the deck punches a hole, and the rest of the span stays up', () => {
  const w = build();
  const r = hit(w, BRIDGE_SPAN.x, BRIDGE.DECK_Y);
  assert.ok(r.broke > 0, 'something came out of it');
  const hole = holeAt(w);
  assert.ok(hole.length >= 2, `${hole.length} segments down`);
  // Centred on the impact rather than anywhere else.
  const mid = (hole[0] + hole[hole.length - 1]) / 2;
  assert.ok(Math.abs(mid) < 60, `the hole is centred ${mid.toFixed(0)} m from the impact`);
  // And it is a hole, not the end of the bridge.
  assert.equal(w.deck.standing, true, 'the bridge is still standing');
  const span = w.deck.segments.filter((s) => s.onSpan);
  const lost = span.filter((s) => !s.intact).length;
  assert.ok(lost < span.length * 0.5,
    `a deck hit took ${lost} of ${span.length} main-span segments`);
});

test('taking a pylon brings down what that pylon was carrying', () => {
  const w = build();
  hit(w, BRIDGE_SPAN.x - PIER_X, BRIDGE.DECK_Y + 40);
  assert.equal(w.deck.pylons['-1'], false, 'the western pylon is gone');
  assert.equal(w.deck.pylons['1'], true, 'the eastern one is not');

  const span = w.deck.segments.filter((s) => s.onSpan);
  const west = span.filter((s) => s.home.x < BRIDGE_SPAN.x);
  const east = span.filter((s) => s.home.x > BRIDGE_SPAN.x);
  const westLost = west.filter((s) => !s.intact).length;
  const eastLost = east.filter((s) => !s.intact).length;
  assert.ok(westLost > west.length * 0.6,
    `only ${westLost} of ${west.length} western segments came down`);
  assert.ok(eastLost < east.length * 0.4,
    `${eastLost} of ${east.length} eastern segments came down with the wrong pylon`);
});

test('a hit on an approach leaves the main span alone', () => {
  const w = build();
  hit(w, BRIDGE_SPAN.x - 900, 40);
  const span = w.deck.segments.filter((s) => s.onSpan);
  assert.equal(span.filter((s) => !s.intact).length, 0,
    'the main span came down with an approach');
  assert.ok(holeAt(w).length > 0, 'but the approach did lose something');
});

// --- and it falls progressively -----------------------------------------------------

test('the collapse walks outwards from the impact rather than dropping at once', () => {
  // This is the thing that was asked for. A pylon hit condemns most of a span, but the
  // span does not vanish on the frame of the impact: it lets go from the failure
  // outwards, each segment pulled off by the one next to it already falling.
  const w = build();
  const c = AIRCRAFT.aurora;
  const p = new THREE.Vector3(BRIDGE_SPAN.x - PIER_X, BRIDGE.DECK_Y + 40, BRIDGE_SPAN.z);
  w.field.impact({
    point: p, normal: new THREE.Vector3(-1, 0, 0), direction: new THREE.Vector3(1, 0, 0),
    speed: c.maxSpeed, mass: c.mass,
  });
  const ground = (gx, gz, ceil = Infinity) =>
    Math.max(terrainHeight(gx, gz), w.grid.surfaceBelow(gx, gz, ceil));

  const atImpact = w.deck.segments.filter((s) => !s.intact).length;
  const trace = [atImpact];
  for (let i = 0; i < 60 * 6; i++) {
    w.field.update(1 / 60, p, ground);
    if (i % 15 === 0) trace.push(w.deck.segments.filter((s) => !s.intact).length);
  }
  const final = trace[trace.length - 1];
  assert.ok(final > atImpact,
    `nothing followed the blast: ${atImpact} down at impact, ${final} at the end`);
  // It must not all arrive in one frame either, or it is not a collapse, it is a cut.
  assert.ok(atImpact < final * 0.75,
    `${atImpact} of ${final} were already down on the frame of the impact`);
  // And it must finish, rather than creeping along the deck forever.
  assert.equal(trace[trace.length - 1], trace[trace.length - 2], 'the collapse settles');
});

test('the front spreads away from the impact, not from the far end', () => {
  const w = build();
  const c = AIRCRAFT.aurora;
  const p = new THREE.Vector3(BRIDGE_SPAN.x - PIER_X, BRIDGE.DECK_Y + 40, BRIDGE_SPAN.z);
  w.field.impact({
    point: p, normal: new THREE.Vector3(-1, 0, 0), direction: new THREE.Vector3(1, 0, 0),
    speed: c.maxSpeed, mass: c.mass,
  });
  const ground = (gx, gz, ceil = Infinity) =>
    Math.max(terrainHeight(gx, gz), w.grid.surfaceBelow(gx, gz, ceil));
  const order = [];
  const seen = new Set();
  for (let i = 0; i < 60 * 6; i++) {
    for (const s of w.deck.segments) {
      if (!s.intact && !seen.has(s.index)) {
        seen.add(s.index);
        order.push(Math.abs(s.home.x - p.x));
      }
    }
    w.field.update(1 / 60, p, ground);
  }
  assert.ok(order.length > 6, `${order.length} segments fell`);
  // The first to go are near the impact; the last are the far ones.
  const firstFew = order.slice(0, 4).reduce((a, b) => a + b, 0) / 4;
  const lastFew = order.slice(-4).reduce((a, b) => a + b, 0) / 4;
  assert.ok(lastFew > firstFew,
    `the collapse started ${firstFew.toFixed(0)} m from the impact and ended ${lastFew.toFixed(0)} m away`);
});

// --- what it means for everything else ----------------------------------------------

test('the road is gone where the deck is gone, and only there', () => {
  const w = build();
  hit(w, BRIDGE_SPAN.x, BRIDGE.DECK_Y);
  const line = lineIndexNear(BRIDGE_SPAN.z);
  const hole = holeAt(w);
  const insideHole = BRIDGE_SPAN.x + (hole[0] + hole[hole.length - 1]) / 2;
  assert.ok(deckGone(insideHole), 'the surface knows the deck is missing');
  assert.equal(roadSurfaceAt(insideHole, BRIDGE_SPAN.z).onBridge, 0,
    'so there is no deck to drive on');
  assert.equal(roadExists(0, line, insideHole), false, 'and no road for traffic');
  // The far side of the bridge is untouched and still a road.
  const farSide = BRIDGE_SPAN.x + BRIDGE.SPAN_HALF * 0.8;
  assert.ok(roadSurfaceAt(farSide, BRIDGE_SPAN.z).onBridge > 0, 'the far side still has a deck');
  assert.equal(roadExists(0, line, farSide), true, 'and traffic can still use it');
});

test('a fallen span stops being something to fly into', () => {
  const w = build();
  hit(w, BRIDGE_SPAN.x, BRIDGE.DECK_Y);
  for (const s of w.deck.segments) {
    if (s.intact) continue;
    assert.equal(s.colliderIndex, -1, 'a fallen segment gave back its collision box');
  }
  // And what is still up still blocks.
  const up = w.deck.segments.filter((s) => s.intact && s.colliderIndex >= 0);
  assert.ok(up.length > 20, `${up.length} segments still block`);
});

test('the wreckage falls, lands and stops', () => {
  const w = build();
  hit(w, BRIDGE_SPAN.x, BRIDGE.DECK_Y, { seconds: 16 });
  const fallen = w.deck.segments.filter((s) => !s.intact);
  assert.ok(fallen.length > 0);
  for (const s of fallen) {
    assert.ok(s.centre.y < BRIDGE.DECK_Y - 10,
      `a segment is still up at ${s.centre.y.toFixed(0)} m`);
    assert.ok(s.state === MODULE_STATE.SETTLED || s.velocity.lengthSq() < 9,
      'and has come to rest');
  }
});

test('reset puts the bridge back', () => {
  const w = build();
  hit(w, BRIDGE_SPAN.x - PIER_X, BRIDGE.DECK_Y + 40);
  assert.ok(w.deck.segments.some((s) => !s.intact), 'something came down');
  w.deck.reset();
  assert.equal(w.deck.segments.every((s) => s.intact), true, 'every segment is back');
  assert.equal(w.deck.pylons['-1'], true, 'and both pylons');
  assert.equal(w.deck.standing, true);
  assert.equal(deckGone(BRIDGE_SPAN.x - PIER_X), false, 'and the road is a road again');
});

console.log(`\n${passed} bridge assertions passed${process.exitCode ? ', some failed' : ''}`);
