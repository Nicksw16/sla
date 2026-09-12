import { clamp, clamp01, damp, lerp } from '../core/MathUtils.js';

/**
 * Audio, synthesised in full.
 *
 * No audio assets ship with this project, so nothing here is a recording: the engine
 * is oscillators through a filter, the wind is shaped noise, impacts are noise bursts
 * with a falling cutoff, and the music is a generated arpeggio over a pad. That is a
 * deliberate fallback rather than a compromise dressed up as a feature (spec §161):
 * samples would sound better, and the mixer below is built so that dropping real
 * buffers in later means replacing the voice classes and nothing else.
 *
 * What matters for gameplay is preserved (§67-70): the engine tracks power and speed,
 * the wind tracks airspeed, turbo is audible before it is visible, and the music
 * intensifies as the clock runs out.
 */

const MASTER_CEILING = 0.9;

/** Reusable noise buffer — generating this per voice would be wasteful. */
function makeNoiseBuffer(ctx, seconds = 2) {
  const length = Math.floor(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

/**
 * Engine voice.
 *
 * A propeller and a jet are different instruments: the prop is a low blade-pass tone
 * with strong harmonics, the jet is a bright noise-dominated roar. Both track RPM.
 */
class EngineVoice {
  constructor(ctx, dest, noiseBuffer, kind) {
    this.ctx = ctx;
    this.kind = kind;
    this.output = ctx.createGain();
    this.output.gain.value = 0;
    this.output.connect(dest);

    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = 900;
    this.filter.Q.value = 1.1;
    this.filter.connect(this.output);

    // Tonal part: two detuned saws give a beating, mechanical quality.
    this.oscA = ctx.createOscillator();
    this.oscB = ctx.createOscillator();
    this.oscA.type = kind === 'prop' ? 'sawtooth' : 'square';
    this.oscB.type = 'sawtooth';
    this.toneGain = ctx.createGain();
    this.toneGain.gain.value = kind === 'prop' ? 0.5 : 0.22;
    this.oscA.connect(this.toneGain);
    this.oscB.connect(this.toneGain);
    this.toneGain.connect(this.filter);

    // Noise part: the air being moved. Dominates on a jet.
    this.noise = ctx.createBufferSource();
    this.noise.buffer = noiseBuffer;
    this.noise.loop = true;
    this.noiseBand = ctx.createBiquadFilter();
    this.noiseBand.type = 'bandpass';
    this.noiseBand.frequency.value = 700;
    this.noiseBand.Q.value = 0.7;
    this.noiseGain = ctx.createGain();
    this.noiseGain.gain.value = kind === 'prop' ? 0.2 : 0.62;
    this.noise.connect(this.noiseBand);
    this.noiseBand.connect(this.noiseGain);
    this.noiseGain.connect(this.filter);

    this.oscA.start();
    this.oscB.start();
    this.noise.start();
  }

  /** rpm 0..1, load 0..1, speedFrac 0..1. */
  update(rpm, load, speedFrac, dt) {
    const now = this.ctx.currentTime;
    const base = this.kind === 'prop' ? 58 : 96;
    const top = this.kind === 'prop' ? 190 : 340;
    const f = lerp(base, top, rpm);
    this.oscA.frequency.setTargetAtTime(f, now, 0.06);
    this.oscB.frequency.setTargetAtTime(f * 1.012, now, 0.06);
    this.filter.frequency.setTargetAtTime(lerp(420, 3400, rpm * 0.75 + speedFrac * 0.25), now, 0.08);
    this.noiseBand.frequency.setTargetAtTime(lerp(380, 2600, speedFrac), now, 0.1);
    const level = lerp(0.16, 0.62, load) * lerp(0.75, 1, rpm);
    this.output.gain.setTargetAtTime(level, now, 0.08);
  }

  silence() {
    this.output.gain.setTargetAtTime(0, this.ctx.currentTime, 0.12);
  }

  dispose() {
    try { this.oscA.stop(); this.oscB.stop(); this.noise.stop(); } catch { /* already stopped */ }
  }
}

/** Airflow noise. The main cue for speed once the engine tops out (spec §69). */
class WindVoice {
  constructor(ctx, dest, noiseBuffer) {
    this.ctx = ctx;
    this.output = ctx.createGain();
    this.output.gain.value = 0;
    this.output.connect(dest);
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'bandpass';
    this.filter.frequency.value = 500;
    this.filter.Q.value = 0.6;
    this.filter.connect(this.output);
    this.src = ctx.createBufferSource();
    this.src.buffer = noiseBuffer;
    this.src.loop = true;
    this.src.connect(this.filter);
    this.src.start();
  }

  update(speedFrac, stall) {
    const now = this.ctx.currentTime;
    this.filter.frequency.setTargetAtTime(lerp(240, 1700, speedFrac), now, 0.1);
    // Stall buffet raises Q so the airflow starts to howl.
    this.filter.Q.setTargetAtTime(lerp(0.6, 4, stall), now, 0.1);
    this.output.gain.setTargetAtTime(clamp01(speedFrac * 0.5 + stall * 0.2), now, 0.1);
  }

  silence() {
    this.output.gain.setTargetAtTime(0, this.ctx.currentTime, 0.15);
  }

  dispose() {
    try { this.src.stop(); } catch { /* already stopped */ }
  }
}

/** Afterburner: broadband roar plus a rising tone so engaging it is unmistakable. */
class TurboVoice {
  constructor(ctx, dest, noiseBuffer) {
    this.ctx = ctx;
    this.output = ctx.createGain();
    this.output.gain.value = 0;
    this.output.connect(dest);
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'bandpass';
    this.filter.frequency.value = 1200;
    this.filter.Q.value = 0.9;
    this.filter.connect(this.output);
    this.src = ctx.createBufferSource();
    this.src.buffer = noiseBuffer;
    this.src.loop = true;
    this.src.connect(this.filter);
    this.src.start();
    this.tone = ctx.createOscillator();
    this.tone.type = 'triangle';
    this.tone.frequency.value = 160;
    this.toneGain = ctx.createGain();
    this.toneGain.gain.value = 0;
    this.tone.connect(this.toneGain);
    this.toneGain.connect(this.output);
    this.tone.start();
  }

  update(active, energy) {
    const now = this.ctx.currentTime;
    this.output.gain.setTargetAtTime(active ? 0.42 : 0, now, active ? 0.05 : 0.2);
    this.filter.frequency.setTargetAtTime(active ? lerp(700, 2300, energy) : 900, now, 0.15);
    this.toneGain.gain.setTargetAtTime(active ? 0.1 : 0, now, 0.08);
    this.tone.frequency.setTargetAtTime(active ? lerp(120, 300, 1 - energy) : 160, now, 0.2);
  }

  dispose() {
    try { this.src.stop(); this.tone.stop(); } catch { /* already stopped */ }
  }
}

/**
 * Adaptive music (spec §70). Three layers over a fixed chord cycle: a pad that is
 * always present, an arpeggio that comes in during a mission, and a pulse that only
 * appears when the clock is nearly out. Intensity crossfades them.
 */
class MusicEngine {
  constructor(ctx, dest) {
    this.ctx = ctx;
    this.output = ctx.createGain();
    this.output.gain.value = 0;
    this.output.connect(dest);
    this.intensity = 0;
    this.targetIntensity = 0;
    this.enabled = false;
    this._next = 0;
    this._step = 0;
    // A minor progression: enough movement to sit under a race without narrating it.
    this.chords = [
      [220.00, 261.63, 329.63],
      [196.00, 246.94, 293.66],
      [174.61, 220.00, 261.63],
      [164.81, 207.65, 246.94],
    ];
    this.padGain = ctx.createGain();
    this.padGain.gain.value = 0;
    this.padGain.connect(this.output);
    this.arpGain = ctx.createGain();
    this.arpGain.gain.value = 0;
    this.arpGain.connect(this.output);
    this.pulseGain = ctx.createGain();
    this.pulseGain.gain.value = 0;
    this.pulseGain.connect(this.output);
    this._pad = [];
  }

  start() {
    if (this.enabled) return;
    this.enabled = true;
    const ctx = this.ctx;
    for (let i = 0; i < 3; i++) {
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = this.chords[0][i];
      const g = ctx.createGain();
      g.gain.value = 0.12;
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = 700;
      osc.connect(g); g.connect(f); f.connect(this.padGain);
      osc.start();
      this._pad.push({ osc, g });
    }
    this._next = ctx.currentTime + 0.1;
  }

  setIntensity(v) {
    this.targetIntensity = clamp01(v);
  }

  /** Schedules one arpeggio note or pulse hit at a given time. */
  _pluck(time, freq, gainNode, { type = 'square', dur = 0.22, level = 0.2 } = {}) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, time);
    g.gain.linearRampToValueAtTime(level, time + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0008, time + dur);
    osc.connect(g);
    g.connect(gainNode);
    osc.start(time);
    osc.stop(time + dur + 0.05);
  }

  update(dt) {
    if (!this.enabled) return;
    this.intensity = damp(this.intensity, this.targetIntensity, 1.2, dt);
    const now = this.ctx.currentTime;
    this.output.gain.setTargetAtTime(1, now, 0.4);
    this.padGain.gain.setTargetAtTime(lerp(0.35, 0.7, this.intensity), now, 0.5);
    this.arpGain.gain.setTargetAtTime(clamp01((this.intensity - 0.2) / 0.5) * 0.55, now, 0.4);
    this.pulseGain.gain.setTargetAtTime(clamp01((this.intensity - 0.72) / 0.28) * 0.6, now, 0.3);

    // Schedule a bar ahead; tempo rises with intensity.
    const beat = lerp(0.42, 0.26, this.intensity);
    while (this._next < now + 0.6) {
      const chord = this.chords[Math.floor(this._step / 8) % this.chords.length];
      for (let i = 0; i < 3; i++) {
        this._pad[i]?.osc.frequency.setTargetAtTime(chord[i], this._next, 0.3);
      }
      const note = chord[this._step % 3] * (this._step % 6 === 5 ? 2 : 1);
      this._pluck(this._next, note, this.arpGain, { type: 'square', dur: beat * 0.7, level: 0.16 });
      if (this._step % 2 === 0) {
        this._pluck(this._next, 55, this.pulseGain, { type: 'sine', dur: 0.16, level: 0.5 });
      }
      this._next += beat;
      this._step++;
    }
  }

  stop() {
    this.output.gain.setTargetAtTime(0, this.ctx.currentTime, 0.5);
  }

  dispose() {
    for (const p of this._pad) { try { p.osc.stop(); } catch { /* ignore */ } }
  }
}

export class AudioManager {
  constructor({ settings, bus }) {
    this.settings = settings;
    this.bus = bus;
    this.ctx = null;
    this.ready = false;
    this.failed = false;
    this.started = false;
    this._pendingKind = 'prop';

    this._unsubs = [
      bus.on('checkpoint:passed', (e) => this.checkpoint(e.accuracy)),
      bus.on('damage:hit', (e) => this.impact(e.severity, e.band)),
      bus.on('flight:impact', (e) => { if (e.severity < 0.14) this.scrape(); }),
      bus.on('damage:destroyed', () => this.explosion()),
      bus.on('flight:landed', (e) => this.touchdown(e.quality)),
      bus.on('flight:takeoff', () => this.blip(520, 0.14)),
      bus.on('turbo:start', () => this.blip(760, 0.08, 'sine')),
      bus.on('turbo:empty', () => this.blip(190, 0.2, 'sawtooth')),
      bus.on('score:combo', (e) => { if (e.broken) this.blip(160, 0.16, 'sawtooth'); }),
      bus.on('weather:lightning', (e) => this.thunder(e.distance)),
      bus.on('mission:complete', () => this.fanfare(true)),
      bus.on('mission:failed', () => this.fanfare(false)),
      bus.on('mission:countdown', () => {}),
      bus.on('ui:click', () => this.blip(440, 0.05, 'square', 0.06)),
      settings.onChange((k) => { if (k.startsWith('master') || k.endsWith('Volume') || k === '*') this._applyVolumes(); }),
    ];
  }

  /**
   * Must be called from a user gesture: browsers refuse to start audio otherwise.
   * Everything before this point runs silently rather than throwing.
   */
  init() {
    if (this.ready || this.failed) return this.ready;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) throw new Error('Web Audio unavailable');
      this.ctx = new Ctx();
      this.noiseBuffer = makeNoiseBuffer(this.ctx, 2);

      this.master = this.ctx.createGain();
      // A limiter in all but name: keeps a storm plus turbo plus an impact from clipping.
      this.compressor = this.ctx.createDynamicsCompressor();
      this.compressor.threshold.value = -14;
      this.compressor.knee.value = 12;
      this.compressor.ratio.value = 4;
      this.compressor.attack.value = 0.004;
      this.compressor.release.value = 0.18;
      this.master.connect(this.compressor);
      this.compressor.connect(this.ctx.destination);

      this.sfxBus = this.ctx.createGain();
      this.musicBus = this.ctx.createGain();
      this.sfxBus.connect(this.master);
      this.musicBus.connect(this.master);

      this.engine = new EngineVoice(this.ctx, this.sfxBus, this.noiseBuffer, this._pendingKind);
      this.wind = new WindVoice(this.ctx, this.sfxBus, this.noiseBuffer);
      this.turbo = new TurboVoice(this.ctx, this.sfxBus, this.noiseBuffer);
      this.music = new MusicEngine(this.ctx, this.musicBus);

      this.ready = true;
      this._applyVolumes();
      return true;
    } catch (err) {
      // A silent game is far better than a broken one (spec §122).
      console.warn('[AudioManager] audio unavailable; continuing without sound', err);
      this.failed = true;
      return false;
    }
  }

  resume() {
    if (!this.ready) this.init();
    if (this.ctx?.state === 'suspended') this.ctx.resume().catch(() => {});
    if (this.ready && !this.started) {
      this.started = true;
      this.music.start();
    }
  }

  suspend() {
    if (this.ctx?.state === 'running') this.ctx.suspend().catch(() => {});
  }

  _applyVolumes() {
    if (!this.ready) return;
    const master = clamp01(this.settings.get('masterVolume')) * MASTER_CEILING;
    this.master.gain.value = master;
    this.sfxBus.gain.value = clamp01(this.settings.get('sfxVolume'));
    this.musicBus.gain.value = clamp01(this.settings.get('musicVolume')) * 0.55;
  }

  /** Swaps the engine voice when the player changes aircraft. */
  setEngineKind(kind) {
    this._pendingKind = kind;
    if (!this.ready) return;
    if (this.engine?.kind === kind) return;
    this.engine.silence();
    const old = this.engine;
    setTimeout(() => old.dispose(), 300);
    this.engine = new EngineVoice(this.ctx, this.sfxBus, this.noiseBuffer, kind);
  }

  /** Continuous mix, driven by telemetry each frame. */
  update(dt, telemetry, turboState, context = {}) {
    if (!this.ready) return;
    const speedFrac = clamp01(telemetry.speedFrac);
    const rpm = clamp01(telemetry.throttle * 0.8 + speedFrac * 0.3);
    this.engine.update(rpm, clamp01(telemetry.throttle * 0.75 + 0.25), speedFrac, dt);
    this.wind.update(speedFrac, telemetry.stall);
    this.turbo.update(!!telemetry.turbo, turboState?.fraction ?? 0);

    // Music intensity: racing raises it, and the last seconds raise it sharply (§70).
    let intensity = 0.18 + speedFrac * 0.35;
    if (context.missionActive) intensity += 0.2;
    if (context.timeRemaining != null && context.hasTimeLimit) {
      if (context.timeRemaining < 12) intensity = 1;
      else if (context.timeRemaining < 25) intensity = Math.max(intensity, 0.8);
    }
    if (context.rivalClose) intensity = Math.max(intensity, 0.85);
    this.music.setIntensity(intensity);
    this.music.update(dt);
  }

  quietEngines() {
    if (!this.ready) return;
    this.engine.silence();
    this.wind.silence();
    this.turbo.update(false, 0);
  }

  // ---------------------------------------------------------------- one-shots
  blip(freq, dur = 0.1, type = 'sine', level = 0.18) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(level, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    osc.connect(g);
    g.connect(this.sfxBus);
    osc.start(t);
    osc.stop(t + dur + 0.03);
  }

  /** Rising two-tone on a good pass, single tone on a scrappy one (§74). */
  checkpoint(accuracy = 0.5) {
    if (!this.ready) return;
    const perfect = accuracy > 0.86;
    this.blip(perfect ? 880 : 660, 0.1, 'sine', 0.2);
    if (perfect) {
      const t = this.ctx.currentTime;
      setTimeout(() => this.blip(1320, 0.14, 'sine', 0.16), 70);
    }
  }

  /** Noise burst with a collapsing filter: reads as a bang without a sample. */
  impact(severity = 0.5, band = 'light') {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = false;
    src.playbackRate.value = 0.7 + Math.random() * 0.5;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    const startF = lerp(900, 4200, clamp01(severity));
    filter.frequency.setValueAtTime(startF, t);
    filter.frequency.exponentialRampToValueAtTime(90, t + 0.45);
    const g = this.ctx.createGain();
    const level = lerp(0.2, 0.85, clamp01(severity));
    g.gain.setValueAtTime(level, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
    src.connect(filter); filter.connect(g); g.connect(this.sfxBus);
    src.start(t, Math.random() * 1.2, 0.6);
    // Low thump underneath, so a heavy hit is felt rather than just heard.
    if (severity > 0.3) {
      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(120, t);
      osc.frequency.exponentialRampToValueAtTime(40, t + 0.3);
      const og = this.ctx.createGain();
      og.gain.setValueAtTime(severity * 0.6, t);
      og.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
      osc.connect(og); og.connect(this.sfxBus);
      osc.start(t); osc.stop(t + 0.4);
    }
  }

  scrape() {
    this.impact(0.1);
  }

  explosion() {
    if (!this.ready) return;
    this.impact(1);
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.playbackRate.value = 0.35;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(1800, t);
    filter.frequency.exponentialRampToValueAtTime(60, t + 1.6);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.9, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 1.8);
    src.connect(filter); filter.connect(g); g.connect(this.sfxBus);
    src.start(t, 0, 2);
  }

  touchdown(quality = 0.5) {
    if (!this.ready) return;
    this.impact(lerp(0.32, 0.08, clamp01(quality)));
    this.blip(300, 0.1, 'sine', 0.1);
  }

  thunder(distance = 1200) {
    if (!this.ready) return;
    // Distance shows up as delay and as how much high end survives the trip.
    const delay = clamp(distance / 340, 0.1, 6);
    setTimeout(() => {
      if (!this.ready) return;
      const t = this.ctx.currentTime;
      const src = this.ctx.createBufferSource();
      src.buffer = this.noiseBuffer;
      src.playbackRate.value = 0.3;
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = lerp(1400, 180, clamp01(distance / 3000));
      const g = this.ctx.createGain();
      const level = lerp(0.7, 0.12, clamp01(distance / 3000));
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(level, t + 0.08);
      g.gain.exponentialRampToValueAtTime(0.001, t + 2.2);
      src.connect(filter); filter.connect(g); g.connect(this.sfxBus);
      src.start(t, 0, 2.4);
    }, delay * 1000);
  }

  fanfare(success) {
    if (!this.ready) return;
    const notes = success ? [523.25, 659.25, 783.99, 1046.5] : [392, 329.63, 261.63];
    notes.forEach((f, i) => {
      setTimeout(() => this.blip(f, success ? 0.3 : 0.5, success ? 'triangle' : 'sawtooth', 0.2), i * 130);
    });
  }

  countdownBeep(final = false) {
    this.blip(final ? 1046 : 660, final ? 0.3 : 0.12, 'square', 0.18);
  }

  dispose() {
    for (const u of this._unsubs) u?.();
    if (!this.ready) return;
    this.engine?.dispose();
    this.wind?.dispose();
    this.turbo?.dispose();
    this.music?.dispose();
    this.ctx?.close?.().catch(() => {});
    this.ready = false;
  }
}
