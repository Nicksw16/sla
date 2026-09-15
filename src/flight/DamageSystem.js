import { clamp, clamp01 } from '../core/MathUtils.js';

/**
 * Hull integrity (spec §44-47).
 *
 * Impact severity arrives from FlightModel as 0..1. The bands below turn it into
 * the spec's damage tiers. A light scrape must never be fatal - the punishment for
 * clipping a roof is lost speed and a broken combo, which teaches the lesson
 * without ending the run (§45, §145).
 *
 * The worst band used to take the whole hull, so one full-speed wall ended the run
 * on contact. It now leaves you alive with a little over a third of it: an airframe
 * survives one catastrophic hit and dies on the second, which is both a longer life
 * and the difference between flying away from a hole you just punched in a tower
 * and never seeing it. Armour still divides on top of this.
 */
const BANDS = [
  { max: 0.14, damage: 0,    label: 'scrape',   shake: 0.25 },
  { max: 0.32, damage: 7,    label: 'light',    shake: 0.5 },
  { max: 0.58, damage: 16,   label: 'moderate', shake: 0.8 },
  { max: 0.82, damage: 32,   label: 'heavy',    shake: 1 },
  { max: Infinity, damage: 58, label: 'critical', shake: 1.4 },
];

export class DamageSystem {
  constructor({ spec, bus }) {
    this.bus = bus;
    this.spec = spec;
    this.max = 100;
    this.hp = 100;
    this.destroyed = false;
    this.invulnerable = false;
    this.impactCount = 0;
    this.worstImpact = 0;
    this.totalDamage = 0;
    this._unsub = bus.on('flight:impact', (e) => this.onImpact(e));
  }

  setSpec(spec) {
    this.spec = spec;
  }

  reset() {
    this.hp = this.max;
    this.destroyed = false;
    this.impactCount = 0;
    this.worstImpact = 0;
    this.totalDamage = 0;
  }

  get fraction() {
    return clamp01(this.hp / this.max);
  }

  onImpact(e) {
    if (this.destroyed) return;

    const band = BANDS.find((b) => e.severity <= b.max);
    // Armour scales the damage taken, not the severity of the event, so the
    // camera and audio still react to how hard the hit actually was.
    const raw = band.damage * (e.kind === 'obstacle' ? 1 : 0.8);
    const damage = raw / Math.max(0.4, this.spec.armor ?? 1);

    this.impactCount++;
    this.worstImpact = Math.max(this.worstImpact, e.severity);

    const info = {
      ...e,
      band: band.label,
      damage,
      shake: band.shake,
      hpBefore: this.hp,
    };

    if (damage > 0 && !this.invulnerable) {
      this.hp = clamp(this.hp - damage, 0, this.max);
      this.totalDamage += damage;
    }
    info.hpAfter = this.hp;

    this.bus.emit('damage:hit', info);

    if (this.hp <= 0 && !this.invulnerable) {
      this.destroyed = true;
      this.bus.emit('damage:destroyed', info);
    }
  }

  repair(amount = this.max) {
    this.hp = clamp(this.hp + amount, 0, this.max);
    if (this.hp > 0) this.destroyed = false;
  }

  dispose() {
    this._unsub?.();
  }
}
