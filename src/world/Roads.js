import { clamp01, lerp, smoothstep } from '../core/MathUtils.js';
import { terrainHeight } from './Terrain.js';
import { LANDMARKS } from '../data/regions.js';

/**
 * The road network, as a pure function of position.
 *
 * Nothing here is stored. The street grid is already a rule rather than a table - the
 * terrain shader paints it straight out of the world coordinate - so the lanes the
 * traffic drives on are derived from that same rule instead of being a second copy of
 * it that can drift out of step. Same reason `terrainHeight` serves the visible mesh,
 * the collision floor and the mission authoring: one function, one answer (spec §92).
 *
 * Two things live here:
 *
 * 1. The Northgate Bridge road profile, which used to be buried inside the code that
 *    builds the bridge's geometry. The traffic needs the same numbers - a car on the
 *    bridge has to be on the deck, not at the height of the water under it - and a
 *    second copy of a road surface is exactly the kind of duplication that puts cars
 *    through the tarmac. `buildBridge` now reads its shape from here too.
 *
 * 2. The lane geometry, which is read off the same constants the road markings are
 *    painted from, so a car sits between the painted lines rather than on them.
 */

// Real downtown blocks are around 100 m across (CityGenerator owns these for the
// buildings; they are re-exported through here so road code has one import).
export const BLOCK = 112;
export const ROAD = 36;
export const PERIOD = BLOCK + ROAD;

/** Every fourth grid line is an avenue: wider, two lanes each way, a centre line. */
export const AVENUE_EVERY = 4;
export const AVENUE_SPACING = PERIOD * AVENUE_EVERY;
export const AVENUE_HALF = 30;

/**
 * Lane centres, measured from the middle of the road.
 *
 * A side street is 36 m of asphalt with a dashed divider down the middle, so one lane
 * each way sitting clear of the dashes and clear of the kerb. An avenue is 60 m with a
 * solid centre line, so two each way. These are the numbers the shader paints against,
 * not numbers that happen to look right: the dashes are drawn at the grid line and the
 * kerb at ROAD * 0.5, and a car wants to be between them.
 */
export const LANE_OFFSETS = {
  street: [9],
  avenue: [7.5, 22],
};

/** Is this grid line an avenue? */
export function isAvenue(lineIndex) {
  return lineIndex % AVENUE_EVERY === 0;
}

/** The world coordinate of a grid line, and the index of the line nearest a point. */
export const lineAt = (index) => index * PERIOD;
export const lineIndexNear = (v) => Math.round(v / PERIOD);

/** Half the drivable width of the road on a given grid line. */
export function roadHalfWidth(lineIndex) {
  return isAvenue(lineIndex) ? AVENUE_HALF : ROAD * 0.5;
}

/**
 * Northgate Bridge.
 *
 * The deck is level and sits a chosen height above the water rather than a fraction of
 * anything, because the clearance under it is level design: the mission that flies the
 * channel passes beneath it and a beacon hides under it. The approaches climb to meet
 * it - eased out of the deck, graded at about one in ten, eased onto the ground - and
 * are clamped to the terrain at the bottom so the last stretch follows the shore
 * instead of burying itself in it.
 */
export const BRIDGE = {
  DECK_Y: 78,        // deck surface above the water. This is the flyable gap.
  SPAN_HALF: 420,    // half the main span; the dredged channel is 920 m wide here
  DECK_W: 34,
  PIER_FRAC: 0.46,   // where the pylons stand, as a fraction of the half-span
  GRADE_RUN: 700,    // how far each approach takes to come down from the deck
  LEVEL_RUN: 160,    // and how much of it carries on at ground level afterwards
  STATIONS: 30,      // hanger spacing across the span
  RAMP_SEGS: 22,     // slabs per approach; each one leans a little less than the last
};

const BRIDGE_L = LANDMARKS.find((l) => l.id === 'bridge');

/** Where the bridge road runs, from one end of the approaches to the other. */
export const BRIDGE_SPAN = {
  x: BRIDGE_L.x,
  z: BRIDGE_L.z,
  half: BRIDGE.SPAN_HALF + BRIDGE.GRADE_RUN + BRIDGE.LEVEL_RUN,
};

/**
 * The height of the bridge road at a distance `dx` from its centre, or null past the
 * ends of the approaches.
 *
 * This is the single definition of the bridge's road profile. The geometry is built
 * from it and the traffic drives on it, so a car cannot be through the deck or hovering
 * over it - there is only one surface and both of them read it.
 */
export function bridgeRoadHeight(dx) {
  const a = Math.abs(dx);
  const { SPAN_HALF, DECK_Y, GRADE_RUN, LEVEL_RUN } = BRIDGE;
  const run = GRADE_RUN + LEVEL_RUN;
  if (a <= SPAN_HALF) return DECK_Y;
  if (a > SPAN_HALF + run) return null;

  const side = Math.sign(dx) || 1;
  const x0 = BRIDGE_SPAN.x + side * SPAN_HALF;
  const foot = terrainHeight(x0 + side * GRADE_RUN, BRIDGE_SPAN.z);
  const t = (a - SPAN_HALF) / run;
  const x = x0 + side * run * t;
  const graded = lerp(DECK_Y, foot + 2.4, smoothstep(0, GRADE_RUN / run, t));
  return Math.max(graded, terrainHeight(x, BRIDGE_SPAN.z) + 2.4);
}

/**
 * How much of the bridge corridor a point is inside, 0 to 1.
 *
 * Fades out across the width so a car joining the bridge is eased onto the deck rather
 * than stepping up onto it, and past the ends of the approaches so the road settles
 * back onto the street it came from.
 */
export function bridgeInfluence(x, z) {
  const dx = x - BRIDGE_SPAN.x;
  if (Math.abs(dx) > BRIDGE_SPAN.half) return 0;
  const across = Math.abs(z - BRIDGE_SPAN.z);
  // The edge of the deck is an edge. An earlier version faded out over fourteen metres
  // past it, which sounds gentler and is much worse: anything sampling the surface in
  // that band got a height that was neither the deck nor the ground, so a car half a
  // lane too far over hung in the air at forty-eight metres, halfway down to the water.
  // Two metres of blend is enough to keep the function continuous and too little to
  // strand anything in it.
  const half = BRIDGE.DECK_W * 0.5;
  return clamp01(1 - smoothstep(half - 2, half, across));
}

/**
 * Where the bridge deck is no longer there.
 *
 * The road network is otherwise a pure function of position, which is what keeps the
 * traffic and the structure from disagreeing - but a bridge that has had a hole blown
 * in it is a fact about the world, not about the position, and the traffic has to know.
 * Without it cars drive across the gap on air, which is a worse sight than the gap.
 *
 * Kept as ranges along the bridge rather than per segment so the check stays a couple
 * of comparisons: this is read for every vehicle, every frame.
 */
const deckGaps = [];

export function openDeckGap(fromX, toX) {
  deckGaps.push([Math.min(fromX, toX), Math.max(fromX, toX)]);
}

export function clearDeckGaps() {
  deckGaps.length = 0;
}

export function deckGone(x) {
  for (let i = 0; i < deckGaps.length; i++) {
    if (x >= deckGaps[i][0] && x <= deckGaps[i][1]) return true;
  }
  return false;
}

export const deckGapCount = () => deckGaps.length;

/**
 * The drivable surface at a point: the bridge deck where there is one, the ground
 * everywhere else.
 *
 * Traffic used to take its height from `terrainHeight` alone, which is why a car
 * crossing the harbour channel drove along the dredged bed twenty-four metres under the
 * water, and a car on the approach embankment drove buried inside it.
 */
export function roadSurfaceAt(x, z) {
  const ground = terrainHeight(x, z);
  const w = bridgeInfluence(x, z);
  if (w <= 0) return { y: ground, onBridge: 0 };
  // A stretch of deck that has been knocked out is not a road any more. The ground
  // here is the channel bed, well under the water, so nothing will try to drive on it.
  if (deckGone(x)) return { y: ground, onBridge: 0, broken: true };
  const deck = bridgeRoadHeight(x - BRIDGE_SPAN.x);
  if (deck === null) return { y: ground, onBridge: 0 };
  return { y: Math.max(ground, lerp(ground, deck, w)), onBridge: w };
}

/**
 * Where the lane centreline sits across the road.
 *
 * Normally that is the grid line itself. Over the bridge it is the deck, which is eight
 * metres off the grid line here - within the width of the road, but enough that a lane
 * measured from the grid line would put one direction of traffic up against the
 * parapet. The shift is spread across the approaches, which is what a real road does
 * when it lines itself up with a bridge.
 */
export function laneCentre(axis, lineIndex, x, z) {
  const base = lineAt(lineIndex);
  if (axis !== 0) return base;
  const w = Math.abs(x - BRIDGE_SPAN.x) > BRIDGE_SPAN.half ? 0
    : clamp01(1 - smoothstep(BRIDGE_SPAN.half * 0.55, BRIDGE_SPAN.half, Math.abs(x - BRIDGE_SPAN.x)));
  if (w <= 0 || Math.abs(base - BRIDGE_SPAN.z) > PERIOD * 0.5) return base;
  return lerp(base, BRIDGE_SPAN.z, w);
}

/** The grid line the bridge road runs along. */
export const BRIDGE_LINE = lineIndexNear(BRIDGE_SPAN.z);
