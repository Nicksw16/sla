/**
 * Aircraft catalogue.
 *
 * Every field here is consumed by FlightModel or AircraftFactory — there are no
 * cosmetic-only stats (spec §9, §56). Speeds are m/s, rates are rad/s.
 *
 *  thrust        full-throttle acceleration, m/s^2
 *  maxSpeed      level-flight terminal speed at full throttle
 *  stallSpeed    below this, control authority collapses and the nose drops
 *  turnGain      multiplier on the coordinated bank-to-turn rate
 *  stability     auto-levelling and gust resistance, 0..1
 *  responsiveness how fast control surfaces reach the commanded deflection
 *  inertia       how much old velocity survives a heading change (drift feel)
 *  mass          perceived weight: camera lag, sink recovery, impact severity
 *  turboSpeedGain how far past maxSpeed the drag wall moves while boosting
 */
export const AIRCRAFT = {
  skylark: {
    id: 'skylark',
    name: 'SKYLARK LS-2',
    role: 'LIGHT SPORT · TRAINER',
    blurb:
      'Forgiving, slow and honest. It tells you what it is doing before it does it, which is exactly what you want while you learn the city.',
    price: 0,
    requiresStars: 0,
    thrust: 23,
    maxSpeed: 94,
    stallSpeed: 25,
    pitchRate: 1.05,
    rollRate: 2.3,
    yawRate: 0.5,
    turnGain: 1.15,
    stability: 0.88,
    responsiveness: 7.5,
    inertia: 0.22,
    brakeStrength: 20,
    turboMult: 1.5,
    turboSpeedGain: 1.16,
    turboCapacity: 100,
    turboDrain: 26,
    turboRegen: 15,
    turboDelay: 1.1,
    armor: 1.15,
    mass: 0.55,
    liftBonus: 0.12,
    rotateSpeed: 31,
    landingSpeed: 42,
    model: {
      wingspan: 9.4, length: 6.8, wing: 'straight', tail: 'conventional',
      engines: 'prop', propRadius: 0.9, colorAccent: 0xff9d3c, canopy: 'bubble',
      gear: 'fixed',
    },
  },

  vector: {
    id: 'vector',
    name: 'VECTOR S7',
    role: 'AEROBATIC SPORT',
    blurb:
      'Built to roll. Snaps into a bank faster than anything else in the hangar, and will happily snap back out again if you are careless with the stick.',
    price: 18000,
    requiresStars: 6,
    thrust: 35,
    maxSpeed: 129,
    stallSpeed: 32,
    pitchRate: 1.38,
    rollRate: 3.7,
    yawRate: 0.62,
    turnGain: 1.32,
    stability: 0.6,
    responsiveness: 11,
    inertia: 0.3,
    brakeStrength: 24,
    turboMult: 1.68,
    turboSpeedGain: 1.2,
    turboCapacity: 105,
    turboDrain: 27,
    turboRegen: 16,
    turboDelay: 1,
    armor: 1,
    mass: 0.7,
    liftBonus: 0.06,
    rotateSpeed: 40,
    landingSpeed: 52,
    model: {
      wingspan: 8.2, length: 7.4, wing: 'tapered', tail: 'conventional',
      engines: 'prop', propRadius: 1.05, colorAccent: 0x36e1ff, canopy: 'bubble',
      gear: 'fixed',
    },
  },

  talon: {
    id: 'talon',
    name: 'TALON AX-9',
    role: 'JET TRAINER',
    blurb:
      'The first jet you will fly. Real speed arrives with real consequences: it carries energy through corners and does not slow down because you asked politely.',
    price: 52000,
    requiresStars: 18,
    thrust: 45,
    maxSpeed: 169,
    stallSpeed: 43,
    pitchRate: 1.22,
    rollRate: 3.2,
    yawRate: 0.52,
    turnGain: 1.22,
    stability: 0.56,
    responsiveness: 10,
    inertia: 0.4,
    brakeStrength: 26,
    turboMult: 1.86,
    turboSpeedGain: 1.24,
    turboCapacity: 115,
    turboDrain: 28,
    turboRegen: 14,
    turboDelay: 1.2,
    armor: 0.95,
    mass: 0.85,
    liftBonus: 0.02,
    rotateSpeed: 52,
    landingSpeed: 64,
    model: {
      wingspan: 9.6, length: 11.2, wing: 'swept', tail: 'twin-boom',
      engines: 'jet', jetCount: 1, colorAccent: 0xffd23c, canopy: 'fighter',
      gear: 'retract',
    },
  },

  meridian: {
    id: 'meridian',
    name: 'MERIDIAN EX',
    role: 'EXECUTIVE · HIGH SPEED CRUISE',
    blurb:
      'Heavy, smooth and very fast in a straight line. Wide turns, enormous momentum. Learn to start your corner early and it will out-run anything on a long leg.',
    price: 96000,
    requiresStars: 32,
    thrust: 41,
    maxSpeed: 198,
    stallSpeed: 53,
    pitchRate: 0.86,
    rollRate: 1.95,
    yawRate: 0.4,
    turnGain: 0.96,
    stability: 0.92,
    responsiveness: 6,
    inertia: 0.62,
    brakeStrength: 19,
    turboMult: 1.6,
    turboSpeedGain: 1.18,
    turboCapacity: 130,
    turboDrain: 22,
    turboRegen: 13,
    turboDelay: 1.4,
    armor: 1.3,
    mass: 1.25,
    liftBonus: 0.04,
    rotateSpeed: 62,
    landingSpeed: 74,
    model: {
      wingspan: 15.8, length: 17.5, wing: 'swept', tail: 't-tail',
      engines: 'jet', jetCount: 2, colorAccent: 0xe8eef6, canopy: 'airliner',
      gear: 'retract',
    },
  },

  wraith: {
    id: 'wraith',
    name: 'WRAITH X-1',
    role: 'EXPERIMENTAL DELTA',
    blurb:
      'A test article with a city map taped to the panel. Fastest and most agile thing in the sky, no stability to speak of, and it does not like being hit.',
    price: 165000,
    requiresStars: 48,
    thrust: 59,
    maxSpeed: 240,
    stallSpeed: 58,
    pitchRate: 1.52,
    rollRate: 4.3,
    yawRate: 0.6,
    turnGain: 1.42,
    stability: 0.34,
    responsiveness: 13,
    inertia: 0.48,
    brakeStrength: 30,
    turboMult: 2.1,
    turboSpeedGain: 1.3,
    turboCapacity: 120,
    turboDrain: 32,
    turboRegen: 12,
    turboDelay: 1.3,
    armor: 0.72,
    mass: 0.95,
    liftBonus: 0,
    rotateSpeed: 66,
    landingSpeed: 80,
    model: {
      wingspan: 11.4, length: 14.2, wing: 'delta', tail: 'canard',
      engines: 'jet', jetCount: 2, colorAccent: 0xb48cff, canopy: 'fighter',
      gear: 'retract',
    },
  },
};

export const AIRCRAFT_ORDER = ['skylark', 'vector', 'talon', 'meridian', 'wraith'];

/** Rival aircraft are drawn from the same catalogue — the AI gets no secret stats. */
export function getAircraft(id) {
  return AIRCRAFT[id] ?? AIRCRAFT.skylark;
}

/** 0..1 bars for the hangar, scaled against the whole roster. */
export function statBars(spec) {
  const norm = (v, a, b) => Math.max(0, Math.min(1, (v - a) / (b - a)));
  return [
    { key: 'TOP SPEED', value: norm(spec.maxSpeed, 80, 240), display: `${Math.round(spec.maxSpeed * 3.6)} km/h` },
    { key: 'ACCELERATION', value: norm(spec.thrust, 20, 62), display: `${spec.thrust.toFixed(0)} m/s²` },
    { key: 'AGILITY', value: norm(spec.rollRate * spec.turnGain, 2.2, 6.2), display: `${(spec.rollRate).toFixed(1)} rad/s` },
    { key: 'STABILITY', value: norm(spec.stability, 0.3, 0.95), display: `${Math.round(spec.stability * 100)}%` },
    { key: 'TURBO', value: norm(spec.turboMult, 1.4, 2.15), display: `×${spec.turboMult.toFixed(2)}` },
    { key: 'HULL', value: norm(spec.armor, 0.7, 1.35), display: `${Math.round(spec.armor * 100)}%` },
    { key: 'STALL SPEED', value: 1 - norm(spec.stallSpeed, 24, 60), display: `${Math.round(spec.stallSpeed * 3.6)} km/h` },
  ];
}
