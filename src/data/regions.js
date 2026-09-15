/**
 * Skyline City is a 3x3 grid of 3000 m districts, ocean to the south, mountains
 * to the north. Each district owns a silhouette and a palette so it is
 * identifiable from altitude without reading the HUD (spec §23, §26).
 */
export const TILE = 3000;
export const WORLD_HALF = 4500;        // city limits; terrain continues past this
export const COAST_Z = 4250;           // south of this line is water
export const SEA_LEVEL = 0;
export const WORLD_FAR = 14000;        // outer ring of ocean / haze

export const REGIONS = {
  central: {
    id: 'central', name: 'CENTRAL DISTRICT', short: 'CENTRAL',
    cx: 0, cz: 0,
    unlock: { stars: 0 },
    tint: 0x6b7a8c,
    landmarkNote: 'Skyline Tower',
    desc: 'Dense high-rise core wrapped around Skyline Tower. Tight canyons, constant air traffic, nowhere to go but up.',
    buildings: {
      density: 0.92, minH: 60, maxH: 240, spireChance: 0.18,
      footprint: [26, 54], palette: [0x545f6e, 0x47535f, 0x606b78, 0x39424e], glass: 0.55,
    },
  },
  financial: {
    id: 'financial', name: 'FINANCIAL CENTER', short: 'FINANCIAL',
    cx: TILE, cz: 0,
    unlock: { stars: 12 },
    tint: 0x7d8698,
    landmarkNote: 'The Obelisk',
    desc: 'The most vertical square kilometre in the city. Glass towers, razor-thin gaps, and the tallest roofline you can legally fly between.',
    buildings: {
      density: 0.86, minH: 120, maxH: 360, spireChance: 0.3,
      footprint: [30, 62], palette: [0x6d7a8a, 0x7e8b9b, 0x5b6674, 0x8996a6], glass: 0.8,
    },
  },
  residential: {
    id: 'residential', name: 'RESIDENTIAL DISTRICT', short: 'RESIDENTIAL',
    cx: -TILE, cz: 0,
    unlock: { stars: 4 },
    tint: 0x8d8474,
    landmarkNote: 'Ridgeway Stadium',
    desc: 'Low blocks, wide avenues and a stadium you can circle at rooftop height. The safest place in the city to learn to be precise.',
    buildings: {
      density: 0.78, minH: 14, maxH: 58, spireChance: 0.02,
      footprint: [20, 44], palette: [0x9b8f7c, 0x8a7d69, 0xa89b86, 0x776b5a], glass: 0.15,
    },
  },
  industrial: {
    id: 'industrial', name: 'INDUSTRIAL DISTRICT', short: 'INDUSTRIAL',
    cx: TILE, cz: -TILE,
    unlock: { stars: 20 },
    tint: 0x7a6f66,
    landmarkNote: 'Stack Row',
    desc: 'Sheds, silos, smoke stacks and cooling towers. The plumes are not decoration: they mark the low route, and they hide what is behind them.',
    buildings: {
      density: 0.66, minH: 16, maxH: 78, spireChance: 0.24,
      footprint: [38, 92], palette: [0x7d746b, 0x8a7f70, 0x6a625b, 0x94897a], glass: 0.08,
      industrial: true,
    },
  },
  harbor: {
    id: 'harbor', name: 'HARBOR', short: 'HARBOR',
    cx: 0, cz: TILE,
    unlock: { stars: 8 },
    tint: 0x5e7280,
    landmarkNote: 'Northgate Bridge',
    desc: 'Cranes, container stacks and the suspension bridge. The gap under the bridge deck is a legal shortcut, if your nerves hold.',
    buildings: {
      density: 0.5, minH: 12, maxH: 54, spireChance: 0.06,
      footprint: [34, 86], palette: [0x66707a, 0x58636d, 0x717b85, 0x4d565f], glass: 0.12,
      docks: true,
    },
  },
  beach: {
    id: 'beach', name: 'BEACH FRONT', short: 'BEACH',
    cx: -TILE, cz: TILE,
    unlock: { stars: 16 },
    tint: 0xc9b48a,
    landmarkNote: 'Skyline Wheel',
    desc: 'Boardwalk hotels, the big wheel and open water. Almost nothing to hit, which is why every speed record is set out here.',
    buildings: {
      density: 0.44, minH: 18, maxH: 92, spireChance: 0.05,
      footprint: [24, 52], palette: [0xd8cbb0, 0xc6b896, 0xe4dac2, 0xb0a284], glass: 0.4,
    },
  },
  countryside: {
    id: 'countryside', name: 'COUNTRYSIDE', short: 'COUNTRY',
    cx: 0, cz: -TILE,
    unlock: { stars: 24 },
    tint: 0x6d8656,
    landmarkNote: 'Valley Dam',
    desc: 'Fields, treelines and a reservoir. Wide open above, but the terrain rises the whole way north and it will meet you if you are lazy with altitude.',
    buildings: {
      density: 0.14, minH: 8, maxH: 26, spireChance: 0.01,
      footprint: [22, 56], palette: [0x9c9078, 0x8b8069, 0xada08a, 0x7b715e], glass: 0.05,
      rural: true,
    },
  },
  mountains: {
    id: 'mountains', name: 'NORTH RIDGE', short: 'MOUNTAINS',
    cx: -TILE, cz: -TILE,
    unlock: { stars: 34 },
    tint: 0x6f7566,
    landmarkNote: 'Ridge Pass',
    desc: 'Real terrain. Ridges up to 900 m, a pass that only fits one line through it, and no forgiveness whatsoever at low level.',
    buildings: {
      density: 0.05, minH: 8, maxH: 20, spireChance: 0,
      footprint: [18, 40], palette: [0x8d8878, 0x7c7768, 0x9c9788, 0x6d6859], glass: 0.05,
      mountainous: true,
    },
  },
  airport: {
    id: 'airport', name: 'SKYLINE INTERNATIONAL', short: 'AIRPORT',
    cx: TILE, cz: TILE,
    unlock: { stars: 10 },
    tint: 0x6b6f75,
    landmarkNote: 'Runway 09/27',
    desc: 'Two kilometres of concrete, a control tower and the only place in the city where stopping is part of the job.',
    buildings: {
      density: 0.18, minH: 10, maxH: 40, spireChance: 0.03,
      footprint: [44, 110], palette: [0x777c83, 0x6a6f76, 0x868c94, 0x5d6268], glass: 0.3,
      airport: true,
    },
  },
};

export const REGION_ORDER = [
  'mountains', 'countryside', 'industrial',
  'residential', 'central', 'financial',
  'beach', 'harbor', 'airport',
];

/** Which district a world position falls in; used for audio beds and the HUD. */
export function regionAt(x, z) {
  const gx = Math.round(x / TILE);
  const gz = Math.round(z / TILE);
  for (const id of REGION_ORDER) {
    const r = REGIONS[id];
    if (Math.round(r.cx / TILE) === gx && Math.round(r.cz / TILE) === gz) return r;
  }
  return z > COAST_Z ? { id: 'sea', name: 'OPEN SEA', short: 'SEA', tint: 0x2f4a5e } : null;
}

/** Named orientation landmarks (spec §25). Heights are metres above ground. */
export const LANDMARKS = [
  { id: 'skylineTower', name: 'SKYLINE TOWER', x: 120, z: -60, height: 540, region: 'central', type: 'spire' },
  { id: 'obelisk', name: 'THE OBELISK', x: 3180, z: 180, height: 392, region: 'financial', type: 'obelisk' },
  { id: 'stadium', name: 'RIDGEWAY STADIUM', x: -3260, z: -520, height: 62, region: 'residential', type: 'stadium' },
  { id: 'bridge', name: 'NORTHGATE BRIDGE', x: 700, z: 3560, height: 186, region: 'harbor', type: 'bridge' },
  { id: 'wheel', name: 'SKYLINE WHEEL', x: -3020, z: 3720, height: 124, region: 'beach', type: 'wheel' },
  { id: 'cranes', name: 'CONTAINER QUAY', x: -340, z: 3980, height: 78, region: 'harbor', type: 'cranes' },
  { id: 'dam', name: 'VALLEY DAM', x: -240, z: -4020, height: 96, region: 'countryside', type: 'dam' },
  { id: 'tower', name: 'CONTROL TOWER', x: 2560, z: 2740, height: 74, region: 'airport', type: 'atc' },
  { id: 'marina', name: 'SOUTH MARINA', x: -1620, z: 4080, height: 22, region: 'beach', type: 'marina' },
  { id: 'twins', name: 'GEMINI TOWERS', x: 230, z: -500, height: 452, region: 'central', type: 'twins' },
  { id: 'park', name: 'CENTRAL PARK', x: -620, z: 640, height: 0, region: 'central', type: 'park' },
  { id: 'ridge', name: 'RIDGE PASS', x: -3100, z: -3400, height: 780, region: 'mountains', type: 'peak' },
];

/** Runway used by every takeoff and landing mission. */
export const RUNWAY = {
  x: 2900, z: 3150,
  heading: 0.0,          // radians; aligned +X ("09/27")
  length: 2300, width: 60,
  elevation: 8,
};
