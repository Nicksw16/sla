import * as THREE from 'three';
import { SECRETS, SECRET_RADIUS } from '../data/secrets.js';

/**
 * The twelve hidden beacons (spec §151).
 *
 * Two instanced meshes for the lot - the core and the cage around it - so the whole
 * hunt costs two draw calls however many beacons there are. A collected beacon is
 * scaled to nothing rather than removed, which keeps the instance indices stable and
 * the matrix update trivial.
 *
 * Deliberately quiet: the beacon glows and turns, but there is no marker on the
 * minimap and no column of light. It is meant to reward a player who flies somewhere
 * odd on purpose, which is why the statistics screen carries the hints instead.
 */
export class SecretBeacons {
  constructor({ scene, bus }) {
    this.scene = scene;
    this.bus = bus;
    this.found = new Set();
    this.total = SECRETS.length;
    this._t = 0;
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._pos = new THREE.Vector3();
    this._scale = new THREE.Vector3();
    // Hoisted: _write runs every frame and nothing here may allocate mid-flight.
    this._spinAxis = new THREE.Vector3(0.2, 1, 0.1).normalize();
    this._cageAxis = new THREE.Vector3(0, 1, 0);

    const geo = new THREE.OctahedronGeometry(13, 0);
    const mat = new THREE.MeshBasicMaterial({
      color: 0x63ecff, transparent: true, opacity: 0.82,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, this.total);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    this.mesh.name = 'secretBeacons';
    scene.add(this.mesh);

    const cage = new THREE.MeshBasicMaterial({
      color: 0xffd257, wireframe: true, transparent: true, opacity: 0.5,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this.cage = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(24, 0), cage, this.total);
    this.cage.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.cage.frustumCulled = false;
    this.cage.renderOrder = 3;
    scene.add(this.cage);

    this._write(0);
  }

  /** Seeds the collected set from the save. */
  setFound(ids = []) {
    this.found = new Set(ids.filter((id) => SECRETS.some((s) => s.id === id)));
    this._write(this._t);
  }

  get remaining() {
    return this.total - this.found.size;
  }

  /** Writes every instance matrix: spin, pulse, and zero scale for the collected. */
  _write(t) {
    for (const [i, s] of SECRETS.entries()) {
      const gone = this.found.has(s.id);
      const pulse = gone ? 0 : 0.86 + Math.sin(t * 2.1 + i) * 0.14;
      this._pos.set(s.x, s.y + (gone ? 0 : Math.sin(t * 0.9 + i * 1.7) * 3), s.z);
      this._q.setFromAxisAngle(this._spinAxis, t * 0.8 + i);
      this._scale.setScalar(pulse);
      this.mesh.setMatrixAt(i, this._m.compose(this._pos, this._q, this._scale));
      this._q.setFromAxisAngle(this._cageAxis, -t * 0.45 + i);
      this._scale.setScalar(gone ? 0 : 0.94 + Math.sin(t * 1.4 + i) * 0.06);
      this.cage.setMatrixAt(i, this._m.compose(this._pos, this._q, this._scale));
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.cage.instanceMatrix.needsUpdate = true;
  }

  /**
   * Animates the beacons and collects any the aircraft has reached. Twelve distance
   * checks a frame, which is cheaper than the spatial hash it would take to avoid them.
   */
  update(dt, position) {
    this._t += dt;
    if (position && this.found.size < this.total) {
      for (const s of SECRETS) {
        if (this.found.has(s.id)) continue;
        const dx = position.x - s.x;
        const dy = position.y - s.y;
        const dz = position.z - s.z;
        if (dx * dx + dy * dy + dz * dz > SECRET_RADIUS * SECRET_RADIUS) continue;
        this.found.add(s.id);
        this.bus?.emit('secret:reached', { id: s.id, name: s.name, position: new THREE.Vector3(s.x, s.y, s.z) });
      }
    }
    this._write(this._t);
  }

  dispose() {
    this.scene.remove(this.mesh, this.cage);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.cage.geometry.dispose();
    this.cage.material.dispose();
  }
}
