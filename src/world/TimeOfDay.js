import * as THREE from 'three';
import { clamp01, lerp, smoothstep } from '../core/MathUtils.js';

/**
 * Drives the lighting rig from a single number: the hour of the day.
 *
 * Keyframes below are interpolated, so any hour produces a coherent set of sun
 * angle, light colour, ambient fill, sky gradient and fog. The "night" value it
 * publishes is what turns on every window in the city and every street light
 * (spec §63), which is why it lives in one place instead of being guessed at
 * separately by each system.
 */
const KEYS = [
  // hour, sunElevation(deg), sunAzimuth(deg), sunColor, sunIntensity, ambient, zenith, horizon, fog
  { h: 0,    elev: -40, azi: 20,  sun: 0x2a3550, si: 0.06, amb: 0x1a2740, ai: 0.22, zen: 0x060d1c, hor: 0x121d33, fog: 0x101a2b },
  { h: 5.0,  elev: -12, azi: 72,  sun: 0x40405e, si: 0.12, amb: 0x27354f, ai: 0.3,  zen: 0x122038, hor: 0x3a3c55, fog: 0x2c3448 },
  { h: 6.4,  elev: 3,   azi: 84,  sun: 0xff9c52, si: 0.75, amb: 0x6e6a84, ai: 0.62, zen: 0x2d4f80, hor: 0xf0a468, fog: 0xc99a82 },
  { h: 8.0,  elev: 22,  azi: 100, sun: 0xffd9a8, si: 1.35, amb: 0x9fb0c8, ai: 0.95, zen: 0x2f6cb4, hor: 0xc3dcee, fog: 0xb9d2e4 },
  { h: 12.5, elev: 68,  azi: 180, sun: 0xfff6e4, si: 1.6,  amb: 0xb6c8da, ai: 1.15, zen: 0x2467b8, hor: 0xbdd8ec, fog: 0xbdd6e8 },
  { h: 16.5, elev: 28,  azi: 250, sun: 0xffe2b0, si: 1.4,  amb: 0xa8bacd, ai: 0.98, zen: 0x2b68ac, hor: 0xcbdcea, fog: 0xc0d2e0 },
  { h: 18.7, elev: 4,   azi: 272, sun: 0xff7a3c, si: 0.95, amb: 0x7d7590, ai: 0.66, zen: 0x2a4478, hor: 0xff9a55, fog: 0xd08f68 },
  { h: 19.9, elev: -6,  azi: 282, sun: 0x9a5a78, si: 0.3,  amb: 0x3a3a5a, ai: 0.33, zen: 0x16224a, hor: 0x8a5570, fog: 0x5c4a60 },
  { h: 21.5, elev: -22, azi: 300, sun: 0x33405e, si: 0.09, amb: 0x1f2b45, ai: 0.25, zen: 0x0a1226, hor: 0x1a2540, fog: 0x16203a },
  { h: 24,   elev: -40, azi: 20,  sun: 0x2a3550, si: 0.06, amb: 0x1a2740, ai: 0.22, zen: 0x060d1c, hor: 0x121d33, fog: 0x101a2b },
];

const _a = new THREE.Color();
const _b = new THREE.Color();

function sampleKeys(hour) {
  const h = ((hour % 24) + 24) % 24;
  let i = 0;
  while (i < KEYS.length - 2 && KEYS[i + 1].h <= h) i++;
  const k0 = KEYS[i];
  const k1 = KEYS[i + 1];
  const t = clamp01((h - k0.h) / Math.max(0.0001, k1.h - k0.h));
  const mixColor = (a, b, out) => out.set(a).lerp(_b.set(b), t);
  return {
    elev: lerp(k0.elev, k1.elev, t),
    azi: lerp(k0.azi, k1.azi, t),
    sunIntensity: lerp(k0.si, k1.si, t),
    ambIntensity: lerp(k0.ai, k1.ai, t),
    sunColor: mixColor(k0.sun, k1.sun, _a.clone()),
    ambColor: mixColor(k0.amb, k1.amb, _a.clone()),
    zenith: mixColor(k0.zen, k1.zen, _a.clone()),
    horizon: mixColor(k0.hor, k1.hor, _a.clone()),
    fog: mixColor(k0.fog, k1.fog, _a.clone()),
  };
}

export class TimeOfDay {
  constructor({ scene, settings }) {
    this.scene = scene;
    this.settings = settings;
    this.hour = 12.5;
    this.night = 0;

    this.sun = new THREE.DirectionalLight(0xffffff, 1.5);
    this.sun.castShadow = !!settings.preset.shadows;
    this._configureShadow();
    scene.add(this.sun);
    scene.add(this.sun.target);

    this.ambient = new THREE.HemisphereLight(0xbfd4e6, 0x4a4336, 0.6);
    scene.add(this.ambient);

    this.sunDir = new THREE.Vector3(0.3, 0.7, 0.4);
    this.state = sampleKeys(this.hour);
  }

  _configureShadow() {
    const preset = this.settings.preset;
    const size = preset.shadowSize;
    this.sun.shadow.mapSize.set(size, size);
    // A tight box that follows the aircraft: sharp shadows where the player is,
    // and none wasted on the far side of the city (spec §89).
    const extent = 620;
    const cam = this.sun.shadow.camera;
    cam.left = -extent; cam.right = extent;
    cam.top = extent; cam.bottom = -extent;
    cam.near = 10; cam.far = 3200;
    cam.updateProjectionMatrix();
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 1.2;
  }

  applyQuality() {
    this.sun.castShadow = !!this.settings.preset.shadows;
    this._configureShadow();
  }

  setHour(hour) {
    this.hour = ((hour % 24) + 24) % 24;
    this.refresh();
  }

  refresh() {
    const s = sampleKeys(this.hour);
    this.state = s;
    const elevRad = s.elev * Math.PI / 180;
    const aziRad = s.azi * Math.PI / 180;
    this.sunDir.set(
      Math.cos(elevRad) * Math.sin(aziRad),
      Math.sin(elevRad),
      Math.cos(elevRad) * Math.cos(aziRad),
    ).normalize();

    this.sun.color.copy(s.sunColor);
    this.sun.intensity = s.sunIntensity;
    this.ambient.color.copy(s.ambColor);
    // A brighter bounce colour: with the sun overhead, this is most of the light
    // reaching the vertical faces the player spends the whole game looking at.
    this.ambient.groundColor.set(0x6b6355).lerp(s.ambColor, 0.5);
    this.ambient.intensity = s.ambIntensity;

    // Night ramps in below the horizon; this is what lights the city.
    this.night = 1 - smoothstep(-7, 4, s.elev);
  }

  /** Keeps the shadow frustum centred on the aircraft. */
  follow(target) {
    const d = 900;
    this.sun.position.copy(target).addScaledVector(this.sunDir, d);
    this.sun.target.position.copy(target);
    this.sun.target.updateMatrixWorld();
  }

  /** Runs the clock forward for free flight; missions normally pin the hour. */
  advance(dt, scale = 0) {
    if (scale > 0) {
      this.hour = (this.hour + (dt / 60) * scale) % 24;
      this.refresh();
    }
  }
}
