/**
 * Flight model unit tests. These run in plain Node (no browser, no renderer) and
 * guard the axis conventions and the handling promises the whole game leans on.
 * Run with: npm run test:flight
 */
import assert from 'node:assert/strict';
import { AIRCRAFT } from '../src/data/aircraft.js';
import { FlightModel } from '../src/flight/FlightModel.js';
import { EventBus } from '../src/core/EventBus.js';

const flatCollider = {
  groundHeight: () => 0,
  isRunway: () => false,
  runwayAlignment: () => 0,
  sampleObstacle: () => null,
  proximity: () => null,
};

function makeInput({ pitch = 0, roll = 0, yaw = 0, throttle = 0, brake = false } = {}) {
  return { axes: { pitch, roll, yaw, throttle }, buttons: { brake, turbo: false, look: false, levelOut: false } };
}

function fly(model, steps, input, dt = 1 / 60, turbo = null) {
  for (let i = 0; i < steps; i++) model.update(dt, input, turbo);
}

/** axes.throttle is a lever rate, so tests that need a power setting set it here. */
function setPower(model, value) {
  model.throttleCmd = value;
  model.throttle = value;
  return model;
}

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}\n       ${err.message}`);
    process.exitCode = 1;
  }
}

const bus = new EventBus();
const spawn = (id = 'skylark', opts = {}) => {
  const m = new FlightModel({ spec: structuredClone(AIRCRAFT[id]), bus, collider: flatCollider, assist: 'off' });
  m.reset({ position: { x: 0, y: 600, z: 0, clone: null, ...opts.position }, heading: opts.heading ?? 0 });
  // reset() copies from a Vector3-like; give it a real one.
  m.position.set(opts.position?.x ?? 0, opts.position?.y ?? 600, opts.position?.z ?? 0);
  return m;
};

console.log('\nFlightModel');

test('faces -Z at zero heading', () => {
  const m = spawn();
  assert.ok(m.forward.z < -0.99, `forward.z = ${m.forward.z}`);
  assert.ok(Math.abs(m.heading) < 1e-6, `heading = ${m.heading}`);
});

test('heading is a compass: +90deg faces +X (east)', () => {
  const m = spawn('skylark', { heading: Math.PI / 2 });
  assert.ok(m.forward.x > 0.99, `forward.x = ${m.forward.x}`);
  assert.ok(Math.abs(m.heading - Math.PI / 2) < 1e-5, `heading = ${m.heading}`);
});

test('banking right rolls the right wing down', () => {
  const m = spawn();
  fly(m, 30, makeInput({ roll: 1, throttle: 1 }));
  assert.ok(m.bank > 0.05, `bank = ${m.bank}`);
  assert.ok(m.right.y < -0.05, `right.y = ${m.right.y}`);
});

test('banking right turns right (compass heading increases)', () => {
  const m = spawn();
  fly(m, 180, makeInput({ roll: 1, throttle: 1 }));
  assert.ok(m.heading > 0.1, `heading = ${m.heading} (should grow turning right)`);
  assert.ok(m.forward.x > 0.05, `forward.x = ${m.forward.x}`);
});

test('banking left turns left', () => {
  const m = spawn();
  fly(m, 180, makeInput({ roll: -1, throttle: 1 }));
  assert.ok(m.heading < -0.1, `heading = ${m.heading}`);
});

test('pitch up raises the nose', () => {
  const m = spawn();
  fly(m, 30, makeInput({ pitch: 1, throttle: 1 }));
  assert.ok(m.pitchAngle > 0.05, `pitch = ${m.pitchAngle}`);
  assert.ok(m.forward.y > 0.05, `forward.y = ${m.forward.y}`);
});

test('rudder right yaws the nose right', () => {
  const m = spawn();
  fly(m, 60, makeInput({ yaw: 1, throttle: 1 }));
  assert.ok(m.heading > 0.005, `heading = ${m.heading}`);
});

test('full throttle settles on the catalogue top speed', () => {
  const m = spawn('talon');
  m.airspeed = 40;
  fly(m, 60 * 90, makeInput({ throttle: 1 }));
  const err = Math.abs(m.airspeed - AIRCRAFT.talon.maxSpeed) / AIRCRAFT.talon.maxSpeed;
  assert.ok(err < 0.04, `settled at ${m.airspeed.toFixed(1)} vs max ${AIRCRAFT.talon.maxSpeed}`);
});

test('level flight at cruise holds altitude', () => {
  const m = spawn('skylark');
  m.airspeed = 70;
  const y0 = m.position.y;
  fly(m, 60 * 12, makeInput({ throttle: 1 }));
  const drift = Math.abs(m.position.y - y0);
  assert.ok(drift < 45, `altitude drifted ${drift.toFixed(1)} m in 12 s`);
});

test('gravity biases the energy equation: dive > level > climb', () => {
  // Measured from a trimmed state: with thrust and drag in balance, attitude is
  // the only variable left, so the comparison isolates the gravity term.
  // Mid power on purpose: near the top speed the drag wall compresses any gain,
  // so the interesting regime is the one the player actually races in.
  const trimmed = () => {
    const m = setPower(spawn('vector'), 0.5);
    m.airspeed = 80;
    fly(m, 60 * 60, makeInput({}));
    return m;
  };
  const base = trimmed().airspeed;
  // Establish the attitude first, then measure while holding it. Measuring during
  // the rotation averages in all the shallower angles and hides the effect.
  const run = (pitch) => {
    const m = trimmed();
    fly(m, 48, makeInput({ pitch: pitch * 2.2 }));
    const v0 = m.airspeed;
    fly(m, 60 * 2, makeInput({}));
    m.measuredFrom = v0;
    return m;
  };
  const dive = run(-0.22);
  const level = run(0);
  const climb = run(0.22);
  assert.ok(Math.abs(level.airspeed - base) < 3, `level flight should hold trim (${base.toFixed(1)} -> ${level.airspeed.toFixed(1)})`);
  assert.ok(dive.pitchAngle < -0.25, `dive attitude ${dive.pitchAngle.toFixed(2)} rad`);
  assert.ok(climb.pitchAngle > 0.25, `climb attitude ${climb.pitchAngle.toFixed(2)} rad`);
  assert.ok(dive.airspeed > level.airspeed + 4, `dive ${dive.airspeed.toFixed(1)} vs level ${level.airspeed.toFixed(1)}`);
  assert.ok(climb.airspeed < level.airspeed - 4, `climb ${climb.airspeed.toFixed(1)} vs level ${level.airspeed.toFixed(1)}`);
});

test('the throttle sets trim speed, so speed is controllable', () => {
  const settle = (power) => {
    const m = setPower(spawn('skylark'), power);
    m.airspeed = 60;
    fly(m, 60 * 60, makeInput({}));
    return m.airspeed;
  };
  const low = settle(0.3);
  const mid = settle(0.6);
  const full = settle(1);
  assert.ok(low < mid - 4, `30% power trimmed at ${low.toFixed(1)}, 60% at ${mid.toFixed(1)}`);
  assert.ok(mid < full - 4, `60% power trimmed at ${mid.toFixed(1)}, full at ${full.toFixed(1)}`);
  assert.ok(low < AIRCRAFT.skylark.maxSpeed * 0.8, `low power should stay well off the top speed (${low.toFixed(1)})`);
});

test('a steep dive converts altitude into speed', () => {
  const m = setPower(spawn('talon'), 0.6);
  m.airspeed = 90;
  const y0 = m.position.y;
  fly(m, 40, makeInput({ pitch: -0.6 }));   // establish the dive
  fly(m, 60 * 3, makeInput({ pitch: 0 }));  // hold it
  assert.ok(m.pitchAngle < -0.4, `dive attitude ${m.pitchAngle.toFixed(2)} rad`);
  assert.ok(m.position.y < y0 - 150, `should have lost altitude, lost ${(y0 - m.position.y).toFixed(0)} m`);
  assert.ok(m.airspeed > 120, `dive only reached ${m.airspeed.toFixed(1)} m/s from 90`);
});

test('a faster aircraft needs a wider turn', () => {
  const slow = spawn('skylark');
  const fast = spawn('meridian');
  slow.airspeed = AIRCRAFT.skylark.maxSpeed;
  fast.airspeed = AIRCRAFT.meridian.maxSpeed;
  // Hold a comparable bank on both, then compare heading change.
  for (const m of [slow, fast]) fly(m, 240, makeInput({ roll: 1, pitch: 0.25, throttle: 1 }));
  assert.ok(
    Math.abs(fast.heading) < Math.abs(slow.heading),
    `heavy jet turned ${fast.heading.toFixed(2)} rad, light sport ${slow.heading.toFixed(2)} rad`,
  );
});

test('slow flight stalls: authority collapses and the nose drops', () => {
  const m = setPower(spawn('skylark'), 0);
  m.airspeed = 8;
  const pitchBefore = m.pitchAngle;
  fly(m, 60, makeInput({ pitch: 1 })); // full back stick, no power
  assert.ok(m.stallFactor > 0.5, `stallFactor = ${m.stallFactor}`);
  assert.ok(m.velocity.y < -2, `should be sinking, vy = ${m.velocity.y.toFixed(2)}`);
  assert.ok(m.pitchAngle < pitchBefore + 0.25, `back stick should not hold the nose up when stalled (pitch ${m.pitchAngle.toFixed(2)})`);
});

test('stall is recoverable: speed returns and the aircraft flies again', () => {
  const m = setPower(spawn('skylark', { position: { y: 900 } }), 0);
  m.position.set(0, 900, 0);
  m.airspeed = 6;
  fly(m, 60, makeInput({ pitch: 1 }));                              // stalled, falling
  assert.ok(m.stallFactor > 0.5, 'precondition: should be stalled');
  fly(m, 60 * 8, makeInput({ throttle: 1, pitch: -0.2 }));          // power up, nose down
  assert.ok(m.stallFactor < 0.1, `stallFactor after recovery = ${m.stallFactor}`);
  assert.ok(m.airspeed > AIRCRAFT.skylark.stallSpeed, `airspeed = ${m.airspeed}`);
});

test('an aircraft stopped dead in the air can recover with the default assist', () => {
  // Regression guard: induced drag used to floor at its stall-speed value, which
  // let a powerful aircraft out-drag gravity and hang at zero airspeed forever.
  for (const id of ['skylark', 'meridian', 'wraith']) {
    const m = new FlightModel({ spec: structuredClone(AIRCRAFT[id]), bus, collider: flatCollider, assist: 'low' });
    m.reset({ position: { x: 0, y: 4000, z: 0 }, heading: 0 });
    m.position.set(0, 4000, 0);
    setPower(m, 0);
    m.airspeed = 0;
    fly(m, 60 * 14, makeInput({ pitch: -0.5 })); // nose down, no power at all
    assert.ok(m.airspeed > AIRCRAFT[id].stallSpeed,
      `${id} only recovered to ${m.airspeed.toFixed(1)} m/s (stall ${AIRCRAFT[id].stallSpeed})`);
  }
});

test('the recovery assist rolls an inverted aircraft upright', () => {
  const m = spawn('vector', { position: { y: 3000 } });
  m.position.set(0, 3000, 0);
  setPower(m, 0.6);
  // Roll onto its back and confirm it is genuinely inverted.
  fly(m, 200, makeInput({ roll: 1 }));
  assert.ok(m.up.y < -0.4, `precondition: should be inverted, up.y = ${m.up.y.toFixed(2)}`);
  const input = makeInput({});
  input.buttons.levelOut = true;
  fly(m, 60 * 5, input);
  assert.ok(m.up.y > 0.85, `should be upright again, up.y = ${m.up.y.toFixed(2)}`);
  assert.ok(Math.abs(m.pitchAngle) < 0.25, `nose should be near the horizon, pitch = ${m.pitchAngle.toFixed(2)}`);
});

test('turbo raises thrust and top speed', () => {
  const plain = spawn('talon');
  const boosted = spawn('talon');
  plain.airspeed = boosted.airspeed = 100;
  fly(plain, 60 * 20, makeInput({ throttle: 1 }));
  fly(boosted, 60 * 20, makeInput({ throttle: 1 }), 1 / 60, { active: true });
  assert.ok(boosted.airspeed > plain.airspeed * 1.1, `${boosted.airspeed.toFixed(1)} vs ${plain.airspeed.toFixed(1)}`);
});

test('airbrake sheds speed', () => {
  const m = setPower(spawn('vector'), 0.35);
  m.airspeed = 120;
  fly(m, 60 * 3, makeInput({ brake: true }));
  assert.ok(m.airspeed < 100, `airspeed = ${m.airspeed}`);
});

test('hard turns produce drift (momentum is preserved)', () => {
  const m = spawn('meridian');
  m.airspeed = 150;
  fly(m, 90, makeInput({ roll: 1, pitch: 0.3, throttle: 1 }));
  assert.ok(m.drift.length() > 1, `drift = ${m.drift.length().toFixed(2)}`);
});

test('high assist keeps the wings level without player input', () => {
  const m = new FlightModel({ spec: structuredClone(AIRCRAFT.skylark), bus, collider: flatCollider, assist: 'high' });
  m.reset({ position: { x: 0, y: 600, z: 0 }, heading: 0 });
  m.position.set(0, 600, 0);
  fly(m, 60, makeInput({ roll: 1, throttle: 1 }));
  const banked = Math.abs(m.bank);
  fly(m, 60 * 4, makeInput({ throttle: 1 }));
  assert.ok(Math.abs(m.bank) < banked * 0.5, `bank ${banked.toFixed(2)} -> ${Math.abs(m.bank).toFixed(2)}`);
});

test('takeoff: rotates off the runway at rotate speed', () => {
  const runway = { ...flatCollider, isRunway: () => true, runwayAlignment: () => 1 };
  const m = new FlightModel({ spec: structuredClone(AIRCRAFT.skylark), bus, collider: runway, assist: 'low' });
  m.reset({ position: { x: 0, y: 0, z: 0 }, heading: 0, grounded: true });
  m.position.set(0, 0, 0);
  assert.ok(m.grounded, 'should start on the ground');
  let airborne = false;
  const off = bus.on('flight:takeoff', () => { airborne = true; });
  for (let i = 0; i < 60 * 45 && !airborne; i++) {
    m.update(1 / 60, makeInput({ throttle: 1, pitch: m.airspeed > AIRCRAFT.skylark.rotateSpeed ? 1 : 0 }), null);
  }
  off();
  assert.ok(airborne, `never rotated; airspeed reached ${m.airspeed.toFixed(1)}`);
  assert.ok(!m.grounded, 'should be flying after rotation');
});

test('landing: a gentle touchdown on the runway is a landing, not a crash', () => {
  const runway = { ...flatCollider, isRunway: () => true, runwayAlignment: () => 1 };
  const m = new FlightModel({ spec: structuredClone(AIRCRAFT.skylark), bus, collider: runway, assist: 'off' });
  m.reset({ position: { x: 0, y: 120, z: 0 }, heading: 0 });
  m.position.set(0, 120, 0);
  setPower(m, 0.3);
  m.airspeed = AIRCRAFT.skylark.landingSpeed;
  let landed = null, impact = null;
  const offL = bus.on('flight:landed', (e) => { landed = e; });
  const offI = bus.on('flight:impact', (e) => { impact = e; });
  // Stand-in for a competent player: pitch for the descent rate, throttle for
  // the speed, then flare. Both controls matter, which is the point.
  const targetSpeed = AIRCRAFT.skylark.landingSpeed * 0.95;
  for (let i = 0; i < 60 * 90 && !landed && !impact; i++) {
    const agl = m.position.y - m.gearHeight;
    const targetVs = agl > 20 ? -4 : -1.1;
    const pitch = Math.max(-0.3, Math.min(0.3, (targetVs - m.velocity.y) * 0.09));
    const throttle = Math.max(-1, Math.min(1, (targetSpeed - m.airspeed) * 0.6));
    m.update(1 / 60, makeInput({ pitch, throttle }), null);
  }
  offL(); offI();
  assert.ok(landed, `expected a landing, got impact=${impact && impact.kind}`);
  assert.ok(m.grounded, 'should be rolling on the ground');
  assert.ok(landed.sink < 5.5, `touchdown sink ${landed.sink.toFixed(2)} m/s`);
});

test('landing gate: too fast a sink rate on the runway is a crash', () => {
  const runway = { ...flatCollider, isRunway: () => true, runwayAlignment: () => 1 };
  const m = new FlightModel({ spec: structuredClone(AIRCRAFT.skylark), bus, collider: runway, assist: 'off' });
  m.reset({ position: { x: 0, y: 40, z: 0 }, heading: 0 });
  m.position.set(0, 40, 0);
  setPower(m, 0.4);
  m.airspeed = AIRCRAFT.skylark.landingSpeed;
  let landed = null, impact = null;
  const offL = bus.on('flight:landed', (e) => { landed = e; });
  const offI = bus.on('flight:impact', (e) => { impact = e; });
  for (let i = 0; i < 60 * 30 && !landed && !impact; i++) {
    m.update(1 / 60, makeInput({ pitch: -0.25 }), null); // driven into the concrete
  }
  offL(); offI();
  assert.ok(impact, 'expected an impact');
  assert.ok(!landed, 'must not count as a landing');
  assert.equal(impact.kind, 'hard-landing');
});

test('flying into a wall is an impact whose severity scales with speed', () => {
  const wall = {
    ...flatCollider,
    sampleObstacle: () => ({
      penetration: 2,
      normal: { x: 0, y: 0, z: 1, clone: () => ({ x: 0, y: 0, z: 1 }) },
      point: { x: 0, y: 500, z: -100, clone: () => ({ x: 0, y: 500, z: -100 }) },
    }),
  };
  const hits = [];
  const offH = bus.on('flight:impact', (e) => hits.push(e));
  for (const speed of [30, 160]) {
    const m = new FlightModel({ spec: structuredClone(AIRCRAFT.talon), bus, collider: wall, assist: 'off' });
    m.reset({ position: { x: 0, y: 500, z: 0 }, heading: 0 });
    m.position.set(0, 500, 0);
    m.airspeed = speed;
    m._impactCooldown = 0;
    // Vector3-shaped normal needed by addScaledVector.
    m.update(1 / 60, makeInput({ throttle: 1 }), null);
  }
  offH();
  assert.equal(hits.length, 2, `expected 2 impacts, got ${hits.length}`);
  assert.ok(hits[1].severity > hits[0].severity, `${hits[1].severity} should exceed ${hits[0].severity}`);
});

test('a long frame cannot teleport the aircraft', () => {
  const m = spawn('wraith');
  m.airspeed = 200;
  const before = m.position.clone();
  m.update(2.0, makeInput({ throttle: 1 }), null); // simulated hitch
  const moved = m.position.distanceTo(before);
  assert.ok(moved < 200 * (1 / 20) + 5, `moved ${moved.toFixed(1)} m on a 2 s frame`);
});

console.log(`\n${passed} flight assertions passed\n`);
