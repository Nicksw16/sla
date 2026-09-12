import { clamp01, lerp } from '../core/MathUtils.js';

/**
 * Score and combo (spec §38-43).
 *
 * The combo is the part that matters. Points for a checkpoint are unremarkable;
 * points for eleven checkpoints in a row without touching anything, at speed, is a
 * reason to take the risky line. So the multiplier climbs with clean precise passes,
 * decays if you dawdle, and a collision takes it away entirely (§40).
 */

export const SCORE = {
  checkpointBase: 800,
  precisionBonus: 700,      // at dead centre
  speedBonus: 500,          // at top speed
  nearMiss: 140,
  nearMissTight: 260,       // inside 12 m
  trickRoll: 700,
  trickLoop: 1100,
  perfectRun: 6000,
  timeRemainingPerSecond: 90,
  damagePenaltyPerPoint: 40,
  landingBonus: 2500,
  comboStep: 0.25,
  comboMax: 8,
  comboDecay: 8,            // seconds of nothing before it starts falling
};

export class ScoreSystem {
  constructor({ bus }) {
    this.bus = bus;
    this.reset();
    this._unsubs = [
      bus.on('checkpoint:passed', (e) => this.onCheckpoint(e)),
      bus.on('flight:nearmiss', (e) => this.onNearMiss(e)),
      bus.on('flight:trick', (e) => this.onTrick(e)),
      bus.on('damage:hit', (e) => this.onDamage(e)),
      bus.on('flight:landed', (e) => this.onLanding(e)),
    ];
  }

  reset() {
    this.score = 0;
    this.combo = 1;
    this.bestCombo = 1;
    this.comboTimer = 0;
    this.checkpoints = 0;
    this.nearMisses = 0;
    this.tricks = 0;
    this.damageTaken = 0;
    this.collisions = 0;
    this.topSpeed = 0;
    this.perfect = true;
    this.breakdown = {
      checkpoints: 0, precision: 0, speed: 0, nearMiss: 0, tricks: 0,
      penalties: 0, landing: 0, timeBonus: 0, perfect: 0,
    };
    this.enabled = true;
  }

  _award(amount, category, label, kind = 'score') {
    if (!this.enabled || amount === 0) return 0;
    const value = Math.round(amount);
    this.score = Math.max(0, this.score + value);
    if (category) this.breakdown[category] += value;
    if (label) this.bus.emit('score:popup', { label, value, kind });
    return value;
  }

  _bumpCombo() {
    this.combo = Math.min(SCORE.comboMax, this.combo + SCORE.comboStep);
    this.bestCombo = Math.max(this.bestCombo, this.combo);
    this.comboTimer = SCORE.comboDecay;
    this.bus.emit('score:combo', { combo: this.combo });
  }

  onCheckpoint(e) {
    if (!this.enabled) return;
    this.checkpoints++;
    const speedFrac = clamp01((e.speed ?? 0) / 200);
    const base = SCORE.checkpointBase;
    const precision = SCORE.precisionBonus * Math.pow(e.accuracy, 1.6);
    const speed = SCORE.speedBonus * speedFrac;
    const total = (base + precision + speed) * this.combo;

    this.breakdown.checkpoints += Math.round(base * this.combo);
    this.breakdown.precision += Math.round(precision * this.combo);
    this.breakdown.speed += Math.round(speed * this.combo);
    this.score += Math.round(total);

    const tag = e.accuracy > 0.86 ? 'PERFECT LINE' : e.accuracy > 0.55 ? 'CHECKPOINT' : 'SCRAPED IT';
    this.bus.emit('score:popup', { label: tag, value: Math.round(total), kind: 'score' });
    this._bumpCombo();
  }

  onNearMiss(e) {
    if (!this.enabled) return;
    this.nearMisses++;
    const tight = e.distance < 12;
    const amount = (tight ? SCORE.nearMissTight : SCORE.nearMiss) * this.combo;
    this._award(amount, 'nearMiss', tight ? 'THREADED IT' : 'NEAR MISS', 'near');
    this.comboTimer = Math.max(this.comboTimer, SCORE.comboDecay * 0.6);
  }

  onTrick(e) {
    if (!this.enabled) return;
    this.tricks++;
    const base = e.type === 'loop' ? SCORE.trickLoop : SCORE.trickRoll * (e.count ?? 1);
    this._award(base * this.combo, 'tricks', e.name, 'trick');
    this._bumpCombo();
  }

  onDamage(e) {
    if (!this.enabled) return;
    if (e.damage > 0) {
      this.collisions++;
      this.damageTaken += e.damage;
      this.perfect = false;
      const penalty = -e.damage * SCORE.damagePenaltyPerPoint;
      this.breakdown.penalties += Math.round(penalty);
      this.score = Math.max(0, this.score + Math.round(penalty));
      this.bus.emit('score:popup', { label: 'IMPACT', value: Math.round(penalty), kind: 'penalty' });
    }
    // Any contact at all resets the multiplier — that is the risk in flying close.
    if (this.combo > 1) {
      this.combo = 1;
      this.bus.emit('score:combo', { combo: 1, broken: true });
    }
  }

  onLanding(e) {
    if (!this.enabled) return;
    const amount = SCORE.landingBonus * lerp(0.45, 1, e.quality);
    this._award(amount, 'landing', e.quality > 0.8 ? 'TEXTBOOK LANDING' : 'LANDED', 'score');
  }

  /** Called once when a mission is won, to add the end-of-run bonuses. */
  finalise({ timeRemaining = 0, perfectEligible = true } = {}) {
    if (timeRemaining > 0) {
      this._award(timeRemaining * SCORE.timeRemainingPerSecond, 'timeBonus', 'TIME BONUS');
    }
    if (perfectEligible && this.perfect && this.collisions === 0) {
      this._award(SCORE.perfectRun, 'perfect', 'PERFECT RUN', 'trick');
    }
    return this.summary();
  }

  update(dt, telemetry) {
    if (telemetry) this.topSpeed = Math.max(this.topSpeed, telemetry.speed);
    if (this.combo > 1) {
      this.comboTimer -= dt;
      if (this.comboTimer <= 0) {
        // Bleed away rather than snapping to 1, so it feels like losing momentum.
        this.combo = Math.max(1, this.combo - dt * 0.55);
        this.bus.emit('score:combo', { combo: this.combo });
      }
    }
  }

  summary() {
    return {
      score: Math.round(this.score),
      combo: this.bestCombo,
      checkpoints: this.checkpoints,
      nearMisses: this.nearMisses,
      tricks: this.tricks,
      damageTaken: Math.round(this.damageTaken),
      collisions: this.collisions,
      topSpeed: this.topSpeed,
      perfect: this.perfect && this.collisions === 0,
      breakdown: { ...this.breakdown },
    };
  }

  dispose() {
    for (const u of this._unsubs) u?.();
  }
}
