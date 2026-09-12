import * as THREE from 'three';
import { clamp, clamp01, damp } from '../core/MathUtils.js';

/**
 * Particle and trail effects (spec §65-66, §74).
 *
 * One pooled buffer of points serves every emitter — turbo exhaust, impact sparks,
 * explosions, touchdown smoke — because allocating geometry mid-flight is how you get
 * a stutter at the exact moment something dramatic happens (§130). Particles are
 * recycled, never created.
 *
 * The wingtip contrails are a separate ribbon: they need continuity along a path,
 * which points cannot give you.
 */

const MAX_PARTICLES = 1400;

const KINDS = {
  exhaust: { size: 5.5, life: 0.55, drag: 2.6, gravity: -1.2, color: new THREE.Color(0x8fd4ff), fade: 1 },
  spark: { size: 2.6, life: 0.8, drag: 1.2, gravity: -16, color: new THREE.Color(0xffb648), fade: 1.4 },
  debris: { size: 3.4, life: 1.9, drag: 0.5, gravity: -20, color: new THREE.Color(0x8b8f96), fade: 0.7 },
  fire: { size: 11, life: 0.9, drag: 3.2, gravity: 5, color: new THREE.Color(0xff7326), fade: 1.2 },
  smoke: { size: 15, life: 2.6, drag: 1.6, gravity: 2.4, color: new THREE.Color(0x6d7278), fade: 0.55 },
  spray: { size: 6, life: 0.9, drag: 2.2, gravity: -6, color: new THREE.Color(0xdfefff), fade: 1 },
};

export class ParticleSystem {
  constructor({ scene, settings }) {
    this.settings = settings;
    this.count = Math.round(MAX_PARTICLES * clamp(settings.preset.particles ?? 1, 0.3, 1.4));
    this.positions = new Float32Array(this.count * 3);
    this.velocities = new Float32Array(this.count * 3);
    this.colors = new Float32Array(this.count * 3);
    this.sizes = new Float32Array(this.count);
    this.ages = new Float32Array(this.count);
    this.lifetimes = new Float32Array(this.count);
    this.kinds = new Array(this.count).fill(null);
    this.alive = new Uint8Array(this.count);
    this._cursor = 0;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(this.colors, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.sizes, 1));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(new Float32Array(this.count), 1));
    this.alphas = geo.getAttribute('aAlpha').array;

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uScale: { value: window.innerHeight || 800 } },
      vertexShader: `
        attribute vec3 aColor;
        attribute float aSize;
        attribute float aAlpha;
        uniform float uScale;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vColor = aColor;
          vAlpha = aAlpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = aSize * (uScale * 0.55) / max(-mv.z, 1.0);
        }`,
      fragmentShader: `
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          if (d > 0.5) discard;
          float a = (1.0 - smoothstep(0.1, 0.5, d)) * vAlpha;
          gl_FragColor = vec4(vColor, a);
        }`,
    });

    this.points = new THREE.Points(geo, mat);
    this.points.name = 'particles';
    this.points.frustumCulled = false;
    scene.add(this.points);
    this.geometry = geo;
    this.material = mat;
    this.scene = scene;
  }

  resize(height) {
    this.material.uniforms.uScale.value = height;
  }

  /** Claims a slot, overwriting the oldest if the pool is full. */
  _claim() {
    for (let i = 0; i < this.count; i++) {
      const idx = (this._cursor + i) % this.count;
      if (!this.alive[idx]) {
        this._cursor = (idx + 1) % this.count;
        return idx;
      }
    }
    const idx = this._cursor;
    this._cursor = (this._cursor + 1) % this.count;
    return idx;
  }

  spawn(kind, x, y, z, vx, vy, vz, { size = 1, life = 1, tint = null } = {}) {
    const k = KINDS[kind];
    if (!k) return;
    const i = this._claim();
    const i3 = i * 3;
    this.positions[i3] = x; this.positions[i3 + 1] = y; this.positions[i3 + 2] = z;
    this.velocities[i3] = vx; this.velocities[i3 + 1] = vy; this.velocities[i3 + 2] = vz;
    const c = tint ?? k.color;
    this.colors[i3] = c.r; this.colors[i3 + 1] = c.g; this.colors[i3 + 2] = c.b;
    this.sizes[i] = k.size * size;
    this.lifetimes[i] = k.life * life;
    this.ages[i] = 0;
    this.kinds[i] = kind;
    this.alive[i] = 1;
    this.alphas[i] = 1;
  }

  burst(kind, origin, count, speed, opts = {}) {
    const n = Math.round(count * clamp(this.settings.preset.particles ?? 1, 0.3, 1.4));
    for (let i = 0; i < n; i++) {
      // Uniform direction on a sphere.
      const u = Math.random() * 2 - 1;
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(1 - u * u);
      const s = speed * (0.4 + Math.random() * 0.9);
      this.spawn(kind, origin.x, origin.y, origin.z, r * Math.cos(a) * s, u * s, r * Math.sin(a) * s, opts);
    }
  }

  update(dt) {
    let live = 0;
    for (let i = 0; i < this.count; i++) {
      if (!this.alive[i]) { this.alphas[i] = 0; continue; }
      const k = KINDS[this.kinds[i]];
      this.ages[i] += dt;
      const t = this.ages[i] / this.lifetimes[i];
      if (t >= 1) { this.alive[i] = 0; this.alphas[i] = 0; continue; }
      const i3 = i * 3;
      const drag = Math.exp(-k.drag * dt);
      this.velocities[i3] *= drag;
      this.velocities[i3 + 1] = this.velocities[i3 + 1] * drag + k.gravity * dt;
      this.velocities[i3 + 2] *= drag;
      this.positions[i3] += this.velocities[i3] * dt;
      this.positions[i3 + 1] += this.velocities[i3 + 1] * dt;
      this.positions[i3 + 2] += this.velocities[i3 + 2] * dt;
      this.alphas[i] = Math.pow(1 - t, k.fade);
      live++;
    }
    this.liveCount = live;
    this.geometry.getAttribute('position').needsUpdate = true;
    this.geometry.getAttribute('aColor').needsUpdate = true;
    this.geometry.getAttribute('aSize').needsUpdate = true;
    this.geometry.getAttribute('aAlpha').needsUpdate = true;
  }

  clear() {
    this.alive.fill(0);
    this.alphas.fill(0);
  }

  dispose() {
    this.scene.remove(this.points);
    this.geometry.dispose();
    this.material.dispose();
  }
}

/**
 * Wingtip contrails. They appear when the wing is working hard — high g, or high
 * speed — which makes them a readable, diegetic instrument for how aggressively the
 * aircraft is being flown (spec §66).
 */
export class ContrailSystem {
  constructor({ scene, length = 42 }) {
    this.length = length;
    this.trails = [];
    this.group = new THREE.Group();
    this.group.name = 'contrails';
    scene.add(this.group);
    this.scene = scene;

    for (let side = 0; side < 2; side++) {
      const positions = new Float32Array(length * 3);
      const alphas = new Float32Array(length);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geo.setAttribute('aAlpha', new THREE.BufferAttribute(alphas, 1));
      const mat = new THREE.ShaderMaterial({
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        uniforms: { uStrength: { value: 0 } },
        vertexShader: `
          attribute float aAlpha;
          varying float vAlpha;
          void main() {
            vAlpha = aAlpha;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }`,
        fragmentShader: `
          uniform float uStrength;
          varying float vAlpha;
          void main() { gl_FragColor = vec4(0.86, 0.93, 1.0, vAlpha * uStrength * 0.28); }`,
      });
      const line = new THREE.Line(geo, mat);
      line.frustumCulled = false;
      this.group.add(line);
      this.trails.push({ line, positions, alphas, geo, mat, filled: 0 });
    }
  }

  reset(position) {
    for (const t of this.trails) {
      for (let i = 0; i < this.length; i++) {
        t.positions[i * 3] = position.x;
        t.positions[i * 3 + 1] = position.y;
        t.positions[i * 3 + 2] = position.z;
        t.alphas[i] = 0;
      }
      t.filled = 0;
      t.geo.getAttribute('position').needsUpdate = true;
      t.geo.getAttribute('aAlpha').needsUpdate = true;
    }
  }

  update(dt, flight, spec, telemetry) {
    // Vortices form under load. Thresholds are deliberately high: at the previous
    // settings the trails were visible at ordinary cruise, where they read as two
    // stray lines rather than as the aircraft working hard.
    const load = clamp01((Math.abs(telemetry.gLoad) - 2.2) / 2.2);
    const fast = clamp01((telemetry.speed / spec.maxSpeed - 0.93) / 0.07);
    const strength = clamp01(Math.max(load, fast * 0.55)) * (telemetry.grounded ? 0 : 1);

    const halfSpan = spec.model.wingspan * 0.5;
    for (let s = 0; s < 2; s++) {
      const t = this.trails[s];
      const tip = new THREE.Vector3((s === 0 ? 1 : -1) * halfSpan, 0, 0)
        .applyQuaternion(flight.quaternion).add(flight.position);
      // Shift the ribbon along by one vertex and write the new tip at the head.
      t.positions.copyWithin(3, 0, (this.length - 1) * 3);
      t.positions[0] = tip.x; t.positions[1] = tip.y; t.positions[2] = tip.z;
      t.alphas.copyWithin(1, 0, this.length - 1);
      t.alphas[0] = strength;
      for (let i = 1; i < this.length; i++) t.alphas[i] *= 0.965;
      t.mat.uniforms.uStrength.value = damp(t.mat.uniforms.uStrength.value, strength, 5, dt);
      t.geo.getAttribute('position').needsUpdate = true;
      t.geo.getAttribute('aAlpha').needsUpdate = true;
    }
  }

  setVisible(v) {
    this.group.visible = v;
  }

  dispose() {
    this.scene.remove(this.group);
    for (const t of this.trails) { t.geo.dispose(); t.mat.dispose(); }
  }
}

/**
 * Ties the particle pool to game events so the rest of the code never has to think
 * about effects: it emits what happened, and something visible occurs (spec §74).
 */
export class EffectsDirector {
  constructor({ bus, particles, contrails, settings }) {
    this.bus = bus;
    this.particles = particles;
    this.contrails = contrails;
    this.settings = settings;
    this._exhaustAccum = 0;
    this._tmp = new THREE.Vector3();

    this._unsubs = [
      bus.on('flight:impact', (e) => this._onImpact(e)),
      bus.on('damage:destroyed', (e) => this._onDestroyed(e)),
      bus.on('flight:landed', (e) => this._onLanded(e)),
      bus.on('checkpoint:passed', (e) => this._onCheckpoint(e)),
      bus.on('weather:lightning', () => {}),
    ];
  }

  _onImpact(e) {
    if (!e.point) return;
    const n = Math.round(6 + e.severity * 26);
    this.particles.burst('spark', e.point, n, 8 + e.severity * 26);
    if (e.severity > 0.25) {
      this.particles.burst('debris', e.point, Math.round(e.severity * 12), 6 + e.severity * 16);
      this.particles.burst('smoke', e.point, 4, 3, { size: 0.8 });
    }
  }

  _onDestroyed(e) {
    const p = e.point ?? this._tmp;
    this.particles.burst('fire', p, 40, 22, { size: 1.5, life: 1.4 });
    this.particles.burst('debris', p, 34, 26);
    this.particles.burst('smoke', p, 26, 10, { size: 1.6, life: 1.5 });
    this.particles.burst('spark', p, 30, 30);
  }

  _onLanded(e) {
    if (!e.position) return;
    this.particles.burst('smoke', e.position, 8, 5, { size: 0.7, life: 0.6 });
  }

  _onCheckpoint(e) {
    const cp = e.checkpoint;
    if (!cp) return;
    this._tmp.set(cp.x, cp.y, cp.z);
    // A ring of sparks blown outward: unmistakable confirmation you got it (§74).
    this.particles.burst('exhaust', this._tmp, 16, 14, {
      tint: new THREE.Color(e.accuracy > 0.86 ? 0xffd24a : 0x38e1ff), life: 0.8,
    });
  }

  /** Continuous emitters: turbo plume, stall buffet wisps, spray over water. */
  update(dt, flight, spec, telemetry, world) {
    if (telemetry.turbo) {
      this._exhaustAccum += dt * 90;
      const n = Math.floor(this._exhaustAccum);
      this._exhaustAccum -= n;
      const back = this._tmp.set(0, 0, spec.model.length * 0.5)
        .applyQuaternion(flight.quaternion).add(flight.position);
      for (let i = 0; i < n; i++) {
        const spread = 2.2;
        this.particles.spawn('exhaust',
          back.x + (Math.random() - 0.5) * spread,
          back.y + (Math.random() - 0.5) * spread,
          back.z + (Math.random() - 0.5) * spread,
          -flight.forward.x * 22 + (Math.random() - 0.5) * 5,
          -flight.forward.y * 22 + (Math.random() - 0.5) * 5,
          -flight.forward.z * 22 + (Math.random() - 0.5) * 5,
          { size: 0.8 + Math.random() * 0.7, life: 0.7 },
        );
      }
    }

    // Sea spray when skimming the water — a cue for exactly how low you are.
    if (!telemetry.grounded && telemetry.aboveGround < 22 && world?.isOverWater(flight.position.x, flight.position.z)) {
      if (Math.random() < dt * 40) {
        this.particles.spawn('spray',
          flight.position.x + (Math.random() - 0.5) * 24, 1,
          flight.position.z + (Math.random() - 0.5) * 24,
          (Math.random() - 0.5) * 6, 7 + Math.random() * 9, (Math.random() - 0.5) * 6,
          { size: 1.2, life: 1 });
      }
    }

    this.contrails.update(dt, flight, spec, telemetry);
  }

  dispose() {
    for (const u of this._unsubs) u?.();
  }
}
