import * as THREE from 'three';
import { clamp, damp } from '../core/MathUtils.js';
import { buildAircraft, animateAircraft, disposeAircraft } from '../flight/AircraftFactory.js';

/**
 * The hangar (spec §51).
 *
 * Its own scene rendered through the same renderer, so the aircraft you are about to
 * buy is the actual model you will fly, built by the same factory from the same spec —
 * not a picture of it. Drag to orbit, scroll to zoom.
 */
export class HangarScene {
  constructor({ renderer }) {
    this.renderer = renderer;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x080d14);
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 400);

    this.yaw = 0.7;
    this.pitch = 0.22;
    this.distance = 26;
    this.targetYaw = 0.7;
    this.targetPitch = 0.22;
    this.targetDistance = 26;
    this.autoSpin = true;

    // Three-point lighting plus a rim light: enough to read a silhouette clearly.
    const key = new THREE.DirectionalLight(0xffffff, 2.1);
    key.position.set(9, 12, 7);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0x6fa8ff, 0.7);
    fill.position.set(-10, 4, -6);
    this.scene.add(fill);
    const rim = new THREE.DirectionalLight(0x38e1ff, 1.1);
    rim.position.set(-4, 3, 12);
    this.scene.add(rim);
    this.scene.add(new THREE.HemisphereLight(0x3a4a5e, 0x0a0e14, 0.7));

    // Platform and a grid, so scale reads.
    const disc = new THREE.Mesh(
      new THREE.CylinderGeometry(15, 15, 0.5, 48),
      new THREE.MeshStandardMaterial({ color: 0x161c26, roughness: 0.75, metalness: 0.3 }),
    );
    disc.position.y = -2.4;
    this.scene.add(disc);
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(15, 0.1, 6, 64),
      new THREE.MeshBasicMaterial({ color: 0x38e1ff, transparent: true, opacity: 0.5 }),
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.y = -2.1;
    this.scene.add(ring);
    const grid = new THREE.GridHelper(80, 40, 0x1b3a46, 0x122530);
    grid.position.y = -2.5;
    this.scene.add(grid);

    // The screen's panels occupy the left of the viewport, so the aircraft is framed
    // to the right of centre rather than hidden behind them.
    this.framingShift = -7;
    this.model = null;
    this.telemetry = {
      throttle: 0.35, turbo: false, gearDown: true, speed: 0, speedFrac: 0,
      grounded: true, stall: 0, gLoad: 1,
    };
    this.control = { pitch: 0, roll: 0, yaw: 0 };
    this._elapsed = 0;
  }

  setAircraft(spec, paintId) {
    if (this.model) {
      this.scene.remove(this.model);
      disposeAircraft(this.model);
    }
    this.model = buildAircraft(spec, paintId);
    this.scene.add(this.model);
    // Frame the aircraft regardless of how big it is.
    this.targetDistance = clamp(spec.model.length * 2.0 + spec.model.wingspan * 0.9, 18, 52);
  }

  orbit(dx, dy) {
    this.autoSpin = false;
    this.targetYaw -= dx * 0.008;
    this.targetPitch = clamp(this.targetPitch + dy * 0.006, -0.35, 1.1);
  }

  zoom(delta) {
    this.targetDistance = clamp(this.targetDistance + delta * 2.2, 12, 60);
  }

  update(dt) {
    this._elapsed += dt;
    if (this.autoSpin) this.targetYaw += dt * 0.18;
    this.yaw = damp(this.yaw, this.targetYaw, 8, dt);
    this.pitch = damp(this.pitch, this.targetPitch, 8, dt);
    this.distance = damp(this.distance, this.targetDistance, 6, dt);

    const cp = Math.cos(this.pitch);
    this.camera.position.set(
      Math.sin(this.yaw) * cp * this.distance,
      Math.sin(this.pitch) * this.distance + 2.2,
      Math.cos(this.yaw) * cp * this.distance,
    );
    this.camera.lookAt(this.framingShift, 0.5, 0);

    if (this.model) {
      // Idle animation: the prop turns and the surfaces breathe, so the aircraft on
      // the pad looks alive rather than like a static render.
      this.control.roll = Math.sin(this._elapsed * 0.7) * 0.25;
      this.control.pitch = Math.sin(this._elapsed * 0.5 + 1) * 0.18;
      this.control.yaw = Math.sin(this._elapsed * 0.4 + 2) * 0.15;
      animateAircraft(this.model, dt, this.telemetry, this.control);
      this.model.position.y = Math.sin(this._elapsed * 0.8) * 0.12;
    }
  }

  resize(width, height) {
    this.camera.aspect = width / height;
    // On a narrow screen the panels stack and the aircraft belongs in the middle.
    this.framingShift = width < 900 ? 0 : -7;
    this.camera.updateProjectionMatrix();
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    if (this.model) disposeAircraft(this.model);
  }
}
