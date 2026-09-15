import * as THREE from 'three';
import { clamp } from '../core/MathUtils.js';

/**
 * Small falling debris: the chunks that come off a structure when it breaks.
 *
 * The particle pool in Effects.js already does smoke, sparks and dust, but those are
 * camera-facing points with no orientation and no ground - they read as an effect
 * rather than as matter. A slab of curtain wall coming down wants tumbling solids
 * that hit the street and stop, which is a different job.
 *
 * It is one InstancedMesh and a handful of flat arrays: no allocation once built, one
 * draw call however much of the city is falling, and a hard ceiling on how many
 * chunks can be in the air at once. A piece that gets too old, comes to rest, or ends
 * up further from the player than they could see it is recycled immediately, so the
 * pool is never the thing that runs out.
 */

export const DEBRIS = {
  MAX_ACTIVE_DEBRIS: 260,
  LIFETIME: 11,
  SETTLED_LIFETIME: 5,
  MAX_DISTANCE: 3000,
  GRAVITY: -19,
  DRAG: 0.08,
  RESTITUTION: 0.26,
  FRICTION: 0.55,
  SLEEP_SPEED: 1.1,
};

export class DebrisField {
  constructor({ scene, settings = null, max = DEBRIS.MAX_ACTIVE_DEBRIS }) {
    // Quality scales the budget rather than switching the system off: the collapse
    // still happens on a phone, with fewer pieces in the air.
    const scale = clamp(settings?.preset?.particles ?? 1, 0.3, 1.4);
    this.capacity = Math.max(48, Math.round(max * scale));

    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x9aa3a8, roughness: 0.86, metalness: 0.06,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, this.capacity);
    this.mesh.name = 'debris';
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
    this.geometry = geo;
    this.material = mat;
    this.scene = scene;

    this.position = new Float32Array(this.capacity * 3);
    this.velocity = new Float32Array(this.capacity * 3);
    this.spin = new Float32Array(this.capacity * 3);
    this.scale = new Float32Array(this.capacity * 3);
    this.age = new Float32Array(this.capacity);
    this.life = new Float32Array(this.capacity);
    this.rest = new Float32Array(this.capacity);
    this.alive = new Uint8Array(this.capacity);
    this.quaternions = [];
    for (let i = 0; i < this.capacity; i++) this.quaternions.push(new THREE.Quaternion());

    this._cursor = 0;
    this.liveCount = 0;
    this._m = new THREE.Matrix4();
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler();
    this._zero = new THREE.Vector3();
    this.clear();
  }

  /** Claims a slot, taking the oldest if every one is busy. */
  _claim() {
    for (let i = 0; i < this.capacity; i++) {
      const idx = (this._cursor + i) % this.capacity;
      if (!this.alive[idx]) {
        this._cursor = (idx + 1) % this.capacity;
        return idx;
      }
    }
    const idx = this._cursor;
    this._cursor = (this._cursor + 1) % this.capacity;
    return idx;
  }

  /**
   * Throws a handful of chunks out of a box.
   *
   * `extent` is the module that produced them, so the pieces start spread across its
   * face and are sized as a fraction of it: debris off a thirty-metre slab is bigger
   * than debris off a parapet, without the caller having to say so.
   */
  burst(origin, extent, count = 8, speed = 9) {
    const budget = this.capacity - this.liveCount;
    const n = Math.min(count, Math.max(0, budget));
    const ex = extent?.x ?? 6;
    const ey = extent?.y ?? 6;
    const ez = extent?.z ?? 6;
    const base = Math.max(1.2, Math.min(ex, ez) * 0.14);
    for (let i = 0; i < n; i++) {
      const idx = this._claim();
      if (!this.alive[idx]) this.liveCount++;
      const i3 = idx * 3;
      this.position[i3] = origin.x + (Math.random() - 0.5) * ex;
      this.position[i3 + 1] = origin.y + (Math.random() - 0.5) * ey;
      this.position[i3 + 2] = origin.z + (Math.random() - 0.5) * ez;
      // Up and out: chunks thrown off a breaking slab, not an explosion.
      const a = Math.random() * Math.PI * 2;
      const r = Math.random();
      const s = speed * (0.35 + Math.random() * 0.9);
      this.velocity[i3] = Math.cos(a) * r * s;
      this.velocity[i3 + 1] = s * (0.25 + Math.random() * 0.75);
      this.velocity[i3 + 2] = Math.sin(a) * r * s;
      this.spin[i3] = (Math.random() - 0.5) * 7;
      this.spin[i3 + 1] = (Math.random() - 0.5) * 7;
      this.spin[i3 + 2] = (Math.random() - 0.5) * 7;
      this.scale[i3] = base * (0.5 + Math.random() * 1.3);
      this.scale[i3 + 1] = base * (0.25 + Math.random() * 0.7);
      this.scale[i3 + 2] = base * (0.5 + Math.random() * 1.3);
      this.quaternions[idx].set(0, 0, 0, 1);
      this.age[idx] = 0;
      this.life[idx] = DEBRIS.LIFETIME * (0.7 + Math.random() * 0.6);
      this.rest[idx] = 0;
      this.alive[idx] = 1;
    }
  }

  update(dt, focus, groundAt) {
    let live = 0;
    let dirty = false;
    const far = DEBRIS.MAX_DISTANCE * DEBRIS.MAX_DISTANCE;
    for (let i = 0; i < this.capacity; i++) {
      if (!this.alive[i]) continue;
      const i3 = i * 3;
      this.age[i] += dt;

      // Retire on age, on coming to rest long enough, or on being further away than
      // the player could tell it apart from the street.
      let retire = this.age[i] > this.life[i];
      if (!retire && focus) {
        const dx = this.position[i3] - focus.x;
        const dz = this.position[i3 + 2] - focus.z;
        if (dx * dx + dz * dz > far) retire = true;
      }
      if (retire) {
        this.alive[i] = 0;
        this._m.compose(this._zero, this._q.identity(), this._zero);
        this.mesh.setMatrixAt(i, this._m);
        dirty = true;
        continue;
      }

      if (this.rest[i] < DEBRIS.SETTLED_LIFETIME) {
        this.velocity[i3 + 1] += DEBRIS.GRAVITY * dt;
        const drag = 1 - DEBRIS.DRAG * dt;
        this.velocity[i3] *= drag;
        this.velocity[i3 + 1] *= drag;
        this.velocity[i3 + 2] *= drag;
        this.position[i3] += this.velocity[i3] * dt;
        this.position[i3 + 1] += this.velocity[i3 + 1] * dt;
        this.position[i3 + 2] += this.velocity[i3 + 2] * dt;

        const floor = (groundAt
          ? groundAt(this.position[i3], this.position[i3 + 2])
          : 0) + this.scale[i3 + 1] * 0.5;
        if (this.position[i3 + 1] <= floor) {
          this.position[i3 + 1] = floor;
          if (-this.velocity[i3 + 1] > DEBRIS.SLEEP_SPEED) {
            this.velocity[i3 + 1] = -this.velocity[i3 + 1] * DEBRIS.RESTITUTION;
            this.velocity[i3] *= DEBRIS.FRICTION;
            this.velocity[i3 + 2] *= DEBRIS.FRICTION;
            this.spin[i3] *= 0.5; this.spin[i3 + 1] *= 0.5; this.spin[i3 + 2] *= 0.5;
          } else {
            this.velocity[i3] = 0; this.velocity[i3 + 1] = 0; this.velocity[i3 + 2] = 0;
            this.spin[i3] = 0; this.spin[i3 + 1] = 0; this.spin[i3 + 2] = 0;
            // Counted up rather than checked once: it is also the clock that tells
            // a settled chunk when to stop being integrated at all.
            this.rest[i] += dt;
          }
        }

        if (this.spin[i3] || this.spin[i3 + 1] || this.spin[i3 + 2]) {
          this._e.set(this.spin[i3] * dt, this.spin[i3 + 1] * dt, this.spin[i3 + 2] * dt);
          this.quaternions[i].multiply(this._q.setFromEuler(this._e));
        }

        this._p.set(this.position[i3], this.position[i3 + 1], this.position[i3 + 2]);
        this._s.set(this.scale[i3], this.scale[i3 + 1], this.scale[i3 + 2]);
        this._m.compose(this._p, this.quaternions[i], this._s);
        this.mesh.setMatrixAt(i, this._m);
        dirty = true;
      }
      live++;
    }
    this.liveCount = live;
    if (dirty) this.mesh.instanceMatrix.needsUpdate = true;
  }

  clear() {
    this.alive.fill(0);
    this.liveCount = 0;
    this._m.compose(this._zero, this._q.identity(), this._zero);
    for (let i = 0; i < this.capacity; i++) this.mesh.setMatrixAt(i, this._m);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.geometry.dispose();
    this.material.dispose();
  }
}
