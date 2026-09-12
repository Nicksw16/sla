/**
 * Hidden beacons (spec §151: after the campaign the player must still have something
 * to look for). Twelve of them, one per landmark or notable piece of the map, each in
 * a place you have to fly deliberately rather than pass through by accident: under a
 * bridge deck, inside the wheel, down in the stadium bowl, out over open water.
 *
 * Data only. The world spawns a marker per entry, proximity collects it, and the save
 * remembers which ones are gone. Positions are validated against the generated city
 * by tests/content.test.js: in open air, clear of geometry, and not in the sea.
 *
 * `hint` is the only help the player gets, listed in the statistics screen. It names
 * the place without giving the altitude, which is the part worth discovering.
 */
export const SECRETS = [
  { id: 'bridge-span',  name: 'SPAN BEACON',    x: 700,   y: 36,  z: 3560,  region: 'harbor',      hint: 'Beneath the Northgate Bridge deck.' },
  { id: 'wheel-hub',    name: 'WHEEL BEACON',   x: -3020, y: 44,  z: 3660,  region: 'beach',       hint: 'Low alongside the Skyline Wheel.' },
  { id: 'dam-wall',     name: 'SPILLWAY BEACON', x: -240, y: 140, z: -3960, region: 'countryside', hint: 'Hugging the Valley Dam wall, on the downstream side.' },
  { id: 'ridge-pass',   name: 'PASS BEACON',    x: -3100, y: 830, z: -3400, region: 'mountains',   hint: 'Inside Ridge Pass, between the shoulders.' },
  { id: 'stadium-bowl', name: 'BOWL BEACON',    x: -3200, y: 52,  z: -520,  region: 'residential', hint: 'Down inside the Ridgeway Stadium bowl.' },
  { id: 'obelisk-tip',  name: 'OBELISK BEACON', x: 3180,  y: 372, z: 120,   region: 'financial',   hint: 'Alongside the Obelisk, just under its tip.' },
  { id: 'park-canopy',  name: 'CANOPY BEACON',  x: -620,  y: 42,  z: 640,   region: 'central',     hint: 'Low across Central Park, under the skyline.' },
  { id: 'quay-cranes',  name: 'QUAY BEACON',    x: -340,  y: 32,  z: 4040,  region: 'harbor',      hint: 'Under the container crane gantries.' },
  { id: 'tower-cab',    name: 'TOWER BEACON',   x: 2560,  y: 92,  z: 2830,  region: 'airport',     hint: 'Level with the control tower cab.' },
  { id: 'marina-masts', name: 'MARINA BEACON',  x: -1620, y: 46,  z: 4080,  region: 'beach',       hint: 'Over the South Marina masts.' },
  { id: 'open-water',   name: 'OFFSHORE BEACON', x: 1900, y: 60,  z: 4720,  region: 'beach',       hint: 'Out over open water, south of the harbour.' },
  { id: 'skyline-crown', name: 'CROWN BEACON',  x: 120,   y: 580, z: -60,   region: 'central',     hint: 'At the crown of Skyline Tower.' },
];

export const SECRET_BY_ID = Object.fromEntries(SECRETS.map((s) => [s.id, s]));

/** How close the aircraft has to be. Generous: finding it is the hard part. */
export const SECRET_RADIUS = 46;

/** Paid per beacon, with the set completing a livery (see PAINTS.beacon). */
export const SECRET_REWARD = { credits: 1200, xp: 150 };
