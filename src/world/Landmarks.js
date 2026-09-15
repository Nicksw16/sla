import * as THREE from 'three';
import { lerp, smoothstep } from '../core/MathUtils.js';
import { Rng } from '../core/Rng.js';
import { LANDMARKS, RUNWAY } from '../data/regions.js';
import { terrainHeight, isWater } from './Terrain.js';
import { DestructibleBuilding, RigidProp } from './Destructible.js';

/**
 * Hand-placed landmarks (spec §25-26).
 *
 * These are the objects the player navigates by, so each one has a silhouette
 * nothing else in the city shares. They also carry the deliberate flyable gaps —
 * under the bridge deck, through the ridge pass — that make a risky line possible
 * (§34, §113). Colliders are registered with a base as well as a top, so "under"
 * is genuinely open air rather than an invisible wall.
 */

const M = {
  concrete: () => new THREE.MeshStandardMaterial({ color: 0xa9a49b, roughness: 0.92, metalness: 0.04 }),
  steel: () => new THREE.MeshStandardMaterial({ color: 0x7d8793, roughness: 0.5, metalness: 0.7 }),
  red: () => new THREE.MeshStandardMaterial({ color: 0xc23a2b, roughness: 0.6, metalness: 0.2 }),
  glass: () => new THREE.MeshStandardMaterial({
    color: 0x7fc4dc, roughness: 0.1, metalness: 0.3, transparent: true, opacity: 0.7,
  }),
  dark: () => new THREE.MeshStandardMaterial({ color: 0x2a2f36, roughness: 0.8, metalness: 0.2 }),
  asphalt: () => new THREE.MeshStandardMaterial({ color: 0x33373c, roughness: 0.95, metalness: 0 }),
  grass: () => new THREE.MeshStandardMaterial({ color: 0x3f5a2e, roughness: 1, metalness: 0 }),
  marking: () => new THREE.MeshBasicMaterial({ color: 0xf0f0e8 }),
  beacon: (c) => new THREE.MeshBasicMaterial({ color: c }),
};

function mesh(geo, mat, x, y, z, rot = 0) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  if (rot) m.rotation.y = rot;
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

/** Skyline Tower: the city's single most useful orientation cue. */
function buildSpire(g, grid, L, mats) {
  const base = terrainHeight(L.x, L.z);
  const h = L.height;
  // Four tapering stages.
  const stages = [
    { y: 0.00, hh: 0.42, w: 38 },
    { y: 0.42, hh: 0.28, w: 26 },
    { y: 0.70, hh: 0.16, w: 17 },
  ];
  for (const s of stages) {
    g.add(mesh(new THREE.BoxGeometry(s.w, h * s.hh, s.w), mats.concrete, L.x, base + h * s.y + h * s.hh / 2, L.z));
  }
  // Observation deck: the wide ring that makes the silhouette unmistakable.
  g.add(mesh(new THREE.CylinderGeometry(30, 30, 14, 16), mats.glass, L.x, base + h * 0.74, L.z));
  g.add(mesh(new THREE.CylinderGeometry(33, 33, 2.5, 16), mats.steel, L.x, base + h * 0.74 - 8, L.z));
  // Mast and aircraft warning beacon.
  g.add(mesh(new THREE.CylinderGeometry(1.4, 2.6, h * 0.24, 8), mats.steel, L.x, base + h * 0.88, L.z));
  const beacon = mesh(new THREE.SphereGeometry(3.4, 8, 6), M.beacon(0xff3b30), L.x, base + h, L.z);
  beacon.castShadow = false;
  g.add(beacon);
  grid.add(L.x - 20, L.x + 20, L.z - 20, L.z + 20, base, base + h, 'landmark');
  return beacon;
}

function buildObelisk(g, grid, L, mats) {
  const base = terrainHeight(L.x, L.z);
  const h = L.height;
  const geo = new THREE.CylinderGeometry(9, 30, h, 4);
  g.add(mesh(geo, mats.glass, L.x, base + h / 2, L.z, Math.PI / 4));
  g.add(mesh(new THREE.ConeGeometry(9, 34, 4), mats.steel, L.x, base + h + 17, L.z, Math.PI / 4));
  const beacon = mesh(new THREE.SphereGeometry(2.6, 8, 6), M.beacon(0xff3b30), L.x, base + h + 36, L.z);
  g.add(beacon);
  grid.add(L.x - 22, L.x + 22, L.z - 22, L.z + 22, base, base + h + 34, 'landmark');
  return beacon;
}

/** Ridgeway Stadium: an open bowl you can drop into and climb back out of. */
function buildStadium(g, grid, L, mats) {
  const base = terrainHeight(L.x, L.z);
  const h = L.height;
  const outer = 150, inner = 112;
  const ring = new THREE.Mesh(new THREE.CylinderGeometry(outer, outer * 1.06, h, 28, 1, true), mats.concrete);
  ring.position.set(L.x, base + h / 2, L.z);
  ring.castShadow = true;
  g.add(ring);
  // Canopy roof leaning inward.
  const roof = new THREE.Mesh(new THREE.RingGeometry(inner, outer * 1.04, 28), mats.steel);
  roof.rotation.x = -Math.PI / 2;
  roof.position.set(L.x, base + h, L.z);
  g.add(roof);
  // Pitch.
  const pitch = new THREE.Mesh(new THREE.CircleGeometry(inner - 6, 28), mats.grass);
  pitch.rotation.x = -Math.PI / 2;
  pitch.position.set(L.x, base + 1.2, L.z);
  g.add(pitch);
  // Floodlight pylons.
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const px = L.x + Math.cos(a) * outer * 0.98;
    const pz = L.z + Math.sin(a) * outer * 0.98;
    g.add(mesh(new THREE.BoxGeometry(4, h * 0.75, 4), mats.steel, px, base + h + h * 0.37, pz));
    const lamp = mesh(new THREE.BoxGeometry(16, 5, 3), M.beacon(0xfff4d0), px, base + h * 1.75, pz);
    g.add(lamp);
  }
  // The bowl wall is solid; the middle is open air.
  const step = (Math.PI * 2) / 16;
  for (let i = 0; i < 16; i++) {
    const a = i * step;
    const px = L.x + Math.cos(a) * outer;
    const pz = L.z + Math.sin(a) * outer;
    grid.add(px - 20, px + 20, pz - 20, pz + 20, base, base + h, 'landmark');
  }
}

const _zAxis = new THREE.Vector3(0, 0, 1);
const _batchM = new THREE.Matrix4();
const _batchQ = new THREE.Quaternion();
const _batchP = new THREE.Vector3();
const _batchS = new THREE.Vector3();

/**
 * A pile of identically-shaped boxes drawn in one call.
 *
 * The bridge needs a few hundred of them - every hanger, every segment of the main
 * cable, every slab and parapet of the two approach roads - and each one differs only
 * in where it sits, how long it is and how far it leans. One instanced mesh draws the
 * lot, which is what lets the bridge be this detailed and still cost less to draw than
 * the bare slab it replaces.
 *
 * The bounding sphere has to be computed from the instances rather than left as the
 * unit box's, or the whole batch vanishes the moment the camera looks away from the
 * world origin.
 */
class BoxBatch {
  constructor(material, capacity) {
    this.mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), material, capacity);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.count = 0;
  }

  /** One box, sized and leaned. `rotZ` is the lean in the x/y plane, in radians. */
  add(x, y, z, sx, sy, sz, rotZ = 0) {
    _batchQ.setFromAxisAngle(_zAxis, rotZ);
    _batchM.compose(_batchP.set(x, y, z), _batchQ, _batchS.set(sx, sy, sz));
    this.mesh.setMatrixAt(this.count++, _batchM);
  }

  /** A box spanning two points in the x/y plane, at a fixed z. */
  span(xa, ya, xb, yb, z, thick, width) {
    const dx = xb - xa;
    const dy = yb - ya;
    const len = Math.hypot(dx, dy);
    if (len < 0.05) return;
    this.add((xa + xb) / 2, (ya + yb) / 2, z, len, thick, width, Math.atan2(dy, dx));
  }

  finish(g) {
    this.mesh.count = this.count;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (!this.count) return null;
    this.mesh.computeBoundingSphere();
    g.add(this.mesh);
    return this.mesh;
  }
}

/**
 * Northgate Bridge. The gap under the deck is a legal shortcut (spec §24, §34).
 *
 * The deck is level, sits a chosen height above the water rather than a fraction of the
 * landmark's height, and stands on two piers that carry on down to the dredged channel
 * bed. The road gets up to it by climbing: a graded approach on each bank that leaves
 * the deck at its own height, runs out on piers of its own and settles onto the ground
 * where the shore is - up one side, across, and down the other.
 *
 * None of that was here before. The deck hung at 0.52 of the landmark height with
 * nothing whatsoever underneath it, and the approach ramps were two flat slabs floating
 * off each end at a height matching neither the deck nor the ground. From the air the
 * whole thing read as what it was: a road surface suspended in mid-air over a channel.
 *
 * The numbers that matter here are the water and the channel bed, not L.height. The
 * clearance under the deck is a piece of level design - the mission that flies the
 * channel passes under it, and a beacon hides beneath it - so it is a height somebody
 * chose, written down once.
 */
const BRIDGE = {
  DECK_Y: 78,        // deck surface above the water. This is the flyable gap.
  SPAN_HALF: 420,    // half the main span; the dredged channel is 920 m wide here
  DECK_W: 34,
  PIER_FRAC: 0.46,   // where the pylons stand, as a fraction of the half-span
  GRADE_RUN: 700,    // how far each approach takes to come down from the deck
  LEVEL_RUN: 160,    // and how much of it carries on at ground level afterwards
  STATIONS: 30,      // hanger spacing across the span
  RAMP_SEGS: 22,     // slabs per approach; each one leans a little less than the last
};

function buildBridge(g, grid, L, mats) {
  const { DECK_Y: deckY, SPAN_HALF: spanHalf, DECK_W: deckW, PIER_FRAC } = BRIDGE;
  const h = L.height;
  const pierX = spanHalf * PIER_FRAC;
  const towerTop = deckY + h - 22;
  const halfW = deckW / 2;

  // --- main deck, as a thin slab: only the slab itself blocks, so flying under works.
  g.add(mesh(new THREE.BoxGeometry(spanHalf * 2, 3.4, deckW), mats.concrete, L.x, deckY, L.z));
  g.add(mesh(new THREE.BoxGeometry(spanHalf * 2, 0.5, deckW - 3), mats.asphalt, L.x, deckY + 1.95, L.z));
  g.add(mesh(new THREE.BoxGeometry(spanHalf * 2 - 40, 0.1, 1.1), mats.marking, L.x, deckY + 2.25, L.z));
  for (const zo of [-halfW, halfW]) {
    g.add(mesh(new THREE.BoxGeometry(spanHalf * 2, 2.2, 1.2), mats.steel, L.x, deckY + 2.4, L.z + zo));
  }
  grid.add(L.x - spanHalf, L.x + spanHalf, L.z - halfW, L.z + halfW, deckY - 3, deckY + 4, 'bridge');

  // --- the cable, as a height above the deck at any point along it.
  //
  // A suspension bridge's cable sags between its towers and runs straight down to an
  // anchorage at each end. The first version had it the wrong way round: hangers over
  // the two side spans and nothing at all over the main span, so the middle of the
  // bridge - the part you fly under - hung from nothing.
  const cableY = (dx) => {
    const a = Math.abs(dx);
    if (a <= pierX) {
      const u = a / pierX;
      return lerp(deckY + 16, towerTop, u * u);
    }
    return lerp(towerTop, deckY + 5, (a - pierX) / (spanHalf - pierX));
  };

  // --- piers and pylons. The pier is founded on the bed and carries the deck; the
  // pylon stands on the pier and carries the cable.
  const bed = terrainHeight(L.x, L.z);
  for (const side of [-1, 1]) {
    const tx = L.x + side * pierX;
    g.add(mesh(new THREE.BoxGeometry(30, 15, deckW + 24), mats.concrete, tx, -1, L.z));
    for (const zo of [-halfW, halfW]) {
      g.add(mesh(new THREE.BoxGeometry(15, deckY - bed, 15), mats.concrete, tx, (bed + deckY) / 2, L.z + zo));
      g.add(mesh(new THREE.BoxGeometry(11, h, 11), mats.red, tx, deckY + h / 2, L.z + zo));
    }
    g.add(mesh(new THREE.BoxGeometry(30, 5, deckW + 14), mats.red, tx, towerTop + 6, L.z));
    g.add(mesh(new THREE.BoxGeometry(22, 4, deckW + 8), mats.red, tx, deckY + h * 0.45, L.z));
    grid.add(tx - 8, tx + 8, L.z - halfW - 8, L.z + halfW + 8, bed, deckY + h, 'landmark');
  }

  // --- cable and hangers, both batched into one draw call.
  const stations = Math.round((spanHalf * 2) / BRIDGE.STATIONS);
  const rigging = new BoxBatch(mats.steel, stations * 4 + 8);
  for (const zo of [-halfW, halfW]) {
    let px = -spanHalf;
    let py = cableY(px);
    for (let i = 1; i <= stations; i++) {
      const dx = lerp(-spanHalf, spanHalf, i / stations);
      const y = cableY(dx);
      rigging.span(L.x + px, py, L.x + dx, y, L.z + zo, 1.5, 1.5);
      px = dx; py = y;
      // One hanger per station, except where the cable has already met the deck.
      const drop = y - (deckY + 2);
      if (drop > 4) rigging.add(L.x + dx, deckY + 2 + drop / 2, L.z + zo, 0.7, drop, 0.7);
    }
  }
  rigging.finish(g);

  // --- the approaches: a road that climbs.
  //
  // The profile eases out of the deck, grades down at about one in ten and eases onto
  // the ground, and is then clamped to the terrain so the last stretch follows the
  // shore rather than burying itself in it. Every slab that ends up more than a few
  // metres clear of the ground gets a pier under it, which is the difference between a
  // road on an embankment and a road hanging in the air.
  const run = BRIDGE.GRADE_RUN + BRIDGE.LEVEL_RUN;
  const segs = BRIDGE.RAMP_SEGS;
  const road = new BoxBatch(mats.asphalt, segs * 2 + 4);
  const parapet = new BoxBatch(mats.concrete, segs * 4 + 8);
  const stripe = new BoxBatch(mats.marking, segs * 2 + 4);
  const piers = new BoxBatch(mats.concrete, segs * 6 + 8);

  for (const side of [-1, 1]) {
    const x0 = L.x + side * spanHalf;
    const foot = terrainHeight(x0 + side * BRIDGE.GRADE_RUN, L.z);
    const profile = (t) => {
      const x = x0 + side * run * t;
      const graded = lerp(deckY, foot + 2.4, smoothstep(0, BRIDGE.GRADE_RUN / run, t));
      return { x, y: Math.max(graded, terrainHeight(x, L.z) + 2.4) };
    };

    let a = profile(0);
    for (let i = 1; i <= segs; i++) {
      const b = profile(i / segs);
      const lean = Math.atan2(b.y - a.y, b.x - a.x);
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      road.add(mx, my, L.z, len, 3.4, deckW, lean);
      stripe.add(mx, my + 1.85, L.z, len * 0.92, 0.1, 1.1, lean);
      for (const zo of [-halfW, halfW]) {
        parapet.add(mx, my + 1.6, L.z + zo, len, 2, 1.2, lean);
      }

      // A pier under the slab wherever the road is clear of the ground, founded on the
      // bed where that ground is under water.
      const ground = terrainHeight(mx, L.z);
      const clearance = my - 1.7 - ground;
      if (clearance > 7) {
        for (const zo of [-deckW * 0.3, deckW * 0.3]) {
          piers.add(mx, ground + clearance / 2, L.z + zo, 4.4, clearance, 4.4);
        }
        piers.add(mx, my - 2.4, L.z, 9, 2.2, deckW + 4);
        // The pier blocks, as the pylons do. A bridge you can fly through the legs of
        // is the same class of wrong as a bridge with no legs at all.
        grid.add(mx - 5, mx + 5, L.z - deckW * 0.3 - 3, L.z + deckW * 0.3 + 3,
          ground, my - 1.3, 'bridge');
      }

      const lo = Math.min(a.y, b.y);
      const hi = Math.max(a.y, b.y);
      grid.add(Math.min(a.x, b.x), Math.max(a.x, b.x), L.z - halfW, L.z + halfW,
        lo - 3, hi + 4, 'bridge');
      a = b;
    }
  }
  road.finish(g);
  parapet.finish(g);
  stripe.finish(g);
  piers.finish(g);
}

function buildWheel(g, grid, L, mats) {
  const base = terrainHeight(L.x, L.z);
  const r = L.height * 0.42;
  const cy = base + r + 12;
  const wheel = new THREE.Group();
  const rim = new THREE.Mesh(new THREE.TorusGeometry(r, 1.5, 6, 36), mats.steel);
  wheel.add(rim);
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    const spoke = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, r * 2, 4), mats.steel);
    spoke.rotation.z = a;
    wheel.add(spoke);
    const car = new THREE.Mesh(new THREE.BoxGeometry(5, 5, 6), M.beacon(i % 2 ? 0xff6a3d : 0x3dd6ff));
    car.position.set(Math.cos(a) * r, Math.sin(a) * r, 0);
    wheel.add(car);
  }
  wheel.position.set(L.x, cy, L.z);
  g.add(wheel);
  // A-frame supports.
  for (const side of [-1, 1]) {
    g.add(mesh(new THREE.CylinderGeometry(1.6, 2.6, r + 14, 6), mats.steel, L.x + side * r * 0.4, base + (r + 14) / 2, L.z + side * 6));
  }
  grid.add(L.x - 8, L.x + 8, L.z - 8, L.z + 8, base, cy + r, 'landmark');
  return wheel;
}

function buildCranes(g, grid, L, mats) {
  const rng = new Rng(4242);
  for (let i = 0; i < 5; i++) {
    const x = L.x + i * 150 - 300;
    const z = L.z;
    const base = terrainHeight(x, z);
    const h = 52 + rng.range(-6, 12);
    // Legs, gantry beam and cantilevered boom out over the water.
    for (const dx of [-14, 14]) {
      for (const dz of [-12, 12]) {
        g.add(mesh(new THREE.BoxGeometry(2.4, h, 2.4), mats.red, x + dx, base + h / 2, z + dz));
      }
    }
    g.add(mesh(new THREE.BoxGeometry(36, 4, 32), mats.red, x, base + h, z));
    g.add(mesh(new THREE.BoxGeometry(6, 3, 128), mats.red, x, base + h + 6, z + 40));
    g.add(mesh(new THREE.BoxGeometry(8, 8, 10), mats.dark, x, base + h - 6, z + 70));
    grid.add(x - 16, x + 16, z - 14, z + 14, base, base + h + 8, 'landmark');

    // Container stacks, which is what makes a port read as a port from the air.
    for (let c = 0; c < 8; c++) {
      const cx = x + rng.range(-60, 60);
      const cz = z - 90 - rng.range(0, 120);
      const stack = rng.int(1, 4);
      const cb = terrainHeight(cx, cz);
      const hue = rng.pick([0xc0392b, 0x2980b9, 0x27ae60, 0xd4ac0d, 0x8e44ad]);
      g.add(mesh(new THREE.BoxGeometry(12, 2.6 * stack, 30), new THREE.MeshStandardMaterial({ color: hue, roughness: 0.8 }), cx, cb + 1.3 * stack, cz));
      grid.add(cx - 6, cx + 6, cz - 15, cz + 15, cb, cb + 2.6 * stack, 'building');
    }
  }
}

function buildDam(g, grid, L, mats) {
  const base = terrainHeight(L.x, L.z);
  const h = L.height;
  const width = 460;
  // Slight arch, built from segments.
  const segs = 12;
  for (let i = 0; i < segs; i++) {
    const t = i / (segs - 1) - 0.5;
    const x = L.x + t * width;
    const z = L.z + Math.cos(t * Math.PI) * 26;
    const segW = width / segs + 6;
    g.add(mesh(new THREE.BoxGeometry(segW, h, 22), mats.concrete, x, base + h / 2 - 8, z));
    grid.add(x - segW / 2, x + segW / 2, z - 11, z + 11, base - 8, base + h - 8, 'landmark');
  }
  // Reservoir behind it.
  const water = new THREE.Mesh(new THREE.PlaneGeometry(width * 1.4, 520), new THREE.MeshStandardMaterial({
    color: 0x27596b, roughness: 0.18, metalness: 0.5,
  }));
  water.rotation.x = -Math.PI / 2;
  water.position.set(L.x, base + h - 22, L.z - 290);
  g.add(water);
}

function buildControlTower(g, grid, L, mats) {
  const base = terrainHeight(L.x, L.z);
  const h = L.height;
  g.add(mesh(new THREE.CylinderGeometry(6, 9, h, 12), mats.concrete, L.x, base + h / 2, L.z));
  g.add(mesh(new THREE.CylinderGeometry(14, 11, 12, 12), mats.glass, L.x, base + h + 4, L.z));
  g.add(mesh(new THREE.CylinderGeometry(15, 15, 1.6, 12), mats.dark, L.x, base + h + 11, L.z));
  const beacon = mesh(new THREE.SphereGeometry(2, 8, 6), M.beacon(0x3dff7a), L.x, base + h + 14, L.z);
  g.add(beacon);
  grid.add(L.x - 12, L.x + 12, L.z - 12, L.z + 12, base, base + h + 12, 'landmark');
  return beacon;
}

function buildMarina(g, grid, L, mats) {
  const rng = new Rng(909);
  const hullMat = new THREE.MeshStandardMaterial({ color: 0xe8ecef, roughness: 0.5 });
  const sailMat = new THREE.MeshStandardMaterial({ color: 0xf5f5f0, roughness: 0.8, side: THREE.DoubleSide });
  for (let p = 0; p < 4; p++) {
    const px = L.x + p * 110 - 165;
    g.add(mesh(new THREE.BoxGeometry(8, 2, 190), mats.concrete, px, 1.5, L.z + 60));
    for (let b = 0; b < 7; b++) {
      const side = b % 2 ? 1 : -1;
      const bx = px + side * 13;
      const bz = L.z - 20 + b * 26;
      g.add(mesh(new THREE.BoxGeometry(5, 2.4, 13), hullMat, bx, 1.4, bz, rng.range(-0.1, 0.1)));
      const mast = mesh(new THREE.CylinderGeometry(0.2, 0.2, 15, 4), mats.steel, bx, 9, bz);
      mast.castShadow = false;
      g.add(mast);
      const sail = mesh(new THREE.PlaneGeometry(5, 11), sailMat, bx + 1.6, 8, bz, Math.PI / 2);
      sail.castShadow = false;
      g.add(sail);
    }
  }
}

/** Trees, for the park and the countryside. Instanced; they are everywhere. */
function buildVegetation(g) {
  const rng = new Rng(777);
  const trunkGeo = new THREE.CylinderGeometry(0.5, 0.7, 4, 5);
  const crownGeo = new THREE.ConeGeometry(3.6, 9, 6);
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x53412c, roughness: 1 });
  const crownMat = new THREE.MeshStandardMaterial({ color: 0x2f4a22, roughness: 1 });

  const spots = [];
  // Central Park.
  for (let i = 0; i < 260; i++) {
    const a = rng.range(0, Math.PI * 2), r = Math.sqrt(rng.next()) * 250;
    spots.push([-620 + Math.cos(a) * r, 640 + Math.sin(a) * r]);
  }
  // Countryside treelines, following field boundaries.
  for (let i = 0; i < 700; i++) {
    const x = rng.range(-1450, 1450);
    const z = rng.range(-4400, -1600);
    spots.push([x, z]);
  }
  // Lower mountain slopes.
  for (let i = 0; i < 420; i++) {
    const x = rng.range(-4400, -1700);
    const z = rng.range(-4400, -1700);
    if (terrainHeight(x, z) > 520) continue;
    spots.push([x, z]);
  }

  const valid = spots.filter(([x, z]) => !isWater(x, z));
  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, valid.length);
  const crowns = new THREE.InstancedMesh(crownGeo, crownMat, valid.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();
  valid.forEach(([x, z], i) => {
    const y = terrainHeight(x, z);
    const scale = rng.range(0.7, 1.5);
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rng.range(0, Math.PI));
    p.set(x, y + 2 * scale, z);
    s.set(scale, scale, scale);
    m.compose(p, q, s);
    trunks.setMatrixAt(i, m);
    p.set(x, y + 4 * scale + 4 * scale, z);
    m.compose(p, q, s);
    crowns.setMatrixAt(i, m);
  });
  trunks.castShadow = false;
  crowns.castShadow = true;
  g.add(trunks, crowns);
  return valid.length;
}

/** Skyline International: runway, taxiway, terminal, hangars, lighting (§60). */
function buildAirport(g, grid, mats) {
  const { x, z, length, width, elevation } = RUNWAY;
  const group = new THREE.Group();
  group.name = 'airport';

  const strip = new THREE.Mesh(new THREE.PlaneGeometry(length, width), mats.asphalt);
  strip.rotation.x = -Math.PI / 2;
  strip.position.set(x, elevation + 0.25, z);
  strip.receiveShadow = true;
  group.add(strip);

  // Centreline and threshold bars.
  const dashGeo = new THREE.PlaneGeometry(38, 1.4);
  const dashes = new THREE.InstancedMesh(dashGeo, mats.marking, Math.floor(length / 76));
  const m = new THREE.Matrix4();
  for (let i = 0; i < dashes.count; i++) {
    m.makeRotationX(-Math.PI / 2);
    m.setPosition(x - length / 2 + 40 + i * 76, elevation + 0.35, z);
    dashes.setMatrixAt(i, m);
  }
  group.add(dashes);
  for (const side of [-1, 1]) {
    for (let i = 0; i < 8; i++) {
      const bar = new THREE.Mesh(new THREE.PlaneGeometry(46, 2.6), mats.marking);
      bar.rotation.x = -Math.PI / 2;
      bar.position.set(x + side * (length / 2 - 40), elevation + 0.35, z - 18 + i * 5);
      group.add(bar);
    }
  }

  // Taxiway and apron.
  const taxi = new THREE.Mesh(new THREE.PlaneGeometry(length * 0.8, 26), mats.asphalt);
  taxi.rotation.x = -Math.PI / 2;
  taxi.position.set(x, elevation + 0.2, z - 150);
  group.add(taxi);
  const apron = new THREE.Mesh(new THREE.PlaneGeometry(420, 180), mats.asphalt);
  apron.rotation.x = -Math.PI / 2;
  apron.position.set(x - 300, elevation + 0.2, z - 260);
  group.add(apron);

  // Terminal and hangars.
  const terminal = mesh(new THREE.BoxGeometry(360, 26, 70), mats.glass, x - 300, elevation + 13, z - 330);
  group.add(terminal);
  grid.add(x - 480, x - 120, z - 365, z - 295, elevation, elevation + 26, 'building');
  for (let i = 0; i < 3; i++) {
    const hx = x + 180 + i * 130;
    const hangar = mesh(new THREE.BoxGeometry(110, 24, 90), mats.steel, hx, elevation + 12, z - 300);
    group.add(hangar);
    const roof = mesh(new THREE.CylinderGeometry(55, 55, 90, 12, 1, false, 0, Math.PI), mats.steel, hx, elevation + 24, z - 300);
    roof.rotation.z = Math.PI / 2;
    roof.rotation.y = Math.PI / 2;
    group.add(roof);
    grid.add(hx - 55, hx + 55, z - 345, z - 255, elevation, elevation + 50, 'building');
  }

  // Runway edge lighting: the reason a night landing is possible at all (§63).
  const lampGeo = new THREE.SphereGeometry(1.1, 5, 4);
  const edgeMat = M.beacon(0xffffff);
  const thrMat = M.beacon(0x2fff6a);
  const count = Math.floor(length / 60);
  const lights = new THREE.InstancedMesh(lampGeo, edgeMat, count * 2);
  for (let i = 0; i < count; i++) {
    for (let s = 0; s < 2; s++) {
      m.identity();
      m.setPosition(x - length / 2 + i * 60, elevation + 1, z + (s ? width / 2 : -width / 2));
      lights.setMatrixAt(i * 2 + s, m);
    }
  }
  group.add(lights);
  for (const side of [-1, 1]) {
    const thr = new THREE.InstancedMesh(lampGeo, thrMat, 8);
    for (let i = 0; i < 8; i++) {
      m.identity();
      m.setPosition(x + side * (length / 2 + 6), elevation + 1, z - 21 + i * 6);
      thr.setMatrixAt(i, m);
    }
    group.add(thr);
  }

  g.add(group);
  return { runwayLights: lights };
}
/**
 * Curtain wall for the towers.
 *
 * The city's own facades are drawn by a shader on an instanced mesh, which needs
 * per-instance attributes these do not have, so they get their own version of the
 * same idea. The emphasis is deliberately vertical: closely spaced columns running
 * the full height, with the floor lines much fainter between them. On a tower whose
 * cross-section never changes, that striping is the whole character - it is what
 * stops a square prism four hundred metres tall from reading as a plain block, and
 * it does the job the setbacks were doing before without pretending the building
 * tapers when it does not.
 */
function towerMaterial() {
  // Low metalness on purpose. The world has no environment map - the only specular
  // input is the sun - so a metalness of 0.6 has almost nothing to reflect and the
  // towers came out as two black cutouts against the skyline.
  const mat = new THREE.MeshStandardMaterial({
    color: 0xb9c3c9, roughness: 0.34, metalness: 0.22,
  });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTowerNight = mat.userData.uniforms.uTowerNight;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        varying vec3 vTowerPos;
        varying vec3 vTowerNormal;`)
      // The shaft is drawn as instances of one module-sized box, so the vertex's own
      // position is only its place within a slab. What the curtain wall needs is its
      // place within the *tower*, or the columns and floor lines would restart at
      // every module seam. The instance matrix is exactly that transform - and it
      // keeps working once a module detaches, so a slab carries its own stripe of
      // facade down with it instead of resampling the pattern as it falls.
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        #ifdef USE_INSTANCING
          vTowerPos = (instanceMatrix * vec4(transformed, 1.0)).xyz;
          vTowerNormal = mat3(instanceMatrix) * normal;
        #else
          vTowerPos = position;
          vTowerNormal = normal;
        #endif`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uTowerNight;
        varying vec3 vTowerPos;
        varying vec3 vTowerNormal;
        // A soft line at a fixed spacing in metres, about a pixel wide however far
        // away it is, and faded out entirely once the spacing goes sub-pixel so it
        // cannot crawl.
        float towerBand(float v, float pitch, float weight) {
          float n = v / pitch;
          float d = abs(n - floor(n + 0.5)) * pitch;
          float px = fwidth(v);
          float w = max(pitch * weight, px * 0.8);
          return (1.0 - smoothstep(w * 0.45, w * 1.1, d))
               * (1.0 - smoothstep(pitch * 0.22, pitch * 0.62, px));
        }`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        vec3 tn = abs(normalize(vTowerNormal));
        // Columns every metre and a bit, on whichever face this is. The narrow
        // spacing is the point: it is what gives the facade its grain.
        //
        // The axis has to be the one that runs *along* the wall, not the one the wall
        // faces: on a face whose normal is x, x is the same value at every point on
        // it, and banding a constant produces one flat tone across the whole facade.
        // That is what these towers were doing - the columns this function exists to
        // draw never appeared, and the night windows below banded horizontally
        // because their bay index was constant too.
        float alongX = step(tn.z, tn.x);   // 1 on the faces that look along x
        float columns = mix(towerBand(vTowerPos.x, 1.15, 0.30),
                            towerBand(vTowerPos.z, 1.15, 0.30), alongX);
        columns *= 1.0 - tn.y;            // never on the roof
        float floors = towerBand(vTowerPos.y, 3.7, 0.10) * (1.0 - tn.y);

        diffuseColor.rgb *= 1.0 - columns * 0.30;
        diffuseColor.rgb *= 1.0 - floors * 0.16;
        roughnessFactor = clamp(roughnessFactor + columns * 0.3, 0.05, 1.0);
        // Sky and street bounce, cut right back after dark so the lit floors carry
        // the contrast instead of competing with a grey wash. The instanced city
        // gets the same treatment through its uFill uniform.
        totalEmissiveRadiance += diffuseColor.rgb * (0.30 * (1.0 - uTowerNight) + 0.04 * uTowerNight);
        // Lit offices after dark, by floor and by bay rather than at random, so the
        // windows come on in blocks the way a real tower's do.
        float bay = floor(mix(vTowerPos.x, vTowerPos.z, alongX) / 4.6);
        float storey = floor(vTowerPos.y / 3.7);
        float lit = step(0.42, fract(sin(bay * 12.9898 + storey * 78.233) * 43758.5453));
        // Once a storey is thinner than a pixel the pattern is being sampled at
        // random from one frame to the next, and it aliases into hard horizontal
        // bands. Fade it to the average occupancy instead, so a distant tower is an
        // even glow rather than a barcode - the same treatment the city's own
        // facades get.
        float litPx = fwidth(vTowerPos.y);
        // The far value is the occupancy weighted by how much of the wall is
        // actually glass, not the occupancy on its own. Emitting the per-window
        // brightness across the whole facade is what lights a distant tower like a
        // slab of daylight - the same mistake the city's facades made once.
        lit = mix(0.19, lit, 1.0 - smoothstep(3.7 * 0.3, 3.7 * 0.9, litPx));
        totalEmissiveRadiance += vec3(1.0, 0.84, 0.58) * uTowerNight * 0.85
          * lit * (1.0 - floors) * (1.0 - tn.y);`);
  };
  mat.userData.uniforms = { uTowerNight: { value: 0 } };
  // Without this the towers silently inherit another landmark's compiled program and
  // none of the above ever runs. Three caches programs on material parameters and
  // defines; what onBeforeCompile injected is not part of that key, so two
  // MeshStandardMaterials that differ only in their injected code are considered
  // interchangeable and whichever compiled first wins.
  mat.customProgramCacheKey = () => 'gemini-tower-curtain-wall';
  return mat;
}

/**
 * Gemini Towers: a matched pair of square prisms, joined by a skybridge.
 *
 * Square, and the same square the whole way up. The first version of these tapered
 * through five setbacks, which is the Petronas profile and not the one anybody
 * pictures when they say "twin towers" - those were flat-topped boxes of constant
 * cross-section, and the constancy is exactly what made them read as twins rather
 * than as two similar buildings.
 *
 * The slot between them is deliberately open air all the way down to the plaza, with
 * the bridge as the only thing spanning it - the same trick as the gap under the
 * bridge deck. Threading between them is a real line rather than a wall pretending
 * to be one.
 *
 * Each shaft is a DestructibleBuilding rather than a box: the same square prism,
 * drawn as a lattice of instanced modules that the destruction system can take apart
 * one at a time. Intact, a tower is indistinguishable from the single mesh it
 * replaced and costs the same one draw call - the shader reads its coordinates
 * through the instance matrix, so the facade runs continuously across every module
 * seam and no seam is visible anywhere on it. Both towers come from one description,
 * so there is no second copy of any of this.
 */
function buildTwinTowers(g, grid, L, mats) {
  const base = terrainHeight(L.x, L.z);
  const h = L.height;
  // Fineness of about six and a half to one, which is roughly what a flat-topped
  // tower of this height actually is.
  const a = h * 0.076;              // half-width of the square plan
  const gap = a * 1.5;              // clear air between the two shafts
  const offset = a + gap * 0.5;
  const glass = towerMaterial();
  g.userData.towerMaterial = glass;

  // Forty-two storeys of nine-by-nine cells: blocks about seven and a half metres
  // square and eleven tall, three and a half thousand to a tower. Fine enough that
  // an aircraft tears a ragged opening and throws a proper spray of rubble out of
  // it; coarse enough that a full collapse is a few thousand bodies rather than tens
  // of thousands.
  const LEVELS = 42;
  const CELLS = 9;

  const beacons = [];
  const towers = [];
  for (const side of [-1, 1]) {
    const tx = L.x + side * offset;
    const tower = new DestructibleBuilding({
      name: side < 0 ? 'GEMINI WEST' : 'GEMINI EAST',
      parent: g,
      grid,
      material: glass,
      origin: new THREE.Vector3(tx, base, L.z),
      width: a * 2,
      depth: a * 2,
      height: h,
      levels: LEVELS,
      cells: CELLS,
      // Curtain wall and floor plate, in the same arbitrary tonnes the flight model
      // measures aircraft in - per cubic metre, so the lattice can be re-chopped
      // without the building changing weight.
      density: 0.135,
      // Deliberately below one: these are glass and light floor plates hung on a
      // frame, not the frame itself, and they are meant to come away.
      baseStrength: 0.55,
    });
    towers.push(tower);

    // A flat roof with a parapet lip, the plant deck inside it, and the obstruction
    // beacon on top. A tower this shape ends in a hard horizontal edge, and that edge
    // is most of its silhouette. The three of them ride together on the top storey:
    // lose most of that storey and the whole cap comes down as one piece.
    const roof = new THREE.Group();
    roof.position.set(tx, base + h, L.z);
    roof.add(mesh(new THREE.BoxGeometry(a * 2.08, h * 0.012, a * 2.08),
      mats.steel, 0, h * 0.004, 0));
    roof.add(mesh(new THREE.BoxGeometry(a * 1.1, h * 0.022, a * 1.1),
      mats.dark, 0, h * 0.015, 0));
    const beacon = mesh(new THREE.SphereGeometry(h * 0.008, 8, 6), M.beacon(0xff3b30),
      0, h * 0.034, 0);
    beacon.castShadow = false;
    roof.add(beacon);
    g.add(roof);
    beacons.push(beacon);
    tower.addProp(new RigidProp({
      object: roof,
      supports: tower.levelModules(LEVELS - 1),
      required: 0.5,
      spread: 7,
    }));

    // A skirt at the base, where a tower of this kind meets its plaza. This one is
    // the plaza rather than the building, so it stays whatever happens above it.
    g.add(mesh(new THREE.BoxGeometry(a * 2.5, h * 0.028, a * 2.5),
      mats.concrete, tx, base + h * 0.014, L.z));
  }

  // --- skybridge, two decks a little over a third of the way up
  const bridgeY = base + h * 0.375;
  const span = offset * 2;
  const bridge = new THREE.Group();
  bridge.position.set(L.x, bridgeY, L.z);
  for (const deck of [0, h * 0.019]) {
    bridge.add(mesh(new THREE.BoxGeometry(span, h * 0.009, a * 0.62),
      mats.steel, 0, deck, 0));
  }
  bridge.add(mesh(new THREE.BoxGeometry(span * 0.94, h * 0.026, a * 0.5),
    mats.glass, 0, h * 0.0095, 0));
  // The two legs that carry it, meeting under the middle of the span in a V.
  for (const side of [-1, 1]) {
    const legLen = h * 0.19;
    const leg = mesh(new THREE.CylinderGeometry(a * 0.05, a * 0.06, legLen, 8),
      mats.steel, side * offset * 0.44, -legLen * 0.44, 0);
    leg.rotation.z = side * 0.42;
    bridge.add(leg);
  }
  g.add(bridge);
  // A thin collider for the bridge alone: the air above and below it stays flyable.
  const bridgeCollider = grid.add(
    L.x - span * 0.5, L.x + span * 0.5, L.z - a * 0.35, L.z + a * 0.35,
    bridgeY - h * 0.01, bridgeY + h * 0.032, 'landmark',
  );
  // The bridge is the one thing here held up by two different buildings, which no
  // single support graph can express - so it watches the storey it lands on in both
  // towers and drops when either end runs out from under it. It is registered on the
  // west tower only because a prop needs one owner to update it; its supports are
  // what actually decide.
  const bridgeLevel = towers[0].levelAt(bridgeY);
  towers[0].addProp(new RigidProp({
    object: bridge,
    supports: [...towers[0].levelModules(bridgeLevel), ...towers[1].levelModules(bridgeLevel)],
    required: 0.65,
    spread: 4,
    colliderIndex: bridgeCollider,
  }));

  return { beacons, towers };
}


export function createLandmarks(grid) {
  const group = new THREE.Group();
  group.name = 'landmarks';
  const mats = {
    concrete: M.concrete(), steel: M.steel(), red: M.red(),
    glass: M.glass(), dark: M.dark(), asphalt: M.asphalt(),
    grass: M.grass(), marking: M.marking(),
  };
  const beacons = [];
  const destructibles = [];
  let wheel = null;

  for (const L of LANDMARKS) {
    switch (L.type) {
      case 'spire': beacons.push(buildSpire(group, grid, L, mats)); break;
      case 'obelisk': beacons.push(buildObelisk(group, grid, L, mats)); break;
      case 'stadium': buildStadium(group, grid, L, mats); break;
      case 'bridge': buildBridge(group, grid, L, mats); break;
      case 'wheel': wheel = buildWheel(group, grid, L, mats); break;
      case 'cranes': buildCranes(group, grid, L, mats); break;
      case 'dam': buildDam(group, grid, L, mats); break;
      case 'atc': beacons.push(buildControlTower(group, grid, L, mats)); break;
      case 'marina': buildMarina(group, grid, L, mats); break;
      case 'twins': {
        const twins = buildTwinTowers(group, grid, L, mats);
        beacons.push(...twins.beacons);
        destructibles.push(...twins.towers);
        break;
      }
      default: break; // 'park' and 'peak' are terrain features, not structures
    }
  }

  const trees = buildVegetation(group);
  const airport = buildAirport(group, grid, mats);

  group.userData.animated = { beacons, wheel, runwayLights: airport.runwayLights };
  group.userData.stats = { trees };
  // Whatever the destruction system is allowed to take apart. WorldManager picks
  // these up rather than knowing which landmarks happen to be destructible.
  group.userData.destructibles = destructibles;
  group.userData.dispose = () => {
    group.traverse((o) => { if (o.isMesh) o.geometry?.dispose?.(); });
    for (const mm of Object.values(mats)) mm.dispose();
    group.userData.towerMaterial?.dispose();
  };
  return group;
}

/** Beacon blink and the wheel turning: cheap signs that the city is running (§29). */
export function animateLandmarks(group, dt, elapsed) {
  const a = group.userData.animated;
  if (!a) return;
  const blink = elapsed % 1.6 < 0.5 ? 1 : 0.12;
  for (const b of a.beacons) if (b) b.material.opacity = blink;
  if (a.wheel) a.wheel.rotation.z += dt * 0.09;
}
