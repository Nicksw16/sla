import { angleDelta } from '../core/MathUtils.js';

/**
 * Recognises aerobatics for the score system (spec §41).
 *
 * Works by accumulating rotation about the roll and pitch axes and firing when a
 * full revolution completes cleanly. Rotation only counts while airborne and
 * undamaged this attempt, so scraping a building mid-roll forfeits the trick —
 * which is the risk half of "risk and reward".
 */
const TWO_PI = Math.PI * 2;

export class TrickDetector {
  constructor({ bus }) {
    this.bus = bus;
    this.reset();
    this._unsubs = [
      bus.on('damage:hit', () => this.spoil()),
      bus.on('flight:impact', () => this.spoil()),
    ];
  }

  reset() {
    this.rollAccum = 0;
    this.pitchAccum = 0;
    this._lastBank = null;
    this._lastPitch = null;
    this.spoiled = false;
    this.rolls = 0;
    this.loops = 0;
  }

  spoil() {
    this.spoiled = true;
    this.rollAccum = 0;
    this.pitchAccum = 0;
  }

  update(dt, telemetry) {
    if (telemetry.grounded) {
      this.rollAccum = 0;
      this.pitchAccum = 0;
      this._lastBank = null;
      this._lastPitch = null;
      return;
    }

    // Track total swept angle, not the instantaneous attitude, so a slow roll and
    // a snap roll both register once and only once.
    const bank = telemetry.bank;
    if (this._lastBank !== null) {
      this.rollAccum += angleDelta(this._lastBank, bank);
    }
    this._lastBank = bank;

    const pitch = telemetry.pitch;
    if (this._lastPitch !== null) {
      const d = pitch - this._lastPitch;
      // Ignore the wrap that happens as the nose passes straight up or down.
      if (Math.abs(d) < 0.6) this.pitchAccum += d;
    }
    this._lastPitch = pitch;

    if (Math.abs(this.rollAccum) >= TWO_PI) {
      const count = Math.trunc(Math.abs(this.rollAccum) / TWO_PI);
      this.rollAccum -= Math.sign(this.rollAccum) * TWO_PI * count;
      this.rolls += count;
      if (!this.spoiled) {
        this.bus.emit('flight:trick', {
          type: 'roll', name: count > 1 ? `${count}× BARREL ROLL` : 'BARREL ROLL',
          count, speed: telemetry.speed,
        });
      }
      this.spoiled = false;
    }

    // A loop shows up as a full 2π sweep of pitch; the nose has to go over the top.
    if (Math.abs(this.pitchAccum) >= TWO_PI * 0.92) {
      this.pitchAccum = 0;
      this.loops++;
      if (!this.spoiled) {
        this.bus.emit('flight:trick', { type: 'loop', name: 'LOOP', count: 1, speed: telemetry.speed });
      }
      this.spoiled = false;
    }
  }

  dispose() {
    for (const u of this._unsubs) u?.();
  }
}
