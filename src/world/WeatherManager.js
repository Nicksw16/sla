import * as THREE from 'three';
import { clamp01, damp, lerp } from '../core/MathUtils.js';
import { WEATHER } from '../data/weather.js';

/**
 * Weather as gameplay (spec §62, §64).
 *
 * Publishes a wind vector, a gust scalar and a visibility factor. FlightModel reads
 * the first two and is pushed around by them; the fog and the sky read visibility.
 * Transitions are interpolated so a mission can start clear and end in a storm
 * without the world snapping between two states.
 */
const RAIN_COUNT = 4200;

export class WeatherManager {
  constructor({ scene, bus, settings }) {
    this.scene = scene;
    this.bus = bus;
    this.settings = settings;

    this.current = { ...WEATHER.clear };
    this.target = { ...WEATHER.clear };
    this.blend = 1;
    this.id = 'clear';

    this.wind = new THREE.Vector3();
    this.windDir = Math.random() * Math.PI * 2;
    this.gust = 0;
    this.turbulence = 0;
    this.flash = 0;
    this._flashTimer = 6 + Math.random() * 8;
    this._gustPhase = Math.random() * 100;
    this._elapsed = 0;

    this.rain = this._createRain();
    this.scene.add(this.rain);
  }

  _createRain() {
    const positions = new Float32Array(RAIN_COUNT * 3);
    const speeds = new Float32Array(RAIN_COUNT);
    for (let i = 0; i < RAIN_COUNT; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 260;
      positions[i * 3 + 1] = Math.random() * 180;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 260;
      speeds[i] = 0.7 + Math.random() * 0.6;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('aSpeed', new THREE.BufferAttribute(speeds, 1));

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uOpacity: { value: 0 },
        uStreak: { value: 1 },
      },
      vertexShader: `
        attribute float aSpeed;
        uniform float uStreak;
        varying float vFade;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          // Nearer drops are drawn larger, which reads as depth in the rain.
          gl_PointSize = (2.2 + aSpeed * 2.4) * uStreak * (300.0 / max(-mv.z, 1.0));
          vFade = aSpeed;
          }`,
      fragmentShader: `
        uniform float uOpacity;
        varying float vFade;
        void main() {
          vec2 d = gl_PointCoord - 0.5;
          // Vertically stretched dot: a streak without needing line geometry.
          float a = 1.0 - smoothstep(0.0, 0.5, length(vec2(d.x * 3.2, d.y)));
          gl_FragColor = vec4(vec3(0.68, 0.78, 0.9), a * uOpacity * vFade);
        }`,
    });
    const pts = new THREE.Points(geo, mat);
    pts.name = 'rain';
    pts.frustumCulled = false;
    pts.visible = false;
    pts.userData.uniforms = mat.uniforms;
    return pts;
  }

  /** Switches weather, optionally over a number of seconds. */
  set(id, { instant = false } = {}) {
    const w = WEATHER[id] ?? WEATHER.clear;
    this.id = w.id;
    if (instant) {
      this.current = { ...w };
      this.target = { ...w };
      this.blend = 1;
    } else {
      this.current = { ...this.current };
      this.target = { ...w };
      this.blend = 0;
    }
    this.bus?.emit('weather:change', { id: this.id, name: w.name });
  }

  get visibility() {
    return this.current.visibility;
  }

  update(dt, cameraPosition) {
    this._elapsed += dt;

    // --- blend toward the target state
    if (this.blend < 1) {
      this.blend = clamp01(this.blend + dt / 5);
      const t = this.blend;
      for (const k of ['cloudCover', 'cloudHeight', 'rain', 'wind', 'gust', 'visibility', 'lightning']) {
        this.current[k] = lerp(this.current[k], this.target[k], clamp01(dt / Math.max(0.05, 5 * (1 - t) + 0.05)));
      }
      if (t >= 1) this.current = { ...this.target };
    }

    // --- wind: a slowly rotating mean, plus a gust signal built from two
    // incommensurate sines so it never settles into an obvious rhythm.
    this.windDir += dt * 0.035;
    const speed = this.current.wind;
    this.wind.set(Math.sin(this.windDir) * speed, 0, Math.cos(this.windDir) * speed);
    this._gustPhase += dt;
    const g1 = Math.sin(this._gustPhase * 0.53);
    const g2 = Math.sin(this._gustPhase * 1.37 + 1.1);
    this.gust = clamp01((g1 * 0.6 + g2 * 0.4) * 0.5 + 0.5) * this.current.gust;
    this.turbulence = this.current.gust;
    // Vertical component: updraughts and sink, which is what makes a storm ridge
    // crossing genuinely harder rather than just darker.
    this.wind.y = Math.sin(this._gustPhase * 0.41) * speed * 0.22;

    // --- rain
    const rainAmount = this.current.rain * (this.settings.preset.particles ?? 1);
    const u = this.rain.userData.uniforms;
    u.uOpacity.value = damp(u.uOpacity.value, clamp01(rainAmount * 0.55), 3, dt);
    this.rain.visible = u.uOpacity.value > 0.01;
    if (this.rain.visible) {
      this.rain.position.copy(cameraPosition);
      const pos = this.rain.geometry.attributes.position;
      const spd = this.rain.geometry.attributes.aSpeed;
      const fall = 62 + this.current.rain * 40;
      for (let i = 0; i < RAIN_COUNT; i++) {
        const i3 = i * 3;
        pos.array[i3 + 1] -= fall * spd.array[i] * dt;
        pos.array[i3] += this.wind.x * dt * 0.8;
        pos.array[i3 + 2] += this.wind.z * dt * 0.8;
        if (pos.array[i3 + 1] < -90) {
          pos.array[i3] = (Math.random() - 0.5) * 260;
          pos.array[i3 + 1] = 150 + Math.random() * 60;
          pos.array[i3 + 2] = (Math.random() - 0.5) * 260;
        }
      }
      pos.needsUpdate = true;
    }

    // --- lightning
    this.flash = Math.max(0, this.flash - dt * 4.5);
    if (this.current.lightning > 0.02) {
      this._flashTimer -= dt * this.current.lightning;
      if (this._flashTimer <= 0) {
        this._flashTimer = 3.5 + Math.random() * 9;
        this.flash = 0.65 + Math.random() * 0.5;
        this.bus?.emit('weather:lightning', {
          intensity: this.flash,
          distance: 400 + Math.random() * 2600,
        });
      }
    }
  }

  /** Environment block handed to FlightModel each frame. */
  environment() {
    return { wind: this.wind, gust: this.gust, turbulence: this.turbulence };
  }

  dispose() {
    this.scene.remove(this.rain);
    this.rain.geometry.dispose();
    this.rain.material.dispose();
  }
}
