# SKYLINE FLIGHT

A third-person arcade flight game over a fictional metropolis. Fly a light sport
aircraft, then faster ones, through checkpoint routes strung between skyscrapers, under a
suspension bridge, through a mountain pass and down a runway — in clear weather, rain,
storms and at night.

Built with Three.js. No art or audio assets: the city, the aircraft, the terrain and
every sound are generated at runtime.

```bash
npm install
npm run dev         # development server
npm run build       # production build into dist/
npm run test:unit   # flight physics and content validation, seconds, no browser
npm test            # the above, then a build, then the headless end-to-end run
```

The end-to-end run drives a real browser and flies a mission, so it takes several
minutes. `npm run test:unit` is the one to run while working.

## Controls

| Input | Action |
| --- | --- |
| `W` / `S` | Throttle up / down |
| `A` / `D` | Bank left / right — this is how you turn |
| `↑` / `↓` | Pitch |
| `Q` / `E` | Rudder |
| `Shift` | Turbo |
| `Space` | Airbrake |
| `Z` | Recovery assist — rolls upright and finds the horizon |
| `C` | Camera (chase, far, cockpit) |
| `V` | Look back |
| `R` | Reset to last checkpoint |
| `M` / `H` | Toggle minimap / HUD |
| `Esc` | Pause |

A gamepad works if one is connected: left stick flies, right stick rudders, triggers for
throttle, A or RB for turbo.

## How the flight model works

Airspeed is a scalar along the nose, and the aircraft turns by banking, the way a real one
does — turn rate is `g·tan(bank)/V`. That single choice produces most of the handling the
game needs for free:

- **Diving gains speed, climbing loses it**, because gravity acts along the flight path.
- **Fast aircraft need more room to corner**, because turn rate falls as speed rises.
- **Slow flight goes vague and then unflyable**, because control authority is measured
  against the relative wind.
- **Hard banking makes you sink**, because a banked wing lifts less against gravity.

Momentum is layered on as a decaying drift vector, so a heading change costs something
without ever making the aircraft unpredictable.

Drag is two terms. Parasitic drag is mostly quadratic, normalised so that full throttle
trims exactly at the aircraft's catalogue top speed — which is what makes the throttle a
usable lever rather than an on/off switch. Induced drag peaks at the stall speed and falls
away on both sides of it; that is what gives the throttle authority over speed on
approach, and what lets a stalled aircraft dive out of trouble instead of hitting a drag
floor that gravity cannot push through.

A stalled aircraft weathercocks: the nose is dragged toward the flight path. That turns a
stall into a dive, a dive into speed, and speed back into control.

All of this is covered by unit tests in `tests/flight.test.js`, which run in plain Node
with no renderer, against a flat-plane collider.

## Aircraft

Five classes, differentiated by physics rather than by paint. Each stock aircraft is faster
than the fully upgraded one below it, so upgrades close a gap without erasing it.

| Aircraft | Role | Top speed | Character |
| --- | --- | --- | --- |
| Skylark LS-2 | Light sport | 338 km/h | Forgiving, stable, slow |
| Vector S7 | Aerobatic | 464 km/h | Snaps into a bank, punishes carelessness |
| Talon AX-9 | Jet trainer | 608 km/h | Carries energy through corners |
| Meridian EX | Executive | 713 km/h | Heavy, smooth, very wide turns |
| Wraith X-1 | Experimental | 864 km/h | Fastest, most agile, no stability, fragile |

## Skyline City

A 9 km × 9 km world: nine districts on a 3 × 3 grid, ocean to the south, an 800 m mountain
ridge to the north.

Around 3,200 buildings are generated from a seed, each composed of stacked masses with
setbacks and crowns so no two silhouettes repeat, all drawn from four instanced meshes.
Small buildings are laid out on a sub-grid inside each block, so a district of houses reads
as a neighbourhood rather than as one house per city block.
Streets are painted in the terrain shader rather than built as geometry — zero extra
triangles for 80 square kilometres of road, and they follow the ground exactly.

Eleven landmarks exist to navigate by: Skyline Tower, the Obelisk, Ridgeway Stadium,
Northgate Bridge, the Skyline Wheel, the container quay, Valley Dam, the control tower,
South Marina, Central Park and Ridge Pass. Several carry deliberate flyable gaps — the
space under the bridge deck is real, open air, and a legal shortcut.

Windows light up at night, street lights come on, and the runway is lit well enough to land
on. Weather is gameplay: a storm brings 17 m/s of gusting wind that pushes the aircraft off
line, and visibility low enough that gates arrive late.

## Missions

23 missions across all nine districts, in 14 types: checkpoint runs, time trials, slaloms,
low and high altitude, takeoff, landing, air shows, night flights, storms, escapes, rescues,
air races and the championship final. Gates shrink from 52 m while learning to 20 m by the
end. Star thresholds gate the next district, so progress comes from flying well rather than
from playing long.

Finishing the championship ends the campaign properly: a celebration screen, the
champion livery, and FREE FLIGHT MASTER — free flight with every district open as a
starting point, any weather and any hour, in any aircraft you own.

## Hidden beacons

Twelve of them, out in the city, in places you have to fly deliberately: under the
bridge deck, down in the stadium bowl, inside Ridge Pass, out over open water. Each pays
credits and experience, and the full set earns a livery that is not for sale. There are
no markers on the minimap — the statistics screen lists a hint for each one and nothing
else. They can be collected in any flight, mission or free flight, and the save
remembers them.

The rival, Vanya Kestrel, flies a real `FlightModel` with a real aircraft from the same
catalogue the player buys from. It cannot cheat because there is no mechanism available to
it that the player does not also have: no secret top speed, no free energy in corners, and
a turbo tank that runs dry. Difficulty comes from how well it flies.

## Architecture

```
src/
  core/        event bus, input, settings, save system, math, seeded RNG
  data/        aircraft, missions, regions, upgrades, weather  (data, not code)
  flight/      flight model, turbo, damage, trick detection, aircraft factory
  camera/      chase, far and cockpit camera with speed-linked field of view
  world/       terrain, city generator, landmarks, sky, weather, traffic, time of day,
               hidden beacons
  mission/     checkpoints, score and combo, mission state machine, rival AI
  progression/ economy, XP, ratings, unlocks
  fx/          pooled particles, contrails, effects director
  audio/       fully synthesised engine, wind, turbo, impacts and adaptive music
  ui/          HUD, minimap, hangar preview, screens
  main.js      render loop and top-level state machine — wiring only
```

Systems talk through an event bus rather than holding references to each other. The flight
model knows nothing about buildings: it holds an opaque collider interface, which is why it
can be unit tested against a flat plane. The world implements that interface and is the
single collision authority.

Aircraft, missions, districts, upgrades and weather are data files. Adding a mission means
adding an entry.

### Performance

- Buildings, trees and traffic are instanced: ~2,000 buildings cost three draw calls.
- Collision uses a spatial hash, so a query tests a handful of candidates, not thousands.
- Terrain is three concentric rings at coarsening resolution.
- Streets, windows and street lighting are shader work, not geometry.
- Checkpoint rings are pooled: a 40-gate route costs what a 6-gate route costs.
- Particles are pooled and recycled; nothing allocates mid-flight.
- If the frame rate sits low, internal resolution drops before anything else.

Measured on the build in this repository: about 77,000 triangles for the city itself and
around 200,000 for a typical view including terrain, landmarks and traffic, in roughly 100
draw calls, with world updates at about 0.3 ms per frame.

## Tests

```bash
npm run test:flight    # 27 physics assertions, plain Node, no renderer
npm run test:content   # 19 content assertions against the generated world
npm run test:e2e       # headless browser run (needs a build first)
npm test               # all of it
```

`tests/flight.test.js` pins the axis conventions and the handling promises: that banking
right turns right, that full throttle trims at the catalogue top speed, that level flight
holds altitude, that a dive beats level beats a climb, that an aircraft stopped dead in the
air is never pinned there, that takeoff and landing gates work, and that a long frame cannot
teleport the aircraft through a wall. One of them documents a behaviour rather than a
promise: at idle a heavy aircraft settles into a stable mushing descent below its stall
speed, and it is the throttle, not the stick, that gets it flying again.

`tests/content.test.js` validates authored data against the generated world — it is what
caught three checkpoints buried inside the mountain, three more inside buildings and
landmarks, the city generator placing buildings across the runway, and the balance bug
where a fully upgraded Talon out-ran a stock Meridian. It does the same for the hidden
beacons: of the twelve, five were first authored inside a landmark and one five metres
off the ground.

`tests/smoke.test.js` serves the production build, drives it in headless Chromium, and
flies the first mission using real key events. It checks the city generates, the scene
renders, every control axis does what it claims, checkpoints register, a mission completes,
stars and credits are paid, progress survives a reload, a corrupt save recovers from its
backup, upgrades reach the flown aircraft, collisions cause damage, every weather state
renders, the beacons can be found and pay out, free flight can be set up and launched
with the chosen weather, the championship celebration appears once, and the aircraft can
take off from the runway.

## Known limits

- **Assets are procedural.** Everything is generated: geometry, textures, audio. The
  systems are structured so real art or sound can replace the generators without touching
  the game logic, but this is a stand-in, not a substitute.
- **The rival cuts corners** on routes tighter than its own turn radius. It completes every
  route and its pace scales with skill, but it does not thread every ring.
- **No replay or photo mode.** Both are listed as secondary in the specification and were
  cut in favour of the core loop.
- **Routes are single-path.** There is no branching checkpoint route offering a safe long
  way round against a risky short cut. The checkpoint system advances through one ordered
  sequence, and supporting alternatives means changing that core, which was not worth
  destabilising late. The nearest thing that exists is authored rather than structural: the
  gap under Northgate Bridge is a genuine short cut you can choose to take.
- **No daily challenges**, and the championship is three escalating missions rather than a
  separate multi-stage mode with its own standings.
- **The rival races on its own clock.** It flies the same route under the same physics and
  its finish time is what you are measured against, but it does not react to the player's
  position — no blocking, no drafting.
