import { clamp, clamp01 } from '../core/MathUtils.js';

/**
 * Afterburn / turbo (spec §15-16).
 *
 * The interesting part is not the speed, it is the decision: a finite tank that
 * only refills after you let go, so "spend it here or save it for the next leg"
 * is a real question on every lap.
 */
export class TurboSystem {
  constructor({ spec, bus }) {
    this.bus = bus;
    this.setSpec(spec);
    this.energy = this.capacity;
    this.active = false;
    this.locked = false;
    this._sinceRelease = 99;
    this._wasActive = false;
    this.totalUsed = 0;
  }

  setSpec(spec) {
    this.spec = spec;
    this.capacity = spec.turboCapacity;
    this.drain = spec.turboDrain;
    this.regen = spec.turboRegen;
    this.delay = spec.turboDelay;
    if (this.energy === undefined) this.energy = this.capacity;
    this.energy = Math.min(this.energy ?? this.capacity, this.capacity);
  }

  reset(full = true) {
    this.energy = full ? this.capacity : this.capacity * 0.5;
    this.active = false;
    this.locked = false;
    this._sinceRelease = 99;
    this._wasActive = false;
    this.totalUsed = 0;
  }

  get fraction() {
    return clamp01(this.energy / this.capacity);
  }

  /** Requires a minimum charge to re-engage, so it cannot be machine-gunned. */
  get available() {
    return !this.locked && this.energy > this.capacity * 0.08;
  }

  update(dt, wantTurbo) {
    const want = !!wantTurbo && this.available;

    if (want) {
      this.energy -= this.drain * dt;
      this.totalUsed += this.drain * dt;
      this._sinceRelease = 0;
      if (this.energy <= 0) {
        this.energy = 0;
        this.locked = true; // must refill past the threshold before re-engaging
      }
    } else {
      this._sinceRelease += dt;
      if (this._sinceRelease >= this.delay) {
        this.energy = clamp(this.energy + this.regen * dt, 0, this.capacity);
      }
      if (this.locked && this.energy > this.capacity * 0.3) this.locked = false;
    }

    this.active = want && this.energy > 0;

    if (this.active !== this._wasActive) {
      this.bus?.emit(this.active ? 'turbo:start' : 'turbo:stop', { energy: this.energy });
      if (!this.active && this.energy <= 0) this.bus?.emit('turbo:empty', {});
      this._wasActive = this.active;
    }
  }
}
