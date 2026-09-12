import * as THREE from 'three';
import { clamp01 } from '../core/MathUtils.js';

/**
 * Checkpoint rings: placement, visuals and pass detection (spec §30-35).
 *
 * Detection is a segment-versus-disc test between last frame's position and this
 * frame's, not a sphere overlap. At 800 km/h an aircraft covers 3.7 m per frame at
 * 60 fps and far more on a dropped frame, so an overlap test would let the player
 * fly clean through a gate and be told they missed it. Crossing the plane is also
 * directional, so you cannot reverse back through a gate to re-arm it.
 *
 * Visually they are built to stay findable in a night storm (§117-118): a bright
 * ring in a colour nothing in the city uses, a contrasting outer ring, and a
 * vertical light column that is visible long before the ring resolves.
 */

const COLORS = {
  next: new THREE.Color(0x38e1ff),
  upcoming: new THREE.Color(0x1c6f88),
  passed: new THREE.Color(0x2a9d5c),
  final: new THREE.Color(0xffb340),
};

function ringMaterial(color, opacity = 1) {
  return new THREE.MeshBasicMaterial({
    color, transparent: true, opacity, side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
}

class CheckpointVisual {
  constructor() {
    this.group = new THREE.Group();
    this.group.visible = false;

    // Inner bright ring.
    this.ring = new THREE.Mesh(new THREE.TorusGeometry(1, 0.045, 6, 28), ringMaterial(COLORS.next));
    this.group.add(this.ring);
    // Outer dark ring: the contrast that keeps it legible against a bright sky.
    this.outer = new THREE.Mesh(
      new THREE.TorusGeometry(1.1, 0.03, 5, 28),
      new THREE.MeshBasicMaterial({ color: 0x04121a, transparent: true, opacity: 0.75, side: THREE.DoubleSide }),
    );
    this.group.add(this.outer);
    // Soft disc so the opening reads as a hole to aim at.
    this.disc = new THREE.Mesh(new THREE.CircleGeometry(1, 28), ringMaterial(COLORS.next, 0.07));
    this.group.add(this.disc);
    // Light column, for finding it between buildings from a long way out.
    this.column = new THREE.Mesh(
      new THREE.CylinderGeometry(0.1, 0.1, 30, 6, 1, true),
      ringMaterial(COLORS.next, 0.16),
    );
    this.group.add(this.column);
    // Four chevrons, which give the ring a readable orientation.
    this.chevrons = [];
    for (let i = 0; i < 4; i++) {
      const c = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.24, 4), ringMaterial(COLORS.next, 0.9));
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      c.position.set(Math.cos(a), Math.sin(a), 0);
      c.rotation.z = a - Math.PI / 2;
      this.group.add(c);
      this.chevrons.push(c);
    }
  }

  apply(cp, state, elapsed) {
    const g = this.group;
    g.visible = true;
    g.position.set(cp.x, cp.y, cp.z);
    g.quaternion.copy(cp.quaternion);
    const r = cp.radius;
    this.ring.scale.setScalar(r);
    this.outer.scale.setScalar(r);
    this.disc.scale.setScalar(r);
    for (const c of this.chevrons) c.scale.setScalar(r * 0.9);
    // The column stands vertically in world space regardless of ring orientation.
    this.column.scale.set(r * 0.12, r * 0.1, r * 0.12);

    const color = state === 'passed' ? COLORS.passed
      : state === 'next' ? (cp.isFinal ? COLORS.final : COLORS.next)
        : COLORS.upcoming;
    const pulse = state === 'next' ? 0.78 + Math.sin(elapsed * 4.2) * 0.22 : 0.4;
    this.ring.material.color.copy(color);
    this.ring.material.opacity = pulse;
    this.disc.material.color.copy(color);
    this.disc.material.opacity = state === 'next' ? 0.1 : 0.04;
    this.column.material.color.copy(color);
    this.column.material.opacity = state === 'next' ? 0.18 : 0.05;
    for (const c of this.chevrons) {
      c.material.color.copy(color);
      c.material.opacity = state === 'next' ? pulse : 0.3;
      c.visible = state !== 'passed';
    }
    if (state === 'next') this.ring.rotation.z = elapsed * 0.5;
  }

  hide() {
    this.group.visible = false;
  }

  dispose() {
    this.group.traverse((o) => {
      if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); }
    });
  }
}

export class CheckpointManager {
  constructor({ scene, bus, poolSize = 10 }) {
    this.scene = scene;
    this.bus = bus;
    this.group = new THREE.Group();
    this.group.name = 'checkpoints';
    scene.add(this.group);

    this.pool = [];
    for (let i = 0; i < poolSize; i++) {
      const v = new CheckpointVisual();
      this.pool.push(v);
      this.group.add(v.group);
    }

    this.checkpoints = [];
    this.index = 0;
    this.elapsed = 0;
    this.active = false;
    this._prev = new THREE.Vector3();
    this._hasPrev = false;
    this._tmp = new THREE.Vector3();
    this._tmp2 = new THREE.Vector3();
  }

  /**
   * Loads a route. Ring orientation is derived from the route direction, so mission
   * data only has to say where the gates are, not which way they face (§92).
   */
  load(route, { sequential = true } = {}) {
    this.checkpoints = route.map((cp, i) => {
      const next = route[i + 1];
      const prev = route[i - 1];
      const dir = new THREE.Vector3();
      if (next && prev) {
        dir.set(next.x - prev.x, next.y - prev.y, next.z - prev.z);
      } else if (next) {
        dir.set(next.x - cp.x, next.y - cp.y, next.z - cp.z);
      } else if (prev) {
        dir.set(cp.x - prev.x, cp.y - prev.y, cp.z - prev.z);
      } else {
        dir.set(0, 0, -1);
      }
      if (dir.lengthSq() < 1e-6) dir.set(0, 0, -1);
      dir.normalize();
      // A ring's local +Z is its normal; the torus lies in its local XY plane.
      const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
      return {
        ...cp,
        radius: cp.radius ?? 34,
        normal: dir.clone(),
        quaternion,
        passed: false,
        isFinal: i === route.length - 1,
        index: i,
      };
    });
    this.index = 0;
    this.sequential = sequential;
    this.active = true;
    this._hasPrev = false;
    this.refreshVisuals();
  }

  clear() {
    this.checkpoints = [];
    this.index = 0;
    this.active = false;
    for (const v of this.pool) v.hide();
  }

  get current() {
    return this.checkpoints[this.index] ?? null;
  }

  get remaining() {
    return Math.max(0, this.checkpoints.length - this.index);
  }

  get total() {
    return this.checkpoints.length;
  }

  /** Rewinds to a given gate, used by the checkpoint-reset recovery (§46). */
  rewindTo(index) {
    this.index = Math.max(0, Math.min(index, this.checkpoints.length - 1));
    for (let i = 0; i < this.checkpoints.length; i++) {
      this.checkpoints[i].passed = i < this.index;
    }
    this._hasPrev = false;
    this.refreshVisuals();
  }

  refreshVisuals() {
    // Only the next few gates are drawn: more than that is visual noise, and the
    // pool means a 40-gate route costs the same as a 6-gate one.
    let slot = 0;
    for (let i = this.index; i < this.checkpoints.length && slot < this.pool.length; i++, slot++) {
      const state = i === this.index ? 'next' : 'upcoming';
      this.pool[slot].apply(this.checkpoints[i], state, this.elapsed);
    }
    for (; slot < this.pool.length; slot++) this.pool[slot].hide();
  }

  /**
   * Advances detection. `position` is this frame's aircraft position; the previous
   * frame's is remembered internally.
   */
  update(dt, position, velocity) {
    this.elapsed += dt;
    if (!this.active || !this.checkpoints.length) return null;

    let result = null;
    if (this._hasPrev) {
      const cp = this.current;
      if (cp) {
        const hit = this._testCrossing(cp, this._prev, position);
        if (hit) {
          cp.passed = true;
          this.index++;
          result = {
            checkpoint: cp,
            index: cp.index,
            accuracy: hit.accuracy,
            distanceFromCentre: hit.distance,
            remaining: this.remaining,
            isFinal: cp.isFinal,
            speed: velocity ? velocity.length() : 0,
          };
          this.bus.emit('checkpoint:passed', result);
          if (this.remaining === 0) {
            this.active = false;
            this.bus.emit('checkpoint:routeComplete', { total: this.total });
          }
        }
      }
    }

    this._prev.copy(position);
    this._hasPrev = true;

    // Re-apply visuals every frame: the pulse and spin are animated.
    this.refreshVisuals();
    return result;
  }

  /**
   * Segment versus oriented disc.
   *
   * Solves for where the segment crosses the ring's plane, then checks the radial
   * distance at exactly that point — so it is exact regardless of frame length, and
   * only counts a crossing travelling the intended way through the gate.
   */
  _testCrossing(cp, from, to) {
    const n = cp.normal;
    const centre = this._tmp.set(cp.x, cp.y, cp.z);
    const d0 = this._tmp2.copy(from).sub(centre).dot(n);
    const seg = to.clone().sub(from);
    const denom = seg.dot(n);
    if (Math.abs(denom) < 1e-9) return null;
    const d1 = to.clone().sub(centre).dot(n);

    // Must end up on the far side, having started on the near side.
    if (!(d0 <= 0 && d1 > 0)) return null;

    const t = d0 === d1 ? 0 : -d0 / (d1 - d0);
    if (t < 0 || t > 1) return null;

    const point = from.clone().addScaledVector(seg, t);
    const distance = point.distanceTo(centre);
    if (distance > cp.radius) return null;

    return {
      point,
      distance,
      // 1 dead centre, 0 at the rim — this is what the precision bonus reads (§35, §43).
      accuracy: clamp01(1 - distance / cp.radius),
    };
  }

  /** Distance and direction to the next gate, for the HUD. */
  navInfo(position) {
    const cp = this.current;
    if (!cp) return null;
    const to = new THREE.Vector3(cp.x, cp.y, cp.z);
    return {
      position: to,
      distance: to.distanceTo(position),
      altitudeDelta: cp.y - position.y,
      radius: cp.radius,
      index: cp.index,
      isFinal: cp.isFinal,
    };
  }

  dispose() {
    for (const v of this.pool) v.dispose();
    this.scene.remove(this.group);
  }
}
