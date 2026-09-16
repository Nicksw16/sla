import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { clamp, clamp01 } from '../core/MathUtils.js';
import { BRIDGE, BRIDGE_SPAN, bridgeRoadHeight, openDeckGap, clearDeckGaps } from './Roads.js';
import { DESTRUCTION, MODULE_STATE } from './Destructible.js';

/**
 * Northgate Bridge, as something that can be brought down.
 *
 * A suspension bridge is a chain, not a stack, so it cannot be a lattice like the
 * towers: what holds a piece of deck up is not the deck below it - there is nothing
 * below it but water - but the hanger above it, the cable that hanger hangs from, and
 * the pylons that cable runs over. The support question is the same one the towers ask
 * ("can this piece trace a path to the ground?"), asked over a different graph.
 *
 * That graph is what makes the bridge fall from wherever it is hit rather than all at
 * once or not at all:
 *
 *   - Hit the deck mid-span and you punch a hole. The neighbours still have their own
 *     hangers, so they stay, and you are left with a gap you can fly through.
 *   - Hit a pylon and everything its cable carried loses the sky. That is most of a
 *     span, and it goes together.
 *   - Hit an approach and the segments whose piers you took drop onto the shore.
 *
 * And whatever starts falling pulls on what it is still joined to. A dropping segment
 * tugs its neighbours; if the tug is more than their hangers can take they go as well,
 * and tug theirs. The collapse therefore walks outwards from the impact at the speed
 * the deck actually fails, rather than being scheduled - the same idea as the pancake
 * that walks a tower down, laid on its side.
 */

/** Deck segment length, metres. Short enough to fail locally, long enough to be cheap. */
const SEG = 30;

/** What a segment's hanger can take before it lets go, in units of tug. */
const HANGER_STRENGTH = 1.0;

/**
 * How hard a falling segment pulls on the one next to it, per second of falling.
 *
 * This is the whole character of the collapse. Too little and a hole stays a hole
 * however much of the deck is gone; too much and touching the bridge anywhere brings
 * the entire thing down, which is neither dramatic nor true.
 */
const TUG = 4.5;

/**
 * And how fast a span that has lost its cable gives way with nothing yet pulling on it.
 *
 * Slower than the tug, so a collapse always starts somewhere and spreads rather than
 * letting go everywhere at once - but never zero, or a pylon taken out with a blast
 * that touched no deck would leave a span hanging from nothing indefinitely.
 */
const BLEED = 0.9;

/** Deck continuity: how far a supported neighbour can hold an unsupported segment. */
const REACH = 1;

const _v = new THREE.Vector3();

class DeckSegment {
  constructor({ index, x, y, length, lean, onSpan, pylon }) {
    this.index = index;
    this.home = new THREE.Vector3(x, y, BRIDGE_SPAN.z);
    this.centre = this.home.clone();
    this.length = length;
    this.lean = lean;
    this.onSpan = onSpan;          // over the main span, so it hangs from the cable
    this.pylon = pylon;            // which pylon's cable run carries it, -1 or +1
    this.state = MODULE_STATE.INTACT;
    this.hanger = HANGER_STRENGTH;
    this.strain = 0;
    this.doomed = false;
    this.velocity = new THREE.Vector3();
    this.spin = new THREE.Vector3();
    this.quaternion = new THREE.Quaternion();
    this.restTimer = 0;
    this.age = 0;
    this.mass = length * BRIDGE.DECK_W * 3.4 * 0.14;
    this.colliderIndex = -1;
  }

  get intact() {
    return this.state === MODULE_STATE.INTACT;
  }
}

export class DestructibleBridge {
  constructor({ name = 'Northgate Bridge', parent, grid, material }) {
    this.name = name;
    this.grid = grid;
    this.parent = parent;
    this.origin = new THREE.Vector3(BRIDGE_SPAN.x, BRIDGE.DECK_Y, BRIDGE_SPAN.z);
    this.segments = [];
    this.falling = [];
    this.collapsed = false;
    this.damaged = false;
    this.onEvent = null;
    // Both pylons standing to begin with. Each carries the cable over its half.
    this.pylons = { '-1': true, 1: true };
    // Something at each pylon for the debris to burst from when one is taken out. The
    // destruction field expects a prop to have an object with a position, and handing
    // it a bare marker is how the dust ends up at the pylon rather than at the origin.
    const pierX = BRIDGE.SPAN_HALF * BRIDGE.PIER_FRAC;
    this.pylonMarks = {
      '-1': { object: { position: new THREE.Vector3(BRIDGE_SPAN.x - pierX, BRIDGE.DECK_Y + 60, BRIDGE_SPAN.z) } },
      1: { object: { position: new THREE.Vector3(BRIDGE_SPAN.x + pierX, BRIDGE.DECK_Y + 60, BRIDGE_SPAN.z) } },
    };

    this._buildSegments();
    this._buildMesh(parent, material);
    this._m = new THREE.Matrix4();
    this._s = new THREE.Vector3(1, 1, 1);
  }

  /** The roadway, end to end, cut into segments that can fail one at a time. */
  _buildSegments() {
    const half = BRIDGE_SPAN.half;
    const count = Math.ceil((half * 2) / SEG);
    for (let i = 0; i < count; i++) {
      const dx = -half + (i + 0.5) * SEG;
      if (Math.abs(dx) > half) continue;
      const x = BRIDGE_SPAN.x + dx;
      const y = bridgeRoadHeight(dx);
      if (y === null) continue;
      // The lean, from the road profile either side of this segment.
      const a = bridgeRoadHeight(dx - SEG * 0.5) ?? y;
      const b = bridgeRoadHeight(dx + SEG * 0.5) ?? y;
      const seg = new DeckSegment({
        index: this.segments.length,
        x,
        y: (a + b) * 0.5,
        length: SEG,
        lean: Math.atan2(b - a, SEG),
        onSpan: Math.abs(dx) <= BRIDGE.SPAN_HALF,
        pylon: dx < 0 ? -1 : 1,
      });
      this.segments.push(seg);
    }
  }

  /**
   * One segment's worth of road, as a single piece of geometry.
   *
   * Slab, wearing course, centre line and both parapets merged together and coloured
   * per vertex, so the whole cross-section is one instance and falls as one thing. The
   * alternative - drawing the road surface separately from the structure - means the
   * markings stay hanging in the air over a span that has already gone.
   */
  static segmentGeometry() {
    const W = BRIDGE.DECK_W;
    const tint = (geo, hex) => {
      const c = new THREE.Color(hex);
      const n = geo.attributes.position.count;
      const col = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      return geo;
    };
    const slab = tint(new THREE.BoxGeometry(1, 3.4, W), 0xa9a49b);
    const road = tint(new THREE.BoxGeometry(1, 0.5, W - 3), 0x33373c);
    road.translate(0, 1.95, 0);
    const stripe = tint(new THREE.BoxGeometry(0.92, 0.12, 1.1), 0xf0f0e8);
    stripe.translate(0, 2.25, 0);
    const parts = [slab, road, stripe];
    for (const zo of [-W / 2, W / 2]) {
      const rail = tint(new THREE.BoxGeometry(1, 2, 1.2), 0xa9a49b);
      rail.translate(0, 1.6, zo);
      parts.push(rail);
    }
    return mergeGeometries(parts, false);
  }

  _buildMesh(parent, material) {
    const geo = DestructibleBridge.segmentGeometry();
    this.mesh = new THREE.InstancedMesh(geo, material, this.segments.length);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.geometry = geo;
    parent.add(this.mesh);
    for (const s of this.segments) this._place(s);
    // Hand-set, because the instances move: a computed sphere around the intact deck
    // is right until half of it is in the air over the channel.
    this.mesh.boundingSphere = new THREE.Sphere(
      new THREE.Vector3(BRIDGE_SPAN.x, BRIDGE.DECK_Y * 0.5, BRIDGE_SPAN.z),
      BRIDGE_SPAN.half + 120,
    );
    this.mesh.frustumCulled = true;
  }

  _place(s) {
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), s.lean);
    if (s.state !== MODULE_STATE.INTACT) q.copy(s.quaternion);
    this._m ??= new THREE.Matrix4();
    this._m.compose(s.centre, q, new THREE.Vector3(s.length, 1, 1));
    this.mesh.setMatrixAt(s.index, this._m);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * One collision box per segment, so a hole in the deck is a hole you can fly through.
   *
   * The deck used to be a single box spanning eight hundred and forty metres: it either
   * blocked everywhere or nowhere, which is no use once pieces of it can be missing.
   */
  registerColliders() {
    const halfW = BRIDGE.DECK_W * 0.5;
    for (const s of this.segments) {
      s.colliderIndex = this.grid.add(
        s.centre.x - s.length * 0.5, s.centre.x + s.length * 0.5,
        BRIDGE_SPAN.z - halfW, BRIDGE_SPAN.z + halfW,
        s.centre.y - 3, s.centre.y + 4, 'bridge', { building: this },
      );
    }
  }

  /** Cheap rejection, then the real test: is this impact anywhere near the bridge? */
  reaches(point, radius = 0) {
    return Math.abs(point.x - BRIDGE_SPAN.x) <= BRIDGE_SPAN.half + radius
      && Math.abs(point.z - BRIDGE_SPAN.z) <= BRIDGE.DECK_W * 0.5 + radius + 24
      && point.y >= -30 - radius
      && point.y <= BRIDGE.DECK_Y + 180 + radius;
  }

  get standing() {
    return this.segments.some((s) => s.intact);
  }

  /** Which pylon, if any, this impact took out. */
  _pylonHit(impact) {
    const pierX = BRIDGE.SPAN_HALF * BRIDGE.PIER_FRAC;
    for (const side of [-1, 1]) {
      const px = BRIDGE_SPAN.x + side * pierX;
      if (Math.abs(impact.position.x - px) > 26) continue;
      // Anywhere up the pylon, not only at deck level.
      if (impact.position.y < BRIDGE.DECK_Y - 20) continue;
      if (impact.strength < 3) continue;
      return side;
    }
    return 0;
  }

  /**
   * Localised damage from one impact.
   *
   * The blast takes the deck it reaches directly. Everything after that is the support
   * pass deciding what can no longer hold itself up.
   */
  applyImpact(impact) {
    const reach = clamp(
      DESTRUCTION.BLAST_BASE + impact.strength * DESTRUCTION.BLAST_PER_STRENGTH,
      DESTRUCTION.BLAST_BASE, DESTRUCTION.BLAST_MAX,
    );
    let broke = 0;
    let absorbed = 0;

    // A pylon is the dramatic hit: take one and the cable over it has nothing to run on.
    const pylon = this._pylonHit(impact);
    if (pylon !== 0 && this.pylons[pylon]) {
      this.pylons[pylon] = false;
      absorbed += impact.strength;
      this.onEvent?.({ type: 'prop', prop: this.pylonMarks[pylon], building: this });
    }

    for (const s of this.segments) {
      if (!s.intact) continue;
      const d = Math.max(0,
        _v.copy(s.centre).sub(impact.position).length() - s.length * 0.5);
      if (d > reach) continue;
      const share = (1 - clamp01(d / reach)) ** DESTRUCTION.BLAST_FALLOFF;
      const dealt = impact.strength * share;
      if (dealt <= 0.02) continue;
      absorbed += dealt;
      s.strain += dealt * 0.5;
      if (dealt > 1.1 || s.strain > s.hanger) {
        this._detach(s, impact);
        broke++;
      }
    }

    if (absorbed <= 0) return { broke: 0, absorbed: 0 };
    this.damaged = true;
    this.settleStructure();
    return { broke, absorbed };
  }

  /**
   * The support pass, run to a fixed point exactly as the towers' is.
   *
   * Two rules. A segment holds itself up if it has its hanger and, over the main span,
   * a pylon to hang that hanger from. Anything else can only be carried by the deck
   * itself, and the deck is not a rope: it will cantilever a segment or two past its
   * last support and no further.
   *
   * That bound is the whole behaviour. Without it, continuity spreads along the chain
   * without limit - a neighbour holds a neighbour holds a neighbour - and one surviving
   * approach segment holds up the entire main span, so taking a pylon out did nothing
   * at all. With it, taking a pylon drops everything that pylon carried except the
   * couple of segments the far side can still reach.
   */
  static CANTILEVER = 1;

  settleStructure() {
    for (let pass = 0; pass < this.segments.length + 2; pass++) {
      // Depth 0: everything that needs no help. Then outwards, one segment at a time,
      // as far as the deck can carry and no further.
      const depth = new Map();
      const queue = [];
      for (const s of this.segments) {
        if (!s.intact) continue;
        const selfHeld = s.onSpan ? (s.hanger > 0 && this.pylons[s.pylon]) : s.hanger > 0;
        if (selfHeld) { depth.set(s.index, 0); queue.push(s.index); }
      }
      for (let head = 0; head < queue.length; head++) {
        const i = queue[head];
        const d = depth.get(i);
        if (d >= DestructibleBridge.CANTILEVER) continue;
        for (const n of [this.segments[i - 1], this.segments[i + 1]]) {
          if (!n || !n.intact || depth.has(n.index)) continue;
          depth.set(n.index, d + 1);
          queue.push(n.index);
        }
      }

      const doomed = this.segments.filter((s) => s.intact && !depth.has(s.index) && !s.doomed);
      if (!doomed.length) break;
      // Marked, not dropped.
      //
      // Detaching them here would be correct and would look wrong: the whole of a span
      // whose pylon has gone would vanish on the frame of the impact. What actually
      // happens is that it lets go from the failure outwards, each piece pulling the
      // next, so a doomed segment keeps its place until something tugs it off - and
      // what tugs it is its neighbour already falling. The order is the structure's;
      // only the speed is a number.
      for (const s of doomed) { s.doomed = true; s.hanger = 0; }
    }
    if (!this.standing && !this.collapsed) {
      this.collapsed = true;
      this.onEvent?.({ type: 'collapse', building: this });
    }
  }

  _detach(s, impact) {
    if (!s.intact) return;
    s.state = MODULE_STATE.DETACHED;
    s.hanger = 0;
    if (s.colliderIndex >= 0) {
      this.grid.remove(s.colliderIndex);
      s.colliderIndex = -1;
    }
    // The road stops being a road here, which the traffic has to know about: a car
    // driving over a gap in the deck is worse than the gap.
    openDeckGap(s.centre.x - s.length * 0.5, s.centre.x + s.length * 0.5);

    if (impact) {
      const away = _v.copy(s.centre).sub(impact.position);
      const dist = Math.max(1, away.length());
      away.normalize();
      const thrown = clamp(impact.strength * DESTRUCTION.BLAST_PUSH * 0.4,
        0, DESTRUCTION.BLAST_PUSH_MAX * 0.5) * clamp(70 / dist, 0.15, 1);
      s.velocity.copy(away).multiplyScalar(thrown * 0.5);
      s.velocity.y = Math.min(s.velocity.y, thrown * 0.15);
    }
    s.velocity.y -= 1.5;
    s.spin.set(
      (Math.random() - 0.5) * 0.7,
      (Math.random() - 0.5) * 0.4,
      (Math.random() - 0.5) * 1.1,
    );
    this.falling.push(s);
    this.onEvent?.({ type: 'detach', module: { centre: s.centre, size: { x: s.length, y: 3.4, z: BRIDGE.DECK_W }, velocity: s.velocity }, building: this });
  }

  /**
   * One step.
   *
   * Falling segments integrate like any other loose mass, and while they fall they pull
   * on whatever they are still joined to. That pull is what walks the collapse outwards
   * from wherever the bridge was hit.
   */
  update(dt, groundAt, onLanded, simulate = true) {
    // The collapse front: anything that has lost its support gives way when what it is
    // joined to is already on its way down. This is what makes the bridge come apart
    // from the point it was hit rather than all at once.
    let front = false;
    for (const s of this.segments) {
      if (!s.intact || !s.doomed) continue;
      const pulled = (this.segments[s.index - 1]?.state === MODULE_STATE.DETACHED)
        || (this.segments[s.index + 1]?.state === MODULE_STATE.DETACHED);
      s.strain += (pulled ? TUG : BLEED) * dt;
      if (s.strain >= HANGER_STRENGTH) { this._detach(s, null); front = true; }
    }
    if (front) this.settleStructure();

    if (!this.falling.length) return;
    let spread = false;

    for (let i = this.falling.length - 1; i >= 0; i--) {
      const s = this.falling[i];
      s.age += dt;

      if (s.state === MODULE_STATE.SETTLED) {
        s.age += dt;
        if (s.age > DESTRUCTION.SETTLED_LIFETIME * 2) {
          this.mesh.setMatrixAt(s.index, new THREE.Matrix4().makeScale(0, 0, 0));
          this.mesh.instanceMatrix.needsUpdate = true;
          this.falling.splice(i, 1);
        }
        continue;
      }

      if (!simulate) continue;

      s.velocity.y += DESTRUCTION.GRAVITY * dt;
      s.velocity.multiplyScalar(1 - DESTRUCTION.AIR_DRAG * dt);
      s.centre.addScaledVector(s.velocity, dt);

      const floor = Math.max(groundAt ? groundAt(s.centre.x, s.centre.z, s.centre.y) : 0, 0) + 1.7;
      if (s.centre.y <= floor) {
        s.centre.y = floor;
        const hit = -s.velocity.y;
        if (hit > DESTRUCTION.SLEEP_SPEED) {
          s.velocity.y = hit * DESTRUCTION.RESTITUTION;
          s.velocity.x *= DESTRUCTION.FRICTION;
          s.velocity.z *= DESTRUCTION.FRICTION;
          s.spin.multiplyScalar(0.4);
          onLanded?.({ centre: s.centre, size: { x: s.length, y: 3.4, z: BRIDGE.DECK_W }, mass: s.mass }, hit);
        } else {
          s.velocity.set(0, 0, 0);
        }
      }

      if (s.velocity.lengthSq() < DESTRUCTION.SLEEP_SPEED ** 2) {
        s.restTimer += dt;
        if (s.restTimer > DESTRUCTION.SLEEP_TIME) {
          s.state = MODULE_STATE.SETTLED;
          s.velocity.set(0, 0, 0);
          s.spin.set(0, 0, 0);
          s.age = 0;
        }
      } else {
        s.restTimer = 0;
      }

      if (s.spin.lengthSq() > 1e-6) {
        s.quaternion.multiply(new THREE.Quaternion().setFromEuler(
          new THREE.Euler(s.spin.x * dt, s.spin.y * dt, s.spin.z * dt),
        ));
      }
      this._place(s);
    }

    if (spread) this.settleStructure();
  }

  reset() {
    for (const s of this.segments) {
      s.state = MODULE_STATE.INTACT;
      s.centre.copy(s.home);
      s.quaternion.identity();
      s.velocity.set(0, 0, 0);
      s.spin.set(0, 0, 0);
      s.hanger = HANGER_STRENGTH;
      s.strain = 0;
      s.doomed = false;
      s.restTimer = 0;
      s.age = 0;
      if (s.colliderIndex >= 0) this.grid.revive(s.colliderIndex);
      this._place(s);
    }
    this.falling.length = 0;
    this.pylons['-1'] = true;
    this.pylons[1] = true;
    this.collapsed = false;
    this.damaged = false;
    clearDeckGaps();
  }

  /** Where the deck is missing, as ranges along the bridge. For tests and for traffic. */
  get gaps() {
    return this.segments.filter((s) => !s.intact)
      .map((s) => [s.centre.x - s.length * 0.5, s.centre.x + s.length * 0.5]);
  }

  dispose() {
    this.mesh?.parent?.remove(this.mesh);
    this.geometry?.dispose();
  }
}
