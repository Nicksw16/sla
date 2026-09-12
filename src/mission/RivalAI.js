import * as THREE from 'three';
import { clamp, clamp01, damp, smoothstep } from '../core/MathUtils.js';
import { FlightModel } from '../flight/FlightModel.js';
import { TurboSystem } from '../flight/TurboSystem.js';
import { buildAircraft, animateAircraft } from '../flight/AircraftFactory.js';
import { getAircraft } from '../data/aircraft.js';
import { applyUpgrades } from '../data/upgrades.js';

/**
 * The rival pilot (spec §77, §85-86).
 *
 * Flies a real FlightModel with a real aircraft from the same catalogue the player
 * buys from, so it cannot cheat: no secret top speed, no free energy in corners, and
 * a turbo tank that runs dry (§86).
 *
 * Guidance is a racing line. The gates are strung onto a Catmull-Rom spline and the
 * rival chases a lookahead point that slides along it. Two earlier attempts are worth
 * recording because they both failed in instructive ways:
 *
 *   - Aiming straight at the next gate (pure pursuit) tail-chases. It arrives one to
 *     two ring radii off centre every time, and when it overshoots a gate it cannot
 *     out-turn, it orbits.
 *   - Aiming at a set-back point on each gate's inbound axis fixed the tight circuit
 *     and broke the long legs, and the tuning was chaotic across skill levels - a
 *     sign the loop was only marginally stable.
 *
 * A spline solves both: the target moves smoothly instead of jumping between
 * waypoints, progress along the curve is monotonic so orbiting is structurally
 * impossible, and because the curve interpolates the gate positions, flying the line
 * *is* flying through the rings.
 *
 * Skill scales lookahead (anticipation), bank limit, how much speed it gives up for a
 * corner, how it spends turbo, and the size of a bounded error signal that keeps its
 * line human.
 */
export class RivalAI {
  constructor({ scene, bus, collider, aircraftId = 'vector', skill = 0.65, name = 'V. KESTREL', paint = 'ember' }) {
    this.scene = scene;
    this.bus = bus;
    this.name = name;
    this.skill = clamp01(skill);

    const base = getAircraft(aircraftId);
    // Skill buys upgrades, exactly as it would for the player.
    const level = Math.round(this.skill * 3);
    this.spec = applyUpgrades(base, { engine: level, handling: level, stability: level, turbo: level, armor: 1 });

    // A silent bus: the rival's own impacts must not drive the player's HUD or score.
    const quiet = { emit() {}, on() { return () => {}; } };
    this.flight = new FlightModel({ spec: this.spec, bus: quiet, collider, assist: 'low' });
    this.turbo = new TurboSystem({ spec: this.spec, bus: quiet });
    this.mesh = buildAircraft(this.spec, paint);
    scene.add(this.mesh);

    this.route = [];
    this.target = 0;
    this.finished = false;
    this.lapTime = 0;
    this.progress = 0;

    this._input = {
      axes: { pitch: 0, roll: 0, yaw: 0, throttle: 0 },
      buttons: { turbo: false, brake: false, look: false, levelOut: false },
    };
    this._curve = null;
    this._gateU = [];
    this._u = 0;
    this._aim = new THREE.Vector3();
    this._local = new THREE.Vector3();
    this._invQ = new THREE.Quaternion();
    this._probe = new THREE.Vector3();
    this._errorPhase = Math.random() * 100;
    this._lastBank = 0;
    this._lastPitch = 0;
    this._bankRate = 0;
    this._pitchRate = 0;
  }

  setRoute(route, start) {
    this.route = route;
    this.target = 0;
    this.finished = false;
    this.lapTime = 0;
    this.progress = 0;
    this._u = 0;

    // The start point joins the curve so the line begins where the rival does.
    const points = [new THREE.Vector3(start.x, start.y, start.z)];
    for (const cp of route) points.push(new THREE.Vector3(cp.x, cp.y, cp.z));
    this._curve = new THREE.CatmullRomCurve3(points, false, 'catmullrom', 0.5);
    this._curveLength = Math.max(1, this._curve.getLength());
    // Curve parameter of each gate, used for monotonic progress.
    this._gateU = route.map((_, i) => (i + 1) / (points.length - 1));

    this.flight.reset({
      position: new THREE.Vector3(start.x, start.y, start.z),
      heading: start.heading ?? 0,
      airspeed: start.speed ?? this.spec.maxSpeed * 0.6,
    });
    this.turbo.reset(true);
    this.mesh.visible = true;
  }

  get position() {
    return this.flight.position;
  }

  /**
   * Walks the curve parameter forward to the point nearest the aircraft. Search is
   * forward-only, which is what makes progress monotonic and orbiting impossible.
   */
  _trackCurve() {
    const samples = 14;
    const window = 0.06;
    let bestU = this._u;
    let bestD = Infinity;
    for (let i = 0; i <= samples; i++) {
      const u = Math.min(1, this._u + (i / samples) * window);
      this._curve.getPoint(u, this._probe);
      const d = this._probe.distanceToSquared(this.flight.position);
      if (d < bestD) { bestD = d; bestU = u; }
    }
    this._u = bestU;
    this.progress = bestU;
  }

  /** Curvature of the line just ahead, used to decide how much speed to give up. */
  _lookaheadCurvature(u, span) {
    const a = this._curve.getPoint(Math.min(1, u), new THREE.Vector3());
    const b = this._curve.getPoint(Math.min(1, u + span), new THREE.Vector3());
    const c = this._curve.getPoint(Math.min(1, u + span * 2), new THREE.Vector3());
    const v1 = b.clone().sub(a);
    const v2 = c.clone().sub(b);
    if (v1.lengthSq() < 1e-6 || v2.lengthSq() < 1e-6) return 0;
    return clamp01((1 - v1.normalize().dot(v2.normalize())) * 0.5) * 2;
  }

  update(dt, elapsed) {
    if (this.finished || !this._curve) {
      this._syncMesh(dt);
      return;
    }
    this.lapTime += dt;
    this._trackCurve();

    // --- lookahead point on the racing line. Further ahead with speed, and further
    // still for a better pilot: anticipation is most of what skill means here.
    // Lookahead is a compromise: long enough to anticipate a corner, short enough
    // that it does not cut straight across one. On a circuit tighter than the
    // aircraft's own turn radius it will cut - which is what a real pilot does too.
    const lookaheadMetres = 80 + this.flight.airspeed * (0.6 + this.skill * 0.9);
    const aimU = Math.min(1, this._u + lookaheadMetres / this._curveLength);
    this._curve.getPoint(aimU, this._aim);

    // --- angular rates by finite difference, so the loops below can damp themselves
    const bankDelta = Math.atan2(Math.sin(this.flight.bank - this._lastBank), Math.cos(this.flight.bank - this._lastBank));
    this._bankRate = damp(this._bankRate, bankDelta / Math.max(dt, 1e-4), 18, dt);
    this._pitchRate = damp(this._pitchRate, (this.flight.pitchAngle - this._lastPitch) / Math.max(dt, 1e-4), 18, dt);
    this._lastBank = this.flight.bank;
    this._lastPitch = this.flight.pitchAngle;

    // --- aim point in the aircraft's frame
    this._invQ.copy(this.flight.quaternion).invert();
    this._local.copy(this._aim).sub(this.flight.position).applyQuaternion(this._invQ);
    const dist = this._local.length();
    if (dist > 1e-3) this._local.divideScalar(dist);
    else this._local.set(0, 0, -1);

    // --- bounded error so the line wanders a little the way a person's does (§85)
    this._errorPhase += dt;
    const sloppiness = (1 - this.skill) * 0.35;
    const errRoll = Math.sin(this._errorPhase * 0.83) * sloppiness;
    const errPitch = Math.cos(this._errorPhase * 0.61 + 1.4) * sloppiness * 0.5;

    // --- roll: bank proportional to bearing error, held by a PD loop
    const bearing = Math.atan2(this._local.x, -this._local.z);
    const maxBank = 0.6 + this.skill * 0.6;
    const desiredBank = clamp(bearing * 2.1, -maxBank, maxBank);
    this._input.axes.roll = clamp(
      (desiredBank - this.flight.bank) * 1.6 - this._bankRate * 0.42 + errRoll * 0.4, -1, 1,
    );

    // --- pitch: altitude error -> target vertical speed -> stick. Closing on
    // vertical speed keeps the aircraft's own lift response inside the loop;
    // commanding pitch angle from the elevation error porpoises instead.
    const altError = this._aim.y - this.flight.position.y;
    const maxVs = 20 + this.skill * 26;
    const desiredVs = clamp(altError * 0.4, -maxVs, maxVs);
    const bankCompensation = clamp(1 / Math.max(0.25, Math.cos(this.flight.bank)) - 1, 0, 1.6) * 0.3;
    let pitchCmd = clamp((desiredVs - this.flight.velocity.y) * 0.05, -0.9, 0.9)
      - this._pitchRate * 0.16 + bankCompensation + errPitch * 0.25;
    // Terrain avoidance always wins.
    const agl = this.flight.aboveGround;
    if (agl < 110) pitchCmd = Math.max(pitchCmd, smoothstep(110, 25, agl));
    this._input.axes.pitch = clamp(pitchCmd, -1, 1);

    // --- speed: give up some for the corner ahead, in proportion to how tight it is
    const curvature = this._lookaheadCurvature(this._u, Math.max(0.004, 260 / this._curveLength));
    const wantSpeed = clamp(1 - curvature * (0.55 - this.skill * 0.22), 0.34, 1);
    const speedFrac = this.flight.airspeed / this.spec.maxSpeed;
    this._input.axes.throttle = speedFrac < wantSpeed ? 1 : -0.7;
    this._input.buttons.brake = speedFrac > wantSpeed + 0.26;
    // Better pilots hold turbo for the straights instead of burning it on entry.
    const straight = curvature < 0.16 && Math.abs(bearing) < 0.35;
    this._input.buttons.turbo = straight && this.turbo.fraction > (0.85 - this.skill * 0.62);

    this.turbo.update(dt, this._input.buttons.turbo);
    this.flight.update(dt, this._input, this.turbo);

    this._advanceGates();
    this._syncMesh(dt);
  }

  /** Gates are counted off by curve position, so they can never be skipped or redone. */
  _advanceGates() {
    while (this.target < this._gateU.length && this._u >= this._gateU[this.target] - 0.002) {
      this.target++;
    }
    if (this._u >= 0.999 || this.target >= this.route.length) {
      this.target = this.route.length;
      if (!this.finished) {
        this.finished = true;
        this.bus.emit('rival:finished', { name: this.name, time: this.lapTime });
      }
    }
  }

  _syncMesh(dt) {
    this.mesh.position.copy(this.flight.position);
    this.mesh.quaternion.copy(this.flight.quaternion);
    animateAircraft(this.mesh, dt, this.flight.telemetry(), this.flight.control);
  }

  /** Positive metres means the rival is ahead of the player toward the next gate. */
  gapTo(playerTargetIndex, playerPosition) {
    const lead = this.target - playerTargetIndex;
    const cp = this.route[Math.min(this.target, this.route.length - 1)];
    if (!cp) return { lead, metres: 0 };
    const gate = new THREE.Vector3(cp.x, cp.y, cp.z);
    return { lead, metres: playerPosition.distanceTo(gate) - this.flight.position.distanceTo(gate) };
  }

  dispose() {
    this.scene.remove(this.mesh);
  }
}
