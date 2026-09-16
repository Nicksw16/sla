import { clamp } from '../core/MathUtils.js';
import { isWater } from './Terrain.js';
import {
  BRIDGE_LINE, BRIDGE_SPAN, LANE_OFFSETS, PERIOD,
  bridgeInfluence, isAvenue, laneCentre, lineAt, roadSurfaceAt,
} from './Roads.js';

/**
 * How the traffic drives (spec §27-28).
 *
 * The rules live here, apart from the meshes, because they are the part worth testing:
 * a car queueing behind a slower one, stopping at a red and pulling away again, picking
 * a turn at a junction and yielding before it crosses, is all arithmetic on numbers
 * that need no GPU to check.
 *
 * A vehicle's position is (axis, line, side, lane, s): which way it runs, which grid
 * line's road it is on, which side of the centre line it drives on, which of that
 * road's lanes, and how far along. Everything else - where it is in the world, how high
 * off the ground, which way it is pointing - is derived from those, in the same spirit
 * as the rest of the world being a function of position rather than a stored table.
 */

/** Lights only where a road worth signalling crosses another (spec: minor crossroads
 * are unsignalled, and a city where every junction stops you reads as gridlock). */
const CYCLE = 26;               // seconds for a full two-phase cycle
const AMBER = 0.055;            // of the cycle, each way
const STOP_LINE = 20;           // metres back from the junction centre
const JUNCTION_CLEAR = 26;      // how far past the centre counts as "in the junction"

/** Intelligent-driver following. Compact, stable, and it queues the way traffic does. */
const MIN_GAP = 2.4;            // bumper to bumper at a standstill
const HEADWAY = 1.35;           // seconds of gap a driver wants at speed
const YIELD_WINDOW = 3.2;       // seconds of oncoming traffic that stops a crossing turn

/** Behaviour costs, so it is only paid where it can be seen. */
export const BEHAVIOUR_RADIUS = 520;

/** Deterministic per-junction phase, so every car arriving agrees on the colour. */
function junctionPhase(i, j) {
  const h = Math.sin(i * 127.1 + j * 311.7) * 43758.5453;
  return h - Math.floor(h);
}

/**
 * Does this junction have lights, and if so what colour for a given axis?
 *
 * Signals go where an avenue is involved. That is how a real city does it, and it also
 * keeps the side streets flowing: signalise all 148-metre crossroads and from the air
 * the city stops being traffic and becomes a car park with a pulse.
 */
export function hasSignals(i, j) {
  return isAvenue(i) || isAvenue(j);
}

/** 'green' | 'amber' | 'red' for traffic running along `axis` through junction (i, j). */
export function signalFor(i, j, axis, elapsed) {
  if (!hasSignals(i, j)) return 'green';
  const t = (elapsed / CYCLE + junctionPhase(i, j)) % 1;
  const mine = axis === 0 ? t : (t + 0.5) % 1;
  if (mine < 0.5 - AMBER) return 'green';
  if (mine < 0.5) return 'amber';
  return 'red';
}

/** Is this stretch of road the bridge? The bridge runs along x, on one grid line. */
export function onBridgeRoad(axis, line, s) {
  return axis === 0 && line === BRIDGE_LINE
    && Math.abs(s - BRIDGE_SPAN.x) <= BRIDGE_SPAN.half;
}

/**
 * The lane offsets available on a stretch of road.
 *
 * Normally that is a property of the grid line - every fourth one is an avenue, with
 * two lanes each way. On the bridge it is not, because the deck is thirty-four metres
 * wide and an avenue is sixty: the line the bridge happens to sit on is an avenue, so
 * without this the outer lane put a fifth of the traffic twenty-two metres off the deck
 * centre, five metres past the parapet, hanging in the air over the channel. A bridge
 * narrowing the road it carries is also simply what bridges do.
 */
export function laneOffsetsFor(line, s = null, axis = 0) {
  if (s !== null && onBridgeRoad(axis, line, s)) return LANE_OFFSETS.street;
  return isAvenue(line) ? LANE_OFFSETS.avenue : LANE_OFFSETS.street;
}

/** The lanes this particular vehicle has, where it is. */
export const lanesFor = (v) => laneOffsetsFor(v.line, v.s, v.axis);

/**
 * World position of a vehicle.
 *
 * `side` is the direction of travel along the axis, and also which side of the centre
 * line the vehicle sits on, so opposing traffic passes rather than meeting head on.
 */
export function vehicleXZ(v, out = {}) {
  const lanes = lanesFor(v);
  // Lanes drop on the bridge, so a car in the outer one merges in rather than running
  // out of road.
  const off = lanes[Math.min(v.lane, lanes.length - 1)];
  if (v.axis === 0) {
    out.x = v.s;
    out.z = laneCentre(0, v.line, v.s, 0) + v.side * off;
  } else {
    out.z = v.s;
    out.x = laneCentre(1, v.line, 0, v.s) - v.side * off;
  }
  return out;
}

/** Heading in radians, matching the game's convention of 0 facing -z. */
export function vehicleHeading(v) {
  if (v.axis === 0) return v.side > 0 ? Math.PI / 2 : -Math.PI / 2;
  return v.side > 0 ? Math.PI : 0;
}

/** The next junction ahead of a vehicle, as a grid index and the distance to it. */
export function nextJunction(v) {
  const along = v.s / PERIOD;
  const index = v.side > 0 ? Math.ceil(along) : Math.floor(along);
  const distance = (lineAt(index) - v.s) * v.side;
  return { index, distance };
}

/**
 * Can a vehicle keep going this way, or does the road run out?
 *
 * The street grid is drawn over the whole world, water included, so without this a car
 * drives serenely off the quay and along the harbour bed. The one road that does cross
 * water is the bridge, and it is allowed to.
 */
export function roadExists(axis, line, s) {
  const probe = { axis, line, side: 1, lane: 0, s };
  const p = vehicleXZ(probe);
  // A span that has been knocked into the channel is not a road any more. Asking the
  // road surface rather than the bridge's outline is what makes that true here:
  // the outline is a fact about where the bridge was built, the surface is a fact
  // about what is still standing.
  if (onBridgeRoad(axis, line, s)) return roadSurfaceAt(p.x, p.z).onBridge > 0;
  return !isWater(p.x, p.z);
}

/** Acceleration from the intelligent-driver model, given the gap to what is ahead. */
export function follow(v, gap, leadSpeed) {
  const free = 1 - (v.speed / Math.max(v.cruise, 0.1)) ** 4;
  if (gap === Infinity) return v.accel * free;
  const closing = v.speed - leadSpeed;
  const wanted = MIN_GAP + Math.max(0, v.speed * HEADWAY
    + (v.speed * closing) / (2 * Math.sqrt(v.accel * v.brake)));
  const interaction = (wanted / Math.max(gap, 0.3)) ** 2;
  return clamp(v.accel * (free - interaction), -v.brake * 2.5, v.accel);
}

/**
 * Everything ahead of a vehicle that it has to respond to, as one gap.
 *
 * A red light is a stationary car parked on the stop line - the same arithmetic slows
 * for both, which is why the queue that forms at a signal has the same shape as the one
 * behind a slow truck.
 */
export function gapAhead(v, leader, junction, elapsed) {
  let gap = Infinity;
  let leadSpeed = 0;
  if (leader) {
    gap = (leader.s - v.s) * v.side - (leader.length + v.length) * 0.5;
    leadSpeed = leader.speed;
  }
  if (junction && junction.distance > 0) {
    const light = signalFor(
      v.axis === 0 ? junction.index : v.line,
      v.axis === 0 ? v.line : junction.index,
      v.axis, elapsed,
    );
    const stopping = (v.speed * v.speed) / (2 * v.brake);
    // Amber is only a stop if there is room to stop; otherwise it is a green you are
    // already committed to, which is what amber means.
    const halt = light === 'red' || (light === 'amber' && junction.distance - STOP_LINE > stopping * 0.8);
    if (halt) {
      const d = junction.distance - STOP_LINE;
      if (d < gap) { gap = d; leadSpeed = 0; }
    }
  }
  return { gap: Math.max(gap, -1), leadSpeed };
}

/**
 * Which way to go at a junction.
 *
 * Mostly straight on, because traffic that turns at every opportunity reads as a
 * shoal rather than a street. Turns that are not possible - the road the other way is
 * water, or does not exist - are never chosen, which is also what keeps the cars out of
 * the harbour.
 */
export function chooseTurn(v, junction, rng) {
  const options = [];
  const ahead = v.s + v.side * PERIOD * 0.75;
  if (roadExists(v.axis, v.line, ahead)) options.push({ weight: 7, turn: 0 });

  const crossAxis = v.axis === 0 ? 1 : 0;
  for (const dir of [-1, 1]) {
    const line = junction.index;
    const s = lineAt(v.line) + dir * PERIOD * 0.75;
    if (roadExists(crossAxis, line, s)) options.push({ weight: 1.5, turn: dir });
  }
  if (!options.length) return null;

  let roll = rng.next() * options.reduce((a, o) => a + o.weight, 0);
  for (const o of options) {
    roll -= o.weight;
    if (roll <= 0) return o;
  }
  return options[options.length - 1];
}

/**
 * Does a turn cross oncoming traffic, and is it clear?
 *
 * Only one of the two turns crosses the other carriageway. Which one depends on the
 * direction of travel, and the answer is the same one a driver gives: if the oncoming
 * lane has something in it that will be here within a few seconds, wait.
 */
export function mustYield(v, turn) {
  return turn !== 0 && Math.sign(turn) === Math.sign(v.side);
}

export function oncomingClear(v, junction, oncoming) {
  if (!oncoming.length) return true;
  for (const o of oncoming) {
    const d = (lineAt(junction.index) - o.s) * o.side;
    if (d < -JUNCTION_CLEAR) continue;
    if (d < YIELD_WINDOW * Math.max(o.speed, 4)) return false;
  }
  return true;
}

/**
 * Put a vehicle onto the crossing road.
 *
 * The corner itself is interpolated by the caller over a short arc; this is the state
 * it lands in. `s` starts a little past the junction so the vehicle is clear of it and
 * cannot immediately re-trigger the same turn.
 */
export function applyTurn(v, junction, turn) {
  const enteredAt = lineAt(junction.index);
  const wasLine = v.line;
  v.axis = v.axis === 0 ? 1 : 0;
  v.line = junction.index;
  v.side = turn;
  v.s = lineAt(wasLine) + turn * (JUNCTION_CLEAR * 0.6);
  v.lane = 0;
  return enteredAt;
}

/**
 * Overtaking, on the roads wide enough for it.
 *
 * Only when genuinely held up - blocked by something slower than this driver wants to
 * go - and only when the lane alongside has room. A city where every car changes lane
 * whenever it can looks like a motor race.
 */
export function wantsOvertake(v, gap, leadSpeed) {
  if (lanesFor(v).length < 2) return false;
  return gap < v.speed * 2.2 && leadSpeed < v.cruise * 0.82 && v.speed > 3;
}

export function laneClear(v, targetLane, peers) {
  for (const o of peers) {
    if (o === v || o.lane !== targetLane) continue;
    const d = (o.s - v.s) * v.side;
    if (d > -(v.length + o.length) && d < v.length + o.length + v.speed * 1.6) return false;
  }
  return true;
}

/**
 * The surface a vehicle stands on, and how steeply it runs.
 *
 * The pitch is what sells the bridge: a car nosing up the approach ramp and levelling
 * out onto the deck is doing something no amount of correct height alone conveys. It is
 * measured from the road surface itself, a few metres either side, so it is right for
 * any slope the car is on rather than only for the ones that were thought of.
 */
export function surfaceUnder(v, out = {}) {
  const p = vehicleXZ(v, out);
  const here = roadSurfaceAt(p.x, p.z);
  const step = 6;
  const bx = v.axis === 0 ? step * v.side : 0;
  const bz = v.axis === 0 ? 0 : step * v.side;
  const ahead = roadSurfaceAt(p.x + bx, p.z + bz);
  const behind = roadSurfaceAt(p.x - bx, p.z - bz);
  out.y = here.y;
  // Nose up when the road ahead is higher. Rotating about the car's own lateral axis
  // by a positive angle tips its nose toward the sky, so the climb has to be the
  // positive term - the other way round and a car pulls a wheelie going downhill.
  out.pitch = Math.atan2(ahead.y - behind.y, step * 2);
  out.onBridge = here.onBridge;
  return out;
}

/** Everything a vehicle needs to exist, given where it is being put. */
export function spawnState(v, { axis, line, side, lane, s, cruise }) {
  v.axis = axis;
  v.line = line;
  v.side = side;
  v.lane = lane;
  v.s = s;
  v.cruise = cruise;
  v.speed = cruise * 0.8;
  v.signal = 0;
  v.turning = null;
  v.active = true;
  return v;
}

/** The key a lane's occupants are grouped under, for the following model. */
export const laneKey = (v) => `${v.axis}:${v.line}:${v.side}:${v.lane}`;

/** The same road, the other way: who a turning driver has to give way to. */
export const oncomingKey = (v) => `${v.axis}:${v.line}:${-v.side}:0`;
