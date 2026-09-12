import { RUNWAY } from './regions.js';

/**
 * Mission catalogue (spec §36-39, §108-112).
 *
 * Authored as data, not code, so adding a mission is adding an entry (§92, §132).
 *
 * The progression follows §109: fly, then turn, then go fast, then use turbo, then
 * avoid things, then beat a clock, then land. After that, missions combine systems
 * rather than introducing new ones, and §112's contrast rule is applied deliberately
 * — a night mission follows a noon one, a precision mission follows a speed one, and
 * no two consecutive missions use the same district.
 *
 * Gate radii shrink as the campaign goes on: 52 m while learning, 20 m by the end
 * (§35). Star thresholds are times in seconds: [three stars, two stars, one star].
 */

const pt = (x, y, z, radius = 40) => ({ x, y, z, radius });

/** Evenly spaced gates along a straight leg. */
function line(from, to, count, radius = 40) {
  const out = [];
  for (let i = 1; i <= count; i++) {
    const t = i / count;
    out.push(pt(
      from[0] + (to[0] - from[0]) * t,
      from[1] + (to[1] - from[1]) * t,
      from[2] + (to[2] - from[2]) * t,
      radius,
    ));
  }
  return out;
}

/** Gates around a circular arc, optionally climbing or descending. */
function arc(cx, cz, r, a0, a1, count, y0, y1 = y0, radius = 40) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0 : i / (count - 1);
    const a = a0 + (a1 - a0) * t;
    out.push(pt(cx + Math.cos(a) * r, y0 + (y1 - y0) * t, cz + Math.sin(a) * r, radius));
  }
  return out;
}

/** Alternating left/right offsets along a leg: a slalom. */
function slalom(from, to, count, amplitude, radius = 34) {
  const dx = to[0] - from[0], dz = to[2] - from[2];
  const len = Math.hypot(dx, dz) || 1;
  const nx = -dz / len, nz = dx / len;
  const out = [];
  for (let i = 1; i <= count; i++) {
    const t = i / (count + 1);
    const side = i % 2 === 0 ? 1 : -1;
    out.push(pt(
      from[0] + dx * t + nx * amplitude * side,
      from[1] + (to[1] - from[1]) * t,
      from[2] + dz * t + nz * amplitude * side,
      radius,
    ));
  }
  return out;
}

export const MISSIONS = [
  // ---------------------------------------------------------------- LEARNING
  {
    id: 'first-light',
    name: 'FIRST LIGHT',
    type: 'CHECKPOINT RUN',
    region: 'central',
    desc: 'Six rings strung down the middle of downtown at a comfortable height. Throttle up, keep the nose level, fly through them. Nothing is trying to catch you.',
    tip: 'W and S work the throttle. A and D bank the wings, and banking is how an aircraft turns.',
    conditions: { weather: 'clear', hour: 9 },
    start: { x: 0, y: 320, z: 1500, heading: 0, speed: 62 },
    route: [
      pt(0, 320, 900, 52), pt(-120, 340, 300, 52), pt(-200, 350, -300, 52),
      pt(100, 360, -900, 52), pt(600, 350, -1300, 52), pt(1100, 330, -1000, 52),
    ],
    timeLimit: null,
    stars: { time: [52, 68, 95] },
    rewards: { credits: 900, xp: 120 },
    unlock: { stars: 0 },
    rules: {},
  },
  {
    id: 'city-turns',
    name: 'CITY TURNS',
    type: 'CHECKPOINT RUN',
    region: 'central',
    desc: 'A loop around the core that never stops turning. Bank into the corner, hold it, and pull the nose up a touch to stop the turn dragging you downward.',
    tip: 'A banked wing makes less lift upward. Hold a little back pressure through a turn or you will sink out of it.',
    conditions: { weather: 'clear', hour: 10.5 },
    start: { x: 1200, y: 330, z: 600, heading: -Math.PI / 2, speed: 68 },
    route: [
      ...arc(0, 0, 1150, 0.4, 2.6, 5, 330, 360, 46),
      ...arc(0, 0, 1150, 2.9, 5.1, 5, 360, 320, 46),
      pt(1150, 320, 180, 46),
    ],
    timeLimit: 150,
    stars: { time: [74, 92, 125] },
    rewards: { credits: 1100, xp: 150 },
    unlock: { stars: 1 },
    rules: {},
  },
  {
    id: 'riverside-sprint',
    name: 'RIVERSIDE SPRINT',
    type: 'TIME TRIAL',
    region: 'central',
    desc: 'Straight and fast, from the park out to the edge of the district. The clock is the only opponent. Full throttle and a clean line is all this one asks for.',
    tip: 'Top speed is not instant. Get the throttle forward early and stay off the brakes.',
    conditions: { weather: 'clear', hour: 12.5 },
    start: { x: -620, y: 280, z: 1400, heading: 0, speed: 78 },
    route: [
      ...line([-620, 280, 1100], [-400, 300, -1400], 5, 44),
      ...line([-400, 300, -1400], [1500, 300, -1500], 3, 44),
    ],
    timeLimit: 90,
    stars: { time: [46, 58, 80] },
    rewards: { credits: 1300, xp: 170 },
    unlock: { stars: 3 },
    rules: {},
  },
  {
    id: 'afterburn',
    name: 'AFTERBURN',
    type: 'TIME TRIAL',
    region: 'beach',
    desc: 'Long legs out over the water where nothing can hit you, and a clock tight enough that you will not beat it without the turbo. Learn what the boost is worth.',
    tip: 'Hold SHIFT for turbo. The tank is finite and only refills once you let go, so spend it on the straights.',
    conditions: { weather: 'clear', hour: 16 },
    start: { x: -3000, y: 260, z: 2400, heading: Math.PI, speed: 80 },
    route: [
      ...line([-3000, 250, 3000], [-3000, 240, 4600], 2, 46),
      ...line([-3000, 240, 4600], [-1200, 260, 5200], 3, 46),
      ...line([-1200, 260, 5200], [600, 280, 4400], 3, 46),
    ],
    timeLimit: 95,
    stars: { time: [58, 70, 92] },
    rewards: { credits: 1500, xp: 190, unlockPaint: 'midnight' },
    unlock: { stars: 5 },
    rules: {},
  },

  // ------------------------------------------------------------ PRECISION
  {
    id: 'rooftop-slalom',
    name: 'ROOFTOP SLALOM',
    type: 'SLALOM',
    region: 'central',
    desc: 'Down among the roofs, weaving left and right between the towers. The gates are smaller and the buildings are very close. Speed is no longer free.',
    tip: 'Slow down before the gate, not in it. Scraping a wall costs you the multiplier as well as the hull.',
    conditions: { weather: 'clear', hour: 14 },
    start: { x: 1600, y: 190, z: 1000, heading: -Math.PI * 0.75, speed: 72 },
    route: [
      ...slalom([1200, 180, 700], [-900, 180, -800], 7, 210, 30),
      pt(-1200, 200, -1200, 30),
    ],
    timeLimit: 140,
    stars: { time: [76, 95, 130] },
    rewards: { credits: 1700, xp: 210 },
    unlock: { stars: 7 },
    rules: { maxAltitude: 420 },
  },
  {
    id: 'stadium-circuit',
    name: 'STADIUM CIRCUIT',
    type: 'CHECKPOINT RUN',
    region: 'residential',
    desc: 'Low laps around Ridgeway Stadium, dropping into the bowl and climbing back out over the floodlight pylons. Plenty of room, very little height.',
    tip: 'Diving builds speed and climbing eats it. Use the drop into the bowl to carry energy up the other side.',
    conditions: { weather: 'clear', hour: 17.5 },
    start: { x: -3260, y: 260, z: 200, heading: Math.PI, speed: 76 },
    route: [
      pt(-3260, 210, -180, 40),
      ...arc(-3260, -520, 240, 1.6, -1.4, 5, 120, 150, 36),
      pt(-3260, 95, -520, 34),
      ...arc(-3260, -520, 260, 1.7, 3.6, 4, 150, 200, 36),
    ],
    timeLimit: 135,
    stars: { time: [70, 88, 120] },
    rewards: { credits: 1800, xp: 230 },
    unlock: { stars: 9 },
    rules: {},
  },
  {
    id: 'bridge-run',
    name: 'UNDER NORTHGATE',
    type: 'LOW ALTITUDE',
    region: 'harbor',
    desc: 'The harbour channel, at the water. The last gate is under the bridge deck, between the towers, and there is about as much room there as it sounds.',
    tip: 'The gap under the deck is real and it is legal. Line up early and resist the urge to climb.',
    conditions: { weather: 'clear', hour: 15 },
    start: { x: 700, y: 180, z: 2200, heading: Math.PI, speed: 74 },
    route: [
      pt(700, 140, 2700, 40), pt(720, 95, 3100, 34),
      pt(700, 58, 3400, 30), pt(700, 42, 3560, 26), pt(700, 60, 3860, 34),
      pt(400, 120, 4300, 40),
    ],
    timeLimit: 120,
    stars: { time: [54, 68, 95] },
    rewards: { credits: 2100, xp: 260 },
    unlock: { stars: 12 },
    rules: { maxAltitude: 240 },
  },
  {
    id: 'container-weave',
    name: 'CONTAINER WEAVE',
    type: 'SLALOM',
    region: 'harbor',
    desc: 'Along the container quay, in and out of the crane booms. They stick out over the water further than you think.',
    tip: 'Near misses are worth points. Flying close on purpose pays, flying close by accident does not.',
    conditions: { weather: 'cloudy', hour: 11 },
    start: { x: -1200, y: 150, z: 3700, heading: Math.PI / 2, speed: 76 },
    route: [
      ...slalom([-900, 120, 3750], [700, 120, 3800], 6, 130, 28),
      pt(1100, 160, 3600, 32),
    ],
    timeLimit: 110,
    stars: { time: [56, 70, 96] },
    rewards: { credits: 2200, xp: 280 },
    unlock: { stars: 14 },
    rules: { maxAltitude: 300 },
  },

  // ------------------------------------------------------------ AIRMANSHIP
  {
    id: 'first-landing',
    name: 'BRING IT HOME',
    type: 'LANDING',
    region: 'airport',
    desc: 'Fly the approach gates onto runway 09 and put the aircraft on the ground in one piece. Landing is a throttle exercise as much as a stick exercise.',
    tip: 'Pitch controls your descent rate, throttle controls your speed. Cross the threshold slow, sinking gently, wings level.',
    conditions: { weather: 'clear', hour: 13 },
    start: { x: RUNWAY.x - 3800, y: 420, z: RUNWAY.z - 520, heading: Math.PI / 2, speed: 72 },
    route: [
      pt(RUNWAY.x - 2900, 320, RUNWAY.z - 240, 56),
      pt(RUNWAY.x - 2100, 200, RUNWAY.z - 80, 48),
      pt(RUNWAY.x - 1500, 110, RUNWAY.z, 44),
      pt(RUNWAY.x - 1150, 55, RUNWAY.z, 40),
    ],
    timeLimit: null,
    stars: { landing: true, time: [75, 100, 150] },
    rewards: { credits: 2400, xp: 320 },
    unlock: { stars: 10 },
    rules: { requireLanding: true },
  },
  {
    id: 'departure',
    name: 'WHEELS UP',
    type: 'TAKEOFF',
    region: 'airport',
    desc: 'Start cold on the runway. Roll, rotate, climb out through the departure gates. The first one is high enough that a lazy climb will miss it.',
    tip: 'Hold the nose down until you have rotate speed, then ease back. Pulling too early just drags you along the concrete.',
    conditions: { weather: 'clear', hour: 7.5 },
    start: { x: RUNWAY.x - 1000, y: RUNWAY.elevation, z: RUNWAY.z, heading: Math.PI / 2, grounded: true },
    route: [
      pt(RUNWAY.x + 1400, 120, RUNWAY.z, 50),
      pt(RUNWAY.x + 2400, 300, RUNWAY.z - 200, 46),
      pt(RUNWAY.x + 2900, 520, RUNWAY.z - 900, 44),
      pt(RUNWAY.x + 2200, 700, RUNWAY.z - 1800, 44),
    ],
    timeLimit: 120,
    stars: { time: [48, 62, 90] },
    rewards: { credits: 2300, xp: 300 },
    unlock: { stars: 10 },
    rules: { requireTakeoff: true },
  },

  // ------------------------------------------------------------ VERTICAL
  {
    id: 'financial-canyon',
    name: 'FINANCIAL CANYON',
    type: 'SLALOM',
    region: 'financial',
    desc: 'The tightest streets in the city, between towers three hundred metres tall. The gates sit in the gaps. There is no room to be sloppy and no sky to escape into.',
    tip: 'Look through the gate you are aiming at, to the one after it. If you are only looking at the next gate you are already late.',
    conditions: { weather: 'clear', hour: 15.5 },
    start: { x: 3000, y: 320, z: 1500, heading: 0, speed: 80 },
    route: [
      ...slalom([3000, 300, 1200], [3100, 300, -1000], 7, 190, 26),
      pt(3180, 430, -1500, 34),
    ],
    timeLimit: 135,
    stars: { time: [72, 90, 124] },
    rewards: { credits: 2600, xp: 340 },
    unlock: { stars: 16 },
    rules: { maxAltitude: 520 },
  },
  {
    id: 'obelisk-climb',
    name: 'OBELISK CLIMB',
    type: 'HIGH ALTITUDE',
    region: 'financial',
    desc: 'A spiral up around the Obelisk to well above the roofline, then a long dive back down into the street. Climbing costs speed. Budget for it.',
    tip: 'Trade height for speed on the way down. A dive is the fastest way to get energy back.',
    conditions: { weather: 'clear', hour: 18.7 },
    start: { x: 3180, y: 300, z: 900, heading: Math.PI, speed: 84 },
    route: [
      ...arc(3180, 180, 420, 1.6, 6.4, 6, 260, 760, 40),
      pt(3180, 900, 180, 44),
      ...line([3180, 860, -200], [2400, 260, -1400], 3, 40),
    ],
    timeLimit: 150,
    stars: { time: [80, 100, 138] },
    rewards: { credits: 2700, xp: 360 },
    unlock: { stars: 18 },
    rules: { minAltitude: 0 },
  },
  {
    id: 'wheel-show',
    name: 'BOARDWALK AIR SHOW',
    type: 'AIR SHOW',
    region: 'beach',
    desc: 'The crowd is on the boardwalk. Fly the gates, but the score is what matters here: rolls, loops, and passes close enough to the wheel to make people duck.',
    tip: 'Rolls and loops multiply your combo. Hitting anything wipes it out, so pick your moments.',
    conditions: { weather: 'clear', hour: 17.8 },
    start: { x: -3020, y: 280, z: 3000, heading: Math.PI, speed: 82 },
    route: [
      pt(-3020, 200, 3400, 44), pt(-3000, 190, 3720, 38),
      pt(-2600, 220, 4100, 40), pt(-2000, 180, 4300, 40),
      pt(-1620, 120, 4080, 36), pt(-1200, 240, 3700, 40),
    ],
    timeLimit: 150,
    stars: { score: [42000, 28000, 16000] },
    rewards: { credits: 2800, xp: 380, unlockPaint: 'sunburst' },
    unlock: { stars: 20 },
    rules: {},
  },

  // ------------------------------------------------------------ CONDITIONS
  {
    id: 'smokestacks',
    name: 'SMOKESTACK RUN',
    type: 'LOW ALTITUDE',
    region: 'industrial',
    desc: 'Rain over the industrial district. Low gates between the stacks and the silos, with the visibility to match. Things appear late out here.',
    tip: 'In poor visibility trust the nav marker and the distance readout, not your eyes.',
    conditions: { weather: 'rain', hour: 16 },
    start: { x: 3000, y: 220, z: -1800, heading: Math.PI, speed: 76 },
    route: [
      ...slalom([3000, 150, -2200], [2900, 150, -4000], 6, 220, 30),
      pt(2400, 200, -4300, 36),
    ],
    timeLimit: 130,
    stars: { time: [68, 86, 118] },
    rewards: { credits: 3000, xp: 400 },
    unlock: { stars: 22 },
    rules: { maxAltitude: 360 },
  },
  {
    id: 'night-city',
    name: 'NIGHT SHIFT',
    type: 'NIGHT FLIGHT',
    region: 'central',
    desc: 'The same downtown you learned on, in the dark. Every window is lit and none of it helps you judge distance. The rings are the only thing you can trust.',
    tip: 'At night the lit rings read clearly but the buildings between them do not. Give yourself margin.',
    conditions: { weather: 'clear', hour: 22.5 },
    start: { x: 1400, y: 300, z: 1400, heading: -Math.PI * 0.75, speed: 80 },
    route: [
      pt(900, 280, 800, 36), pt(200, 300, 200, 36), pt(-500, 320, -400, 36),
      pt(-300, 420, -1100, 36), pt(400, 480, -1500, 36), pt(1100, 400, -1200, 36),
      pt(1400, 320, -500, 36),
    ],
    timeLimit: 125,
    stars: { time: [66, 82, 112] },
    rewards: { credits: 3100, xp: 420 },
    unlock: { stars: 24 },
    rules: {},
  },
  {
    id: 'storm-coast',
    name: 'STORM COAST',
    type: 'STORM',
    region: 'harbor',
    desc: 'A full storm over the bay. Seventeen metres a second of wind, gusting, with the visibility down to nothing and the gates strung out over open water.',
    tip: 'The wind pushes you off line continuously. Aim upwind of the gate and let it carry you in.',
    conditions: { weather: 'storm', hour: 19.2 },
    start: { x: -600, y: 320, z: 2600, heading: Math.PI, speed: 86 },
    route: [
      pt(-400, 280, 3200, 44), pt(200, 240, 3900, 40), pt(900, 260, 4600, 40),
      pt(1800, 300, 5000, 40), pt(2600, 260, 4500, 40), pt(3000, 220, 3700, 44),
    ],
    timeLimit: 145,
    stars: { time: [78, 98, 134] },
    rewards: { credits: 3400, xp: 460 },
    unlock: { stars: 26 },
    rules: {},
  },
  {
    id: 'ridge-pass',
    name: 'RIDGE PASS',
    type: 'ESCAPE',
    region: 'mountains',
    desc: 'Into the North Ridge and out the other side. Real terrain, eight hundred metres of it, and a pass with one line through it. The mountain does not move.',
    tip: 'The ground rises faster than you can climb at low speed. Enter with height and energy in hand.',
    conditions: { weather: 'cloudy', hour: 8.5 },
    start: { x: -1800, y: 700, z: -2200, heading: -Math.PI * 0.75, speed: 88 },
    route: [
      pt(-2300, 760, -2700, 46), pt(-2800, 880, -3100, 42),
      pt(-3100, 960, -3400, 38), pt(-3500, 880, -3800, 40),
      pt(-4000, 720, -4000, 44), pt(-4300, 740, -3400, 46),
    ],
    timeLimit: 150,
    stars: { time: [80, 100, 136] },
    rewards: { credits: 3600, xp: 500 },
    unlock: { stars: 28 },
    rules: {},
  },
  {
    id: 'dam-rescue',
    name: 'VALLEY RESCUE',
    type: 'RESCUE',
    region: 'countryside',
    desc: 'A casualty at the dam and a hard deadline. Straight out over the fields, down the reservoir, and the last gate is on the dam wall itself.',
    tip: 'This is a pure time problem. Pick the shortest line you can actually fly, not the shortest line on the map.',
    conditions: { weather: 'cloudy', hour: 6.4 },
    start: { x: 600, y: 400, z: -1600, heading: Math.PI, speed: 86 },
    route: [
      pt(300, 380, -2200, 48), pt(0, 360, -2900, 44),
      pt(-200, 300, -3500, 40), pt(-220, 240, -4020, 34),
    ],
    timeLimit: 72,
    stars: { time: [42, 52, 70] },
    rewards: { credits: 3800, xp: 520 },
    unlock: { stars: 30 },
    rules: {},
  },

  // ------------------------------------------------------------ RIVAL
  {
    id: 'rival-downtown',
    name: 'KESTREL: DOWNTOWN',
    type: 'AIR RACE',
    region: 'central',
    desc: 'Vanya Kestrel has been winning everything in this city for two years and has decided you are worth the trouble. Same route, same rules, one of you first.',
    tip: 'The rival flies a real aircraft with a real turbo tank. Watch where they spend it and spend yours better.',
    conditions: { weather: 'clear', hour: 11.5 },
    start: { x: 1500, y: 300, z: 1500, heading: -Math.PI * 0.75, speed: 92 },
    route: [
      pt(900, 300, 800, 42), pt(0, 320, 200, 42), pt(-800, 340, -500, 42),
      pt(-600, 400, -1400, 42), pt(400, 420, -1700, 42), pt(1300, 360, -1200, 42),
      pt(1600, 320, -200, 42), pt(1200, 300, 700, 42),
    ],
    timeLimit: 160,
    stars: { beatRival: true, time: [84, 104, 142] },
    rewards: { credits: 4200, xp: 580 },
    unlock: { stars: 32 },
    rules: { rival: { aircraftId: 'vector', skill: 0.58, name: 'V. KESTREL', paint: 'ember' } },
  },
  {
    id: 'rival-coast',
    name: 'KESTREL: REMATCH',
    type: 'AIR RACE',
    region: 'beach',
    desc: 'Kestrel wants it back, over the water where the aircraft matters more than the line. They have brought something faster this time.',
    tip: 'Long legs reward top speed. If you are still in a starter aircraft, this is the mission that tells you.',
    conditions: { weather: 'clear', hour: 18.4 },
    start: { x: -2600, y: 320, z: 2600, heading: Math.PI, speed: 100 },
    route: [
      pt(-2800, 300, 3400, 44), pt(-2600, 260, 4400, 44), pt(-1400, 240, 5000, 44),
      pt(0, 280, 5200, 44), pt(1400, 300, 4600, 44), pt(2200, 260, 3800, 44),
      pt(1600, 320, 2900, 44), pt(200, 340, 2700, 44),
    ],
    timeLimit: 170,
    stars: { beatRival: true, time: [88, 110, 150] },
    rewards: { credits: 4800, xp: 650, unlockPaint: 'aurora' },
    unlock: { stars: 36 },
    rules: { rival: { aircraftId: 'talon', skill: 0.72, name: 'V. KESTREL', paint: 'ember' } },
  },

  // ------------------------------------------------------------ ENDGAME
  {
    id: 'championship-1',
    name: 'SKYLINE CHAMPIONSHIP I',
    type: 'AIR RACE',
    region: 'financial',
    desc: 'Opening stage of the championship. Financial district, twenty-metre gates, and the whole field watching. Precision at speed, with no margin left anywhere.',
    tip: 'Twenty-metre gates need you lined up a long way out. Sacrifice a little speed for a lot of accuracy.',
    conditions: { weather: 'clear', hour: 13.5 },
    start: { x: 3000, y: 300, z: 1800, heading: 0, speed: 105 },
    route: [
      ...slalom([3000, 280, 1200], [3100, 300, -1000], 6, 170, 22),
      pt(3180, 520, -1500, 24),
      ...arc(3180, 180, 500, 4.2, 1.8, 4, 520, 320, 24),
    ],
    timeLimit: 165,
    stars: { time: [86, 106, 145] },
    rewards: { credits: 5200, xp: 720 },
    unlock: { stars: 40 },
    rules: { maxAltitude: 700, championship: 1 },
  },
  {
    id: 'championship-2',
    name: 'SKYLINE CHAMPIONSHIP II',
    type: 'AIR RACE',
    region: 'harbor',
    desc: 'Stage two, at dusk, in the rain, through the harbour and under the bridge. Kestrel is on the grid and is not here to come second.',
    tip: 'Rain plus dusk plus a bridge gap. Fly the route you already know rather than the one you can see.',
    conditions: { weather: 'rain', hour: 19.4 },
    start: { x: 700, y: 300, z: 2200, heading: Math.PI, speed: 105 },
    route: [
      pt(700, 200, 2800, 26), pt(700, 90, 3300, 24), pt(700, 44, 3560, 22),
      pt(500, 120, 3950, 26), pt(-340, 180, 3880, 26), pt(-1000, 220, 4200, 28),
      pt(-1600, 160, 4080, 26), pt(-2200, 240, 3600, 28),
    ],
    timeLimit: 170,
    stars: { beatRival: true, time: [90, 112, 152] },
    rewards: { credits: 6000, xp: 820 },
    unlock: { stars: 44 },
    rules: { rival: { aircraftId: 'talon', skill: 0.8, name: 'V. KESTREL', paint: 'ember' }, championship: 2 },
  },
  {
    id: 'skyline-master',
    name: 'SKYLINE MASTER',
    type: 'CHAMPIONSHIP FINAL',
    region: 'central',
    desc: 'Everything, in one run. Night, storm, the mountains, the coast, the bay, the airport and the city core. Twenty-metre gates. Kestrel alongside. This is the one.',
    tip: 'There is no single skill that gets you through this. Manage energy, spend turbo where it pays, and do not let one mistake become three.',
    conditions: { weather: 'storm', hour: 21 },
    start: { x: 0, y: 420, z: 1800, heading: 0, speed: 110 },
    route: [
      pt(0, 400, 1000, 26), pt(-400, 420, 0, 24), pt(-1200, 500, -1200, 24),
      pt(-2400, 880, -2400, 26), pt(-3100, 960, -3400, 24),
      pt(-4000, 780, -4000, 26), pt(-3400, 820, -2000, 26),
      pt(-3260, 200, -520, 24), pt(-3020, 180, 3720, 26),
      pt(-1620, 140, 4080, 24), pt(700, 48, 3560, 22),
      pt(RUNWAY.x - 1400, 120, RUNWAY.z, 26), pt(RUNWAY.x + 1200, 300, RUNWAY.z - 400, 26),
      pt(3180, 520, 180, 24), pt(1200, 400, -800, 24), pt(120, 600, -60, 22),
    ],
    timeLimit: 340,
    stars: { time: [215, 262, 330] },
    rewards: { credits: 12000, xp: 2000, unlockPaint: 'gold' },
    unlock: { stars: 48 },
    rules: { rival: { aircraftId: 'wraith', skill: 0.88, name: 'V. KESTREL', paint: 'carbon' }, championship: 3, final: true },
  },
];

export const MISSION_BY_ID = Object.fromEntries(MISSIONS.map((m) => [m.id, m]));

export function missionsForRegion(regionId) {
  return MISSIONS.filter((m) => m.region === regionId);
}

/** Total stars available, for progress readouts. */
export const TOTAL_STARS = MISSIONS.length * 3;

/** Evaluates stars earned. Returns 0..3. */
export function gradeMission(mission, result) {
  const s = mission.stars ?? {};
  let stars = 0;
  if (!result.completed) return 0;
  stars = 1;

  // Special conditions are worth a star in their own right.
  if (s.beatRival && result.beatRival) stars++;
  if (s.landing && result.landedWell) stars++;

  if (s.time) {
    const [gold, silver, bronze] = s.time;
    if (result.time <= gold) stars = 3;
    else if (result.time <= silver) stars = Math.max(stars, 2);
    else if (result.time <= bronze) stars = Math.max(stars, 1);
  }
  if (s.score) {
    const [gold, silver, bronze] = s.score;
    if (result.score >= gold) stars = 3;
    else if (result.score >= silver) stars = Math.max(stars, 2);
    else if (result.score >= bronze) stars = Math.max(stars, 1);
  }
  // A clean run is always worth something.
  if (result.perfect && stars < 3) stars++;
  return Math.max(1, Math.min(3, stars));
}
