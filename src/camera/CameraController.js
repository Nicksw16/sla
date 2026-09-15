import * as THREE from 'three';
import { clamp, clamp01, damp, lerp, smoothstep } from '../core/MathUtils.js';

/**
 * Third-person chase camera (spec §17-20).
 *
 * The camera is the single biggest contributor to whether speed *feels* fast, so
 * it does four things at once: trails behind on a spring, widens its field of view
 * with speed, leads the turn so you can see where you are going, and shakes only
 * as much as the moment earns. All of it is frame-rate independent, and all of it
 * is scalable to zero for players who want none of it (§98, §146).
 */
const MODES = ['chase', 'far', 'cockpit'];

export class CameraController {
  constructor({ camera, settings, bus }) {
    this.camera = camera;
    this.settings = settings;
    this.bus = bus;
    this.mode = settings.get('cameraMode') ?? 'chase';
    this.baseFov = settings.get('fov') ?? 70;

    this.position = new THREE.Vector3();
    this.lookAt = new THREE.Vector3();
    this._desired = new THREE.Vector3();
    this._offset = new THREE.Vector3();
    this._tmp = new THREE.Vector3();
    this._tmpQ = new THREE.Quaternion();
    this._up = new THREE.Vector3(0, 1, 0);
    this._shake = 0;
    this._shakeSeed = Math.random() * 1000;
    this._fov = this.baseFov;
    this._roll = 0;
    this._lead = new THREE.Vector3();
    this._cinematic = null;
    this._lookBack = false;
    this._initialised = false;

    this._unsubs = [
      bus.on('damage:hit', (e) => this.addShake(e.shake ?? 0.5)),
      // Masonry hitting the street, and a tower finishing the job. Scaled by how
      // hard it landed so a single slab is a tremor and a collapse is not.
      bus.on('structure:landed', (e) => this.addShake(clamp01((e.speed ?? 20) / 70) * 0.5)),
      bus.on('structure:collapse', () => this.addShake(1.1)),
      bus.on('flight:impact', (e) => this.addShake(0.3 + e.severity * 0.8)),
      bus.on('flight:landed', (e) => this.addShake(0.15 + (1 - e.quality) * 0.4)),
      bus.on('flight:takeoff', () => this.addShake(0.2)),
    ];
  }

  setMode(mode) {
    this.mode = MODES.includes(mode) ? mode : 'chase';
    this.settings.set('cameraMode', this.mode);
    this._initialised = false;
    this.bus.emit('camera:mode', { mode: this.mode });
  }

  cycleMode() {
    this.setMode(MODES[(MODES.indexOf(this.mode) + 1) % MODES.length]);
  }

  addShake(amount) {
    const scale = this.settings.get('cameraShake') ?? 1;
    this._shake = Math.min(1.6, this._shake + amount * scale);
  }

  /** Short orbit used for crashes and mission completion (spec §47, §114). */
  startCinematic(target, { duration = 3, radius = 46, height = 18, spin = 0.7 } = {}) {
    this._cinematic = {
      target: target.clone(), t: 0, duration, radius, height, spin,
      angle: Math.random() * Math.PI * 2,
    };
  }

  stopCinematic() {
    this._cinematic = null;
    this._initialised = false;
  }

  get inCinematic() {
    return !!this._cinematic;
  }

  /** Rig geometry per mode. Cockpit sits at the pilot's eye, not behind the tail. */
  _rigFor(spec) {
    const len = spec?.model?.length ?? 8;
    switch (this.mode) {
      case 'far':
        return { dist: 14 + len * 2.6, height: 4.2 + len * 0.5, lookAhead: 22, fovBoost: 1 };
      case 'cockpit':
        return { dist: -len * 0.18, height: len * 0.14, lookAhead: 60, fovBoost: 1.06 };
      default:
        return { dist: 8.5 + len * 1.55, height: 2.4 + len * 0.34, lookAhead: 16, fovBoost: 1 };
    }
  }

  update(dt, flight, spec, input) {
    if (this._cinematic) {
      this._updateCinematic(dt);
      return;
    }

    const t = flight.telemetry();
    const rig = this._rigFor(spec);
    const speedFrac = clamp01(t.speed / Math.max(spec.maxSpeed, 1));
    const lookBack = !!input?.buttons?.look;

    // --- distance: pull back with speed, and further still under turbo, which is
    // most of why turbo reads as fast rather than merely being fast (§18).
    const turboPull = t.turbo ? 5.5 : 0;
    const dist = rig.dist * (1 + speedFrac * 0.16) + turboPull;
    const height = rig.height * (1 - speedFrac * 0.12);

    // --- desired position, in the aircraft's frame so it banks with you
    const back = lookBack ? -1 : 1;
    this._offset.set(0, height, dist * back).applyQuaternion(flight.quaternion);
    this._desired.copy(flight.position).add(this._offset);

    if (this.mode === 'cockpit') {
      // Rigid in the cockpit: a spring here would read as the seat sliding around.
      this.position.copy(this._desired);
    } else {
      if (!this._initialised) {
        this.position.copy(this._desired);
        this._initialised = true;
      }
      // Heavier aircraft let the camera trail further, which sells their mass (§9).
      const followRate = lerp(7.5, 4.2, clamp01((spec.mass ?? 0.8) / 1.3)) + speedFrac * 2.2;
      this.position.x = damp(this.position.x, this._desired.x, followRate, dt);
      this.position.y = damp(this.position.y, this._desired.y, followRate * 1.15, dt);
      this.position.z = damp(this.position.z, this._desired.z, followRate, dt);
    }

    // --- aim: lead the turn so the next checkpoint comes into view early (§17)
    const leadTarget = this._tmp
      .copy(flight.forward)
      .multiplyScalar(rig.lookAhead * back * (1 + speedFrac * 0.9));
    leadTarget.addScaledVector(flight.right, -t.turnRate * 26);
    this._lead.lerp(leadTarget, clamp01(dt * 5));
    this.lookAt.copy(flight.position).add(this._lead);

    // --- roll: partial in chase (readable), full in cockpit (immersive)
    const targetRoll = this.mode === 'cockpit' ? t.bank : t.bank * 0.45;
    this._roll = damp(this._roll, targetRoll, 8, dt);

    // --- field of view: the primary speed cue (§18)
    const fovTarget =
      this.baseFov * rig.fovBoost +
      speedFrac * 12 +
      (t.turbo ? 15 : 0) +
      clamp(t.stall * 6, 0, 6);
    this._fov = damp(this._fov, fovTarget, t.turbo ? 6 : 3.4, dt);

    this._applyToCamera(dt, flight, t);
  }

  _applyToCamera(dt, flight, t) {
    this.camera.position.copy(this.position);
    this.camera.up.set(0, 1, 0).applyAxisAngle(flight.forward, this._roll);
    this.camera.lookAt(this.lookAt);

    // --- shake. Sources: impacts (decaying), turbulence at speed, and stall buffet.
    this._shake = damp(this._shake, 0, 4.5, dt);
    const scale = this.settings.get('cameraShake') ?? 1;
    const buffet = (t.stall * 0.35 + clamp01(t.speed / 200) * 0.06) * scale;
    const amp = this._shake * 0.9 + buffet;
    if (amp > 0.001) {
      const now = performance.now() * 0.001 + this._shakeSeed;
      const jx = Math.sin(now * 37.1) * Math.sin(now * 11.7);
      const jy = Math.sin(now * 41.3) * Math.sin(now * 13.1);
      const jz = Math.sin(now * 29.7) * Math.sin(now * 17.3);
      this.camera.position.x += jx * amp * 0.55;
      this.camera.position.y += jy * amp * 0.55;
      this.camera.rotateZ(jz * amp * 0.02);
      this._fov += jy * amp * 1.2;
    }

    if (Math.abs(this.camera.fov - this._fov) > 0.01) {
      this.camera.fov = this._fov;
      this.camera.updateProjectionMatrix();
    }
  }

  _updateCinematic(dt) {
    const c = this._cinematic;
    c.t += dt;
    c.angle += c.spin * dt;
    const rise = smoothstep(0, c.duration, c.t);
    this.camera.position.set(
      c.target.x + Math.cos(c.angle) * c.radius,
      c.target.y + c.height + rise * 14,
      c.target.z + Math.sin(c.angle) * c.radius,
    );
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(c.target);
    this._fov = damp(this._fov, this.baseFov - 6, 2, dt);
    this.camera.fov = this._fov;
    this.camera.updateProjectionMatrix();
    if (c.t >= c.duration) {
      this._cinematic = null;
      this.bus.emit('camera:cinematicEnd', {});
    }
  }

  dispose() {
    for (const u of this._unsubs) u?.();
  }
}
