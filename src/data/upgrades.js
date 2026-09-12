/**
 * Upgrades are multiplicative and deliberately modest (spec §54): four levels of
 * everything lifts a starter aircraft roughly a third of the way toward the next
 * class, so skill still decides the outcome and no upgrade path trivialises a
 * mission.
 */
export const UPGRADE_TREE = {
  engine: {
    name: 'ENGINE',
    desc: 'Top speed and acceleration',
    levels: 4,
    baseCost: 2600,
    costStep: 1.85,
    apply: (spec, lvl) => {
      // 4% per level, so four levels give +16%. Calibrated against the roster: at
      // 5.5% a fully upgraded Talon out-ran a stock Meridian, which made buying the
      // next aircraft pointless. Upgrades should close a gap, never erase it (§54).
      spec.maxSpeed *= 1 + 0.04 * lvl;
      spec.thrust *= 1 + 0.075 * lvl;
    },
  },
  handling: {
    name: 'HANDLING',
    desc: 'Roll and pitch authority',
    levels: 4,
    baseCost: 2200,
    costStep: 1.8,
    apply: (spec, lvl) => {
      spec.rollRate *= 1 + 0.06 * lvl;
      spec.pitchRate *= 1 + 0.05 * lvl;
      spec.turnGain *= 1 + 0.035 * lvl;
      spec.responsiveness *= 1 + 0.05 * lvl;
    },
  },
  stability: {
    name: 'STABILITY',
    desc: 'Gust resistance, lower stall speed',
    levels: 4,
    baseCost: 1900,
    costStep: 1.7,
    apply: (spec, lvl) => {
      spec.stability = Math.min(0.97, spec.stability + 0.045 * lvl);
      spec.stallSpeed *= 1 - 0.035 * lvl;
      spec.inertia *= 1 - 0.04 * lvl;
    },
  },
  turbo: {
    name: 'TURBO',
    desc: 'Boost power, capacity and recharge',
    levels: 4,
    baseCost: 2800,
    costStep: 1.9,
    apply: (spec, lvl) => {
      spec.turboMult *= 1 + 0.035 * lvl;
      spec.turboSpeedGain = (spec.turboSpeedGain ?? 1.2) * (1 + 0.012 * lvl);
      spec.turboCapacity *= 1 + 0.09 * lvl;
      spec.turboRegen *= 1 + 0.1 * lvl;
      spec.turboDelay *= 1 - 0.07 * lvl;
    },
  },
  armor: {
    name: 'HULL',
    desc: 'Impact resistance',
    levels: 4,
    baseCost: 1700,
    costStep: 1.65,
    apply: (spec, lvl) => {
      spec.armor *= 1 + 0.1 * lvl;
      spec.mass *= 1 + 0.018 * lvl; // extra plating is not free
    },
  },
};

export const UPGRADE_ORDER = ['engine', 'handling', 'stability', 'turbo', 'armor'];

export function upgradeCost(key, currentLevel) {
  const t = UPGRADE_TREE[key];
  if (!t || currentLevel >= t.levels) return null;
  return Math.round(t.baseCost * Math.pow(t.costStep, currentLevel));
}

/** Returns a fresh spec object; the catalogue entry is never mutated. */
export function applyUpgrades(baseSpec, levels = {}) {
  const spec = structuredClone(baseSpec);
  for (const key of UPGRADE_ORDER) {
    const lvl = Math.max(0, Math.min(UPGRADE_TREE[key].levels, levels[key] | 0));
    if (lvl > 0) UPGRADE_TREE[key].apply(spec, lvl);
  }
  spec.upgradeLevels = { ...levels };
  return spec;
}

export const PAINTS = {
  factory:  { name: 'FACTORY',  body: 0xdde6f0, trim: 0x2b3a4c, cost: 0 },
  ember:    { name: 'EMBER',    body: 0xd9432b, trim: 0x2b1a14, cost: 0 },
  ice:      { name: 'ICE',      body: 0x9fd8ee, trim: 0x1d3a4a, cost: 0 },
  midnight: { name: 'MIDNIGHT', body: 0x1a2436, trim: 0x38e1ff, cost: 2500 },
  viper:    { name: 'VIPER',    body: 0x2f6b32, trim: 0xc8e64a, cost: 2500 },
  sunburst: { name: 'SUNBURST', body: 0xf2a316, trim: 0x54290a, cost: 3500 },
  carbon:   { name: 'CARBON',   body: 0x26282c, trim: 0x8a8f96, cost: 4500 },
  aurora:   { name: 'AURORA',   body: 0x5a3fb0, trim: 0x46e08a, cost: 6000 },
  gold:     { name: 'CHAMPION', body: 0xc9a227, trim: 0x3a2c08, cost: 0, requiresTokens: 12 },
};

export const PAINT_ORDER = Object.keys(PAINTS);
