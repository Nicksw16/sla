import * as THREE from 'three';
import { clamp, clamp01, damp, smoothstep, moveTowards } from '../core/MathUtils.js';

const G = 9.81;

/**
 * Parasitic drag as a fraction of available thrust, against speed as a fraction
 * of the current maximum. Equals exactly 1 at x = 1.
 *
 * Mostly quadratic, because that is what maps the throttle lever onto speed in a
 * usable way: trim speed goes roughly as the square root of power, so a quarter
 * throttle really does sit at about half speed. A steeper curve was tried and
 * rejected - it made drag so cheap below the top speed that 30% throttle trimmed
 * at 80% of maximum and the lever became effectively binary. The small sixth-order
 * term firms up the last stretch so top speed feels earned.
 */
function parasiticDrag(x) {
  const x2 = x * x;
  return 0.85 * x2 + 0.15 * x2 * x2 * x2;
}

/**
 * Induced drag: the cost of making lift, which grows as speed falls toward the
 * stall. Without it the throttle has little authority over speed at approach pace
 * and landings become guesswork (spec §58).
 *
 * Expressed as an absolute deceleration rather than a share of thrust, which is
 * both closer to the real relationship (it scales with weight, not with the
 * engine) and necessary for safety: scaling it by thrust let a powerful aircraft
 * generate more low-speed drag than gravity could ever overcome, pinning it at
 * zero airspeed with no way out. The ceiling here stays below the 8.3 m/s^2 that
 * a vertical dive supplies, so a stall is always recoverable (§14, §146).
 */
const INDUCED_REF = 3.6; // m/s^2 of drag at exactly the stall speed
const GEAR_DRAG = 0.06;

function inducedDrag(airspeed, stallSpeed) {
  const r = airspeed / stallSpeed;
  if (r <= 0) return 0;
  // Above the stall the wing carries the whole weight, so induced drag falls as
  // 1/v^2. Below it the wing cannot make that much lift any more, so the drag it
  // costs falls away with it - which is what lets a dive out of a stall build
  // speed instead of hitting a drag floor gravity cannot push through.
  return INDUCED_REF * (r >= 1 ? 1 / (r * r) : r * r);
}

// Axis conventions, pinned by tests/flight.test.js:
//   forward = -Z, pitch up = +X, roll right = -Z, yaw right = -Y,
//   and a coordinated right turn is a rotation about world -Y.
const AX_PITCH = new THREE.Vector3(1, 0, 0);
const AX_ROLL = new THREE.Vector3(0, 0, -1);
const AX_YAW = new THREE.Vector3(0, -1, 0);
const WORLD_TURN = new THREE.Vector3(0, -1, 0);
const WORLD_UP = new THREE.Vector3(0, 1, 0);

export const ASSIST = {
  off:  { autoLevel: 0,    pitchLimit: 0,    stallGuard: 0,   sinkRelief: 0,    groundGuard: 0,   gustScale: 1 },
  low:  { autoLevel: 0.35, pitchLimit: 0.05, stallGuard: 0.4, sinkRelief: 0.2,  groundGuard: 0.3, gustScale: 0.8 },
  high: { autoLevel: 0.85, pitchLimit: 0.28, stallGuard: 0.9, sinkRelief: 0.55, groundGuard: 0.8, gustScale: 0.45 },
};

/**
 * Arcade-realistic flight model (spec §10-14).
 *
 * Design: airspeed is a scalar along the nose, and the aircraft turns by banking
 * the way a real one does (rate = g·tan(bank)/V). That single choice delivers most
 * of the spec's requirements for free — diving gains speed, climbing loses it,
 * fast aircraft need more room to corner, and slow flight becomes vague and then
 * unflyable. Momentum is layered on as a decaying drift vector so heading changes
 * cost something without ever making the aircraft unpredictable (§11, §146).
 *
 * Deliberately NOT simulated: per-surface aerodynamics, real stall hysteresis,
 * engine thermodynamics, wake turbulence. Those buy realism the player cannot
 * feel and cost control clarity (§4, §164).
 */
export class FlightModel {
  constructor({ spec, bus, collider, assist = 'low' }) {
    this.bus = bus;
    this.collider = collider;
    this.setSpec(spec);
    this.setAssist(assist);

    this.position = new THREE.Vector3(0, 300, 0);
    this.quaternion = new THREE.Quaternion();
    this.velocity = new THREE.Vector3();
    this.drift = new THREE.Vector3();
    this.sinkRate = 0;

    this.airspeed = 60;
    this.throttleCmd = 0.7;
    this.throttle = 0.7;
    this.control = { pitch: 0, roll: 0, yaw: 0 };
    this.brake = 0;

    this.grounded = false;
    this.gearDown = true;
    this.onRunway = false;
    this.groundHeight = 0;
    this.stallFactor = 0;
    this.gLoad = 1;
    this.bank = 0;
    this.pitchAngle = 0;
    this.heading = 0;
    this.turnRate = 0;
    this.turboActive = false;
    this.turboMultiplier = 1;
    this.alive = true;
    this.distanceFlown = 0;

    this._forward = new THREE.Vector3(0, 0, -1);
    this._right = new THREE.Vector3(1, 0, 0);
    this._up = new THREE.Vector3(0, 1, 0);
    this._prevForward = new THREE.Vector3(0, 0, -1);
    this._tmpQ = new THREE.Quaternion();
    this._tmpV = new THREE.Vector3();
    this._wobblePhase = 0;
    this._impactCooldown = 0;
    this._nearMissCooldown = 0;
    this._groundContactCooldown = 0;
    this._env = { wind: new THREE.Vector3(), gust: 0, turbulence: 0 };
  }

  setSpec(spec) {
    this.spec = spec;
    this.turboSpeedGain = spec.turboSpeedGain ?? 1 + (spec.turboMult - 1) * 0.32;
    this.gearHeight = Math.max(1.4, spec.model.wingspan * 0.16);
    this.hitRadius = Math.max(3.2, spec.model.wingspan * 0.42);
  }

  setAssist(level) {
    this.assistLevel = level in ASSIST ? level : 'low';
    this.assist = ASSIST[this.assistLevel];
  }

  setEnvironment(env) {
    if (env.wind) this._env.wind.copy(env.wind);
    this._env.gust = env.gust ?? 0;
    this._env.turbulence = env.turbulence ?? 0;
  }

  /** Places the aircraft, e.g. at mission start or after a checkpoint reset. */
  reset({ position, heading = 0, airspeed = null, grounded = false, pitch = 0 }) {
    this.position.copy(position);
    this.quaternion.identity();
    this.quaternion.multiply(this._tmpQ.setFromAxisAngle(WORLD_TURN, heading));
    if (pitch) this.quaternion.multiply(this._tmpQ.setFromAxisAngle(AX_PITCH, pitch));
    this.airspeed = airspeed ?? Math.max(this.spec.stallSpeed * 1.45, this.spec.maxSpeed * 0.5);
    if (grounded) this.airspeed = 0;
    this.throttleCmd = grounded ? 0 : 0.75;
    this.throttle = this.throttleCmd;
    this.velocity.set(0, 0, 0);
    this.drift.set(0, 0, 0);
    this.sinkRate = 0;
    this.control.pitch = 0;
    this.control.roll = 0;
    this.control.yaw = 0;
    this.brake = 0;
    this.grounded = grounded;
    this.gearDown = grounded;
    this.stallFactor = 0;
    this.alive = true;
    this._impactCooldown = 0.5;
    this._updateBasis();
    this._prevForward.copy(this._forward);
  }

  _updateBasis() {
    this._forward.set(0, 0, -1).applyQuaternion(this.quaternion);
    this._right.set(1, 0, 0).applyQuaternion(this.quaternion);
    this._up.set(0, 1, 0).applyQuaternion(this.quaternion);
    this.bank = Math.atan2(-this._right.y, this._up.y);
    this.pitchAngle = Math.asin(clamp(this._forward.y, -1, 1));
    this.heading = Math.atan2(this._forward.x, -this._forward.z);
  }

  get forward() { return this._forward; }
  get right() { return this._right; }
  get up() { return this._up; }
  get speedKmh() { return this.airspeed * 3.6; }
  get altitude() { return this.position.y; }
  get aboveGround() { return this.position.y - this.groundHeight; }

  update(dt, input, turbo) {
    if (!this.alive) return;
    dt = Math.min(dt, 1 / 20); // a long frame must never teleport the aircraft through a wall

    const spec = this.spec;
    this._impactCooldown = Math.max(0, this._impactCooldown - dt);
    this._nearMissCooldown = Math.max(0, this._nearMissCooldown - dt);
    this._groundContactCooldown = Math.max(0, this._groundContactCooldown - dt);

    this.turboActive = !!turbo?.active;
    this.turboMultiplier = this.turboActive ? spec.turboMult : 1;

    // ---- throttle -------------------------------------------------------
    // A lever the player holds a position on (a touch throttle) sets the command
    // directly; a key or a trigger moves it at a rate.
    if (input.throttleTarget != null) {
      this.throttleCmd = clamp(input.throttleTarget, 0, 1);
    } else {
      this.throttleCmd = clamp(this.throttleCmd + input.axes.throttle * dt * 0.9, 0, 1);
    }
    if (this.turboActive) this.throttleCmd = Math.max(this.throttleCmd, 0.85);
    this.throttle = damp(this.throttle, this.throttleCmd, 4.2, dt);
    this.brake = damp(this.brake, input.buttons.brake ? 1 : 0, 9, dt);

    // ---- control surfaces (rate-limited: the pilot asks, the airframe answers)
    const resp = spec.responsiveness;
    this.control.pitch = damp(this.control.pitch, input.axes.pitch, resp, dt);
    this.control.roll = damp(this.control.roll, input.axes.roll, resp * 1.15, dt);
    this.control.yaw = damp(this.control.yaw, input.axes.yaw, resp * 0.8, dt);

    this._prevForward.copy(this._forward);

    if (this.grounded) {
      this._updateGround(dt, input);
    } else {
      this._updateAir(dt, input);
    }

    this._updateBasis();
    this._resolveCollisions(dt);
    this._checkProximity(dt);

    this.distanceFlown += this.velocity.length() * dt;
  }

  // ---------------------------------------------------------------- airborne
  _updateAir(dt, input) {
    const spec = this.spec;
    const assist = this.assist;

    // --- airspeed: thrust vs drag, plus gravity along the flight path.
    // The gravity term is what makes a dive fast and a climb expensive (§66).
    // Turbo raises both the available thrust and the speed the drag wall sits at.
    const vMaxEff = spec.maxSpeed * (this.turboActive ? this.turboSpeedGain : 1);
    const maxThrust = spec.thrust * this.turboMultiplier;
    const thrustAcc = maxThrust * this.throttle;
    // Manoeuvring costs drag: deflected surfaces and a banked wing both bleed speed.
    const manoeuvre = 1 + Math.abs(this.control.pitch) * 0.34 + Math.abs(Math.sin(this.bank)) * 0.26;
    // The parasitic share is trimmed by whatever induced drag remains at top
    // speed, so full throttle still settles exactly on the catalogue figure.
    const inducedAtMax = inducedDrag(vMaxEff, spec.stallSpeed);
    const parasiticShare = Math.max(0.25, 1 - inducedAtMax / maxThrust);
    const gearPenalty = this.gearDown && spec.model.gear !== 'fixed' ? maxThrust * GEAR_DRAG : 0;
    const dragAcc =
      (maxThrust * parasiticShare * parasiticDrag(this.airspeed / vMaxEff) +
        inducedDrag(this.airspeed, spec.stallSpeed) +
        gearPenalty) * manoeuvre;
    const gravAcc = G * -this._forward.y * 0.85;
    const brakeAcc = this.brake * spec.brakeStrength * (0.3 + 0.7 * clamp01(this.airspeed / spec.maxSpeed));
    this.airspeed = clamp(
      this.airspeed + (thrustAcc - dragAcc + gravAcc - brakeAcc) * dt,
      0, spec.maxSpeed * 1.6,
    );

    // --- control authority falls away with airspeed; never to zero, or the
    // player could not recover and the failure would stop being their fault (§146).
    // Measured against the relative wind: an aircraft falling out of the sky has
    // air moving over its surfaces even with no forward speed at all, which is
    // precisely what lets a stall recovery work.
    const relativeWind = Math.hypot(this.airspeed, Math.max(0, -this.velocity.y) * 0.8);
    const speedAuth = smoothstep(spec.stallSpeed * 0.3, spec.stallSpeed * 1.12, relativeWind);
    this.stallFactor = 1 - speedAuth;
    const authority = 0.12 + 0.88 * speedAuth;

    let pitchCmd = this.control.pitch;
    let rollCmd = this.control.roll;

    // --- assists. They shape the *command*, never the physics, so a player who
    // turns them off is flying the same aircraft (§119-120).
    if (assist.pitchLimit > 0) {
      const limit = 1 - assist.pitchLimit;
      const steep = smoothstep(0.7, 1.25, Math.abs(this.pitchAngle));
      pitchCmd *= 1 - steep * assist.pitchLimit;
      pitchCmd = clamp(pitchCmd, -limit - 0.2, limit + 0.2);
    }
    if (assist.autoLevel > 0 && Math.abs(this.control.roll) < 0.12) {
      const levelStrength = assist.autoLevel * spec.stability * 1.6;
      rollCmd += clamp(-this.bank * levelStrength, -1, 1);
    }
    if (assist.stallGuard > 0 && this.stallFactor > 0.3 && pitchCmd > 0) {
      pitchCmd *= 1 - assist.stallGuard * smoothstep(0.3, 0.8, this.stallFactor);
    }
    // --- explicit recovery assist (the level-out key). Available at every assist
    // level, because an inverted aircraft is the one situation where the correct
    // input is the opposite of the obvious one: nose-down stick on your back
    // pitches you further into the ground. Rolling upright has to come first, so
    // pitch authority is withheld until the wings are the right way up.
    if (input.buttons.levelOut) {
      rollCmd = clamp(-this.bank * 1.8, -1, 1);
      const uprightness = clamp01(this._up.y);
      pitchCmd = clamp(-this.pitchAngle * 1.6, -1, 1) * uprightness;
    }

    if (assist.groundGuard > 0) {
      // Nose-up nudge when low and sinking. Scaled by how fast the ground is
      // approaching, so it is invisible in normal low-level flight.
      const agl = this.aboveGround;
      const danger = smoothstep(160, 35, agl) * smoothstep(-2, -14, this.velocity.y);
      if (danger > 0) pitchCmd = Math.max(pitchCmd, danger * assist.groundGuard);
    }

    // --- angular rates
    let pitchRate = pitchCmd * spec.pitchRate * authority;
    let rollRate = rollCmd * spec.rollRate * authority;
    let yawRate = this.control.yaw * spec.yawRate * authority;

    // --- stall: the aircraft wallows, and the nose is dragged toward wherever it
    // is actually going. That weathercocking is what turns a stall into a dive,
    // a dive into speed, and speed back into control (§14).
    let weathercock = 0;
    if (this.stallFactor > 0.3) {
      const s = smoothstep(0.3, 1, this.stallFactor) * (1 - assist.stallGuard * 0.5);
      this._wobblePhase += dt * 7;
      weathercock = s;
      rollRate += Math.sin(this._wobblePhase) * s * 0.7;
      yawRate += Math.cos(this._wobblePhase * 0.7) * s * 0.25;
    }

    // --- gust / turbulence disturbance, resisted by stability (§64)
    const gust = this._env.gust * this.assist.gustScale;
    if (gust > 0.001) {
      const resist = 1 - spec.stability * 0.75;
      this._wobblePhase += dt * 3.1;
      rollRate += Math.sin(this._wobblePhase * 1.7) * gust * resist * 0.9;
      pitchRate += Math.cos(this._wobblePhase * 1.3) * gust * resist * 0.5;
    }

    // --- integrate orientation (local axes, then the world-frame turn)
    this.quaternion.multiply(this._tmpQ.setFromAxisAngle(AX_PITCH, pitchRate * dt));
    this.quaternion.multiply(this._tmpQ.setFromAxisAngle(AX_ROLL, rollRate * dt));
    this.quaternion.multiply(this._tmpQ.setFromAxisAngle(AX_YAW, yawRate * dt));

    // Coordinated turn: the real reason banking changes heading.
    const bankForTurn = clamp(this.bank, -1.45, 1.45);
    this.turnRate = (G * Math.tan(bankForTurn) / Math.max(this.airspeed, 22)) * spec.turnGain * authority;
    this.turnRate = clamp(this.turnRate, -1.6, 1.6);
    this.quaternion.premultiply(this._tmpQ.setFromAxisAngle(WORLD_TURN, this.turnRate * dt));

    if (weathercock > 0 && this.velocity.lengthSq() > 4) {
      this._alignToFlightPath(weathercock * 2.6 * dt);
    }

    this.quaternion.normalize();
    this._updateBasis();

    // --- lift deficit -> vertical sink. Level and fast means zero sink; slow or
    // hard-banked means the aircraft starts falling out of the sky.
    const liftCapacity = (this.airspeed * this.airspeed) / (spec.stallSpeed * spec.stallSpeed);
    const bankLoss = 0.35 + 0.65 * Math.max(0, Math.cos(this.bank));
    const liftEff = Math.min(1 + spec.liftBonus, liftCapacity) * bankLoss;
    let sinkAcc = G * (liftEff - 1);
    if (sinkAcc < 0) sinkAcc *= 1 - this.assist.sinkRelief;
    this.sinkRate = clamp(damp(this.sinkRate + sinkAcc * dt, 0, 0.75, dt), -72, 26);

    // --- momentum: the old velocity direction survives a heading change (§11)
    const headingChange = this._tmpV.copy(this._prevForward).sub(this._forward);
    this.drift.addScaledVector(headingChange, this.airspeed * spec.inertia);
    const keep = Math.exp(-dt / (0.34 + spec.inertia * 0.95));
    this.drift.multiplyScalar(keep);
    const driftCap = this.airspeed * 0.55;
    if (this.drift.lengthSq() > driftCap * driftCap) this.drift.setLength(driftCap);

    // --- assemble velocity and integrate position
    this.velocity.copy(this._forward).multiplyScalar(this.airspeed);
    this.velocity.add(this.drift);
    this.velocity.y += this.sinkRate;
    this.velocity.addScaledVector(this._env.wind, 1 - spec.stability * 0.35);
    this.position.addScaledVector(this.velocity, dt);

    // Felt g-load, used by the camera and the HUD.
    const centripetal = Math.abs(this.turnRate) * this.airspeed / G;
    this.gLoad = damp(this.gLoad, Math.hypot(1, centripetal) + this.control.pitch * 0.4, 6, dt);

    // Landing gear retracts once clear of the ground (cosmetic but readable).
    const wantGear = this.aboveGround < 220 || this.airspeed < spec.rotateSpeed * 1.2;
    this.gearDown = spec.model.gear === 'fixed' ? true : wantGear;

    this.groundHeight = this.collider?.groundHeight(this.position.x, this.position.z) ?? 0;
    this._checkGroundContact(dt);
  }

  /**
   * Rotates the nose toward the current flight path by the given fraction.
   * Used only while stalled: it is the aerodynamic tendency that makes a stalled
   * aircraft end up pointing at the ground instead of tumbling in place.
   */
  _alignToFlightPath(amount) {
    const velDir = this._tmpV.copy(this.velocity).normalize();
    const dot = clamp(this._forward.dot(velDir), -1, 1);
    const angle = Math.acos(dot);
    if (angle < 1e-3) return;
    const axis = new THREE.Vector3().crossVectors(this._forward, velDir);
    if (axis.lengthSq() < 1e-8) return;
    axis.normalize();
    this.quaternion.premultiply(
      this._tmpQ.setFromAxisAngle(axis, Math.min(angle, angle * clamp01(amount))),
    );
  }

  // ------------------------------------------------------------------ on ground
  _updateGround(dt, input) {
    const spec = this.spec;
    this.groundHeight = this.collider?.groundHeight(this.position.x, this.position.z) ?? 0;
    this.stallFactor = 0;
    this.sinkRate = 0;
    this.gearDown = true;

    const rolling = 2.6 + this.brake * spec.brakeStrength * 1.5;
    const thrustAcc = spec.thrust * this.throttle * this.turboMultiplier * 0.92;
    const rollDrag = spec.thrust * parasiticDrag(this.airspeed / spec.maxSpeed) * 0.55;
    this.airspeed = clamp(this.airspeed + (thrustAcc - rolling - rollDrag) * dt, 0, spec.maxSpeed);

    // Nose-wheel steering: strong when slow, fades out as the rudder takes over.
    const steerAuth = clamp01(1 - this.airspeed / (spec.rotateSpeed * 1.4));
    const steer = this.control.yaw * (0.5 + steerAuth * 0.9) * clamp01(this.airspeed / 8);
    this.quaternion.premultiply(this._tmpQ.setFromAxisAngle(WORLD_TURN, steer * dt));

    // Settle attitude flat on the wheels.
    this._updateBasis();
    const levelPitch = moveTowards(this.pitchAngle, 0.02, 1.4 * dt);
    const levelBank = moveTowards(this.bank, 0, 2.2 * dt);
    this.quaternion.identity()
      .multiply(this._tmpQ.setFromAxisAngle(WORLD_TURN, this.heading))
      .multiply(this._tmpQ.setFromAxisAngle(AX_PITCH, levelPitch))
      .multiply(this._tmpQ.setFromAxisAngle(AX_ROLL, levelBank));
    this._updateBasis();

    // Rotate and fly: enough speed plus back pressure on the stick (§59).
    if (this.airspeed >= spec.rotateSpeed && this.control.pitch > 0.2) {
      this.grounded = false;
      this.sinkRate = 1.5;
      this.quaternion.multiply(this._tmpQ.setFromAxisAngle(AX_PITCH, 0.1));
      this.bus?.emit('flight:takeoff', { speed: this.airspeed, position: this.position.clone() });
    }

    this.velocity.copy(this._forward).multiplyScalar(this.airspeed);
    this.velocity.y = 0;
    this.position.addScaledVector(this.velocity, dt);
    this.position.y = this.groundHeight + this.gearHeight;
    this.drift.set(0, 0, 0);
    this.gLoad = 1;

    // Rolling off the paved surface at speed is a crash, not a scenic detour.
    this.onRunway = this.collider?.isRunway?.(this.position.x, this.position.z) ?? false;
    if (!this.onRunway && this.airspeed > spec.landingSpeed * 0.55 && this._groundContactCooldown <= 0) {
      this._groundContactCooldown = 1;
      this._emitImpact({
        severity: clamp01(this.airspeed / spec.maxSpeed) * 0.55,
        point: this.position.clone(),
        normal: WORLD_UP.clone(),
        kind: 'overrun',
      });
      this.airspeed *= 0.55;
    }
  }

  // --------------------------------------------------- ground contact from air
  _checkGroundContact(dt) {
    const floor = this.groundHeight + this.gearHeight;
    if (this.position.y > floor) return;
    if (this._groundContactCooldown > 0) return;

    const spec = this.spec;
    const sink = -this.velocity.y;
    const onRunway = this.collider?.isRunway?.(this.position.x, this.position.z) ?? false;
    const headingOk = onRunway ? (this.collider?.runwayAlignment?.(this.heading) ?? 1) > 0.9 : false;

    const gentle =
      onRunway &&
      headingOk &&
      this.gearDown &&
      sink < 5.5 &&
      Math.abs(this.bank) < 0.24 &&
      this.pitchAngle > -0.14 &&
      this.pitchAngle < 0.3 &&
      this.airspeed < spec.landingSpeed * 1.3;

    this.position.y = floor;
    this._groundContactCooldown = 0.35;

    if (gentle) {
      this.grounded = true;
      this.sinkRate = 0;
      this.velocity.y = 0;
      this.drift.set(0, 0, 0);
      // Quality: 1.0 is a feather-light touchdown on speed.
      const quality = clamp01(1 - sink / 5.5) * 0.6 + clamp01(1 - Math.abs(this.bank) / 0.24) * 0.4;
      this.bus?.emit('flight:landed', {
        quality, sink, speed: this.airspeed, position: this.position.clone(),
      });
      return;
    }

    // Not a landing: how bad depends on how hard and how fast.
    const sinkSeverity = clamp01((sink - 3) / 26);
    const speedSeverity = clamp01(this.airspeed / spec.maxSpeed) * 0.6;
    const severity = clamp01(Math.max(sinkSeverity, sinkSeverity * 0.4 + speedSeverity));
    this._emitImpact({
      severity,
      point: this.position.clone(),
      normal: WORLD_UP.clone(),
      kind: onRunway ? 'hard-landing' : 'terrain',
    });

    if (severity < 0.55) {
      // Survivable scrape: bounce, bleed energy, stay flyable.
      this.velocity.y = Math.abs(this.velocity.y) * 0.25 + 3;
      this.sinkRate = 4;
      this.airspeed *= 1 - severity * 0.5;
      this.position.y = floor + 1.2;
    } else {
      this.airspeed *= 0.3;
      this.sinkRate = 0;
    }
  }

  // ------------------------------------------------------------ obstacle hits
  _resolveCollisions(dt) {
    if (!this.collider?.sampleObstacle) return;
    const hit = this.collider.sampleObstacle(this.position, this.hitRadius);
    if (!hit) return;

    // Push out of the obstacle first, so a single hit cannot become a stuck loop.
    this.position.addScaledVector(hit.normal, hit.penetration + 0.6);

    if (this._impactCooldown > 0) return;

    // Glancing angles hurt far less than flying straight into a wall (§45).
    const closing = Math.max(0, -this._forward.dot(hit.normal));
    const speedFrac = clamp01(this.airspeed / this.spec.maxSpeed);
    const severity = clamp01(speedFrac * (0.35 + 0.65 * closing) * 1.25);

    // `ref` is whatever the collider registered behind that box - a structural module,
    // for anything that can come apart - and the heading is what turns a hit into a
    // direction rather than a magnitude. Neither means anything here; both are what
    // let the world localise the damage.
    this._emitImpact({
      severity,
      point: hit.point,
      normal: hit.normal,
      direction: this._forward.clone(),
      ref: hit.ref ?? null,
      kind: 'obstacle',
    });

    this.airspeed *= 1 - clamp01(severity) * 0.55;
    this.drift.addScaledVector(hit.normal, this.airspeed * 0.35 + 6);
    this.sinkRate -= severity * 6;
    // A knock also upsets the attitude — being hit should cost you your line.
    const kick = severity * 0.7;
    this.quaternion.multiply(this._tmpQ.setFromAxisAngle(AX_ROLL, (Math.random() - 0.5) * kick));
    this.quaternion.multiply(this._tmpQ.setFromAxisAngle(AX_PITCH, (Math.random() - 0.5) * kick * 0.6));
    this._impactCooldown = 0.32;
  }

  _emitImpact(info) {
    this.bus?.emit('flight:impact', {
      ...info,
      speed: this.airspeed,
      mass: this.spec.mass,
      armor: this.spec.armor,
    });
  }

  /** Near misses: the reward for flying close to things on purpose (§42). */
  _checkProximity(dt) {
    if (!this.collider?.proximity) return;
    if (this._nearMissCooldown > 0 || this.grounded) return;
    if (this.airspeed < this.spec.stallSpeed * 1.1) return;
    const p = this.collider.proximity(this.position, 34);
    if (!p || p.distance > 30) return;
    this._nearMissCooldown = 0.45;
    this.bus?.emit('flight:nearmiss', {
      distance: p.distance,
      speed: this.airspeed,
      kind: p.kind ?? 'building',
      position: this.position.clone(),
    });
  }

  /** Snapshot for HUD, audio, camera and score — read-only by contract. */
  telemetry() {
    return {
      position: this.position,
      quaternion: this.quaternion,
      velocity: this.velocity,
      speed: this.airspeed,
      speedKmh: this.airspeed * 3.6,
      speedFrac: clamp01(this.airspeed / this.spec.maxSpeed),
      altitude: this.position.y,
      aboveGround: this.aboveGround,
      verticalSpeed: this.velocity.y,
      bank: this.bank,
      pitch: this.pitchAngle,
      heading: this.heading,
      throttle: this.throttle,
      stall: this.stallFactor,
      gLoad: this.gLoad,
      grounded: this.grounded,
      gearDown: this.gearDown,
      turbo: this.turboActive,
      turnRate: this.turnRate,
    };
  }
}
