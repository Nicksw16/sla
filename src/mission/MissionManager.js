import * as THREE from 'three';
import { MISSION_BY_ID, gradeMission } from '../data/missions.js';
import { RivalAI } from './RivalAI.js';

/**
 * Mission lifecycle (spec §36-39, §46-47, §110).
 *
 * One state machine, one owner of the rules. Every mission type in the catalogue is
 * expressed as a combination of a route, a clock, and a small set of rule flags
 * rather than as its own subclass — which is what lets "storm, at night, under a
 * bridge, against a rival" exist without any new code (§37).
 */
export const MISSION_STATE = {
  IDLE: 'idle',
  COUNTDOWN: 'countdown',
  RUNNING: 'running',
  SUCCESS: 'success',
  FAILED: 'failed',
};

const COUNTDOWN_SECONDS = 3;

export class MissionManager {
  constructor({ bus, world, checkpoints, score, flight, turbo, damage, tricks, scene }) {
    this.bus = bus;
    this.world = world;
    this.checkpoints = checkpoints;
    this.score = score;
    this.flight = flight;
    this.turbo = turbo;
    this.damage = damage;
    this.tricks = tricks;
    this.scene = scene;

    this.state = MISSION_STATE.IDLE;
    this.mission = null;
    this.time = 0;
    this.timeRemaining = 0;
    this.countdown = 0;
    this.rival = null;
    this.freeFlight = false;
    this.result = null;

    this._landed = null;
    this._tookOff = false;
    this._violation = null;
    this._violationTimer = 0;
    this._lastCheckpointIndex = 0;
    this._resetsUsed = 0;
    this._finishing = false;

    this._unsubs = [
      bus.on('checkpoint:passed', (e) => this._onCheckpoint(e)),
      bus.on('checkpoint:routeComplete', () => this._onRouteComplete()),
      bus.on('flight:landed', (e) => { this._landed = e; }),
      bus.on('flight:takeoff', () => { this._tookOff = true; }),
      bus.on('damage:destroyed', () => this._onDestroyed()),
    ];
  }

  get isActive() {
    return this.state === MISSION_STATE.RUNNING || this.state === MISSION_STATE.COUNTDOWN;
  }

  get hasTimeLimit() {
    return !!this.mission?.timeLimit;
  }

  /** Free flight: the world, no clock, no route (spec §57). */
  startFreeFlight({ weather = 'clear', hour = 14, spawn = null, timeScale = 40 } = {}) {
    this._teardownRival();
    this.mission = null;
    this.freeFlight = true;
    this.result = null;
    this.state = MISSION_STATE.RUNNING;
    this.time = 0;
    this.timeRemaining = 0;
    this.checkpoints.clear();
    this.score.reset();
    this.score.enabled = true;
    this.damage.reset();
    this.tricks.reset();
    this.turbo.reset(true);
    this.world.setConditions({ weather, hour, instant: true, timeScale });

    const start = spawn ?? { x: 600, y: 520, z: 1600, heading: Math.PI * 0.85, speed: null };
    this.flight.reset({
      position: new THREE.Vector3(start.x, start.y, start.z),
      heading: start.heading ?? 0,
      airspeed: start.speed ?? undefined,
    });
    this.bus.emit('mission:start', { freeFlight: true, name: 'FREE FLIGHT' });
  }

  /** Begins a mission: conditions, spawn, route, rival, countdown. */
  start(missionId, { assist = 'low' } = {}) {
    const mission = MISSION_BY_ID[missionId];
    if (!mission) {
      console.warn(`[MissionManager] unknown mission "${missionId}"`);
      return false;
    }
    this._teardownRival();

    this.mission = mission;
    this.freeFlight = false;
    this.result = null;
    this.time = 0;
    this.timeRemaining = mission.timeLimit ?? 0;
    this.countdown = COUNTDOWN_SECONDS;
    this.state = MISSION_STATE.COUNTDOWN;
    this._landed = null;
    this._tookOff = false;
    this._violation = null;
    this._violationTimer = 0;
    this._lastCheckpointIndex = 0;
    this._resetsUsed = 0;
    this._finishing = false;

    this.world.setConditions({
      weather: mission.conditions.weather,
      hour: mission.conditions.hour,
      instant: true,
      timeScale: 0,
    });

    this.flight.setAssist(assist);
    this.flight.reset({
      position: new THREE.Vector3(mission.start.x, mission.start.y, mission.start.z),
      heading: mission.start.heading ?? 0,
      airspeed: mission.start.speed ?? null,
      grounded: !!mission.start.grounded,
    });

    this.checkpoints.load(mission.route);
    this.score.reset();
    // Points only start counting when the clock does.
    this.score.enabled = false;
    this.damage.reset();
    this.tricks.reset();
    this.turbo.reset(true);

    if (mission.rules?.rival) {
      this.rival = new RivalAI({
        scene: this.scene,
        bus: this.bus,
        collider: this.world,
        ...mission.rules.rival,
      });
      this.rival.setRoute(mission.route, mission.start);
    }

    this.bus.emit('mission:start', {
      id: mission.id, name: mission.name, type: mission.type,
      objective: this._objectiveText(), tip: mission.tip,
      checkpoints: mission.route.length, timeLimit: mission.timeLimit,
      rival: this.rival?.name ?? null,
    });
    return true;
  }

  _objectiveText() {
    const m = this.mission;
    if (!m) return 'Fly.';
    if (m.rules?.requireTakeoff) return `Take off and clear ${m.route.length} departure gates`;
    if (m.rules?.requireLanding) return `Fly the approach, then land on the runway`;
    if (m.rules?.rival) return `Beat ${m.rules.rival.name} through ${m.route.length} gates`;
    if (m.type === 'AIR SHOW') return `Score ${(m.stars.score?.[1] ?? 20000).toLocaleString()} through ${m.route.length} gates`;
    return `Fly ${m.route.length} checkpoints${m.timeLimit ? ` inside ${m.timeLimit}s` : ''}`;
  }

  _onCheckpoint(e) {
    if (this.state !== MISSION_STATE.RUNNING) return;
    this._lastCheckpointIndex = e.index;
  }

  _onRouteComplete() {
    if (this.state !== MISSION_STATE.RUNNING) return;
    // Landing missions are not over at the last gate — you still have to land it.
    if (this.mission?.rules?.requireLanding && !this._landed) {
      this.bus.emit('mission:objective', {
        text: 'NOW LAND ON THE RUNWAY',
        objective: 'Touch down on runway 09 — gently, wings level',
      });
      return;
    }
    this._succeed();
  }

  _onDestroyed() {
    if (this.state !== MISSION_STATE.RUNNING) return;
    this._fail('AIRCRAFT DESTROYED');
  }

  /**
   * Recovery from a crash: put the player back at the last gate rather than ending
   * the run (spec §46). Costs time and the combo, which is punishment enough.
   */
  resetToCheckpoint() {
    if (!this.isActive || this.freeFlight) return false;
    const index = Math.max(0, this._lastCheckpointIndex);
    const cp = this.mission.route[index] ?? this.mission.route[0];
    const next = this.mission.route[index + 1] ?? cp;
    const heading = Math.atan2(next.x - cp.x, -(next.z - cp.z));

    this._resetsUsed++;
    this.checkpoints.rewindTo(Math.min(index + 1, this.mission.route.length - 1));
    this.flight.reset({
      position: new THREE.Vector3(cp.x, cp.y + 20, cp.z),
      heading,
      airspeed: Math.max(this.flight.spec.stallSpeed * 1.5, this.flight.spec.maxSpeed * 0.55),
    });
    this.damage.repair(35);
    this.turbo.reset(false);
    this.score.onDamage({ damage: 0 }); // breaks the combo without a score penalty
    this.bus.emit('mission:reset', { index, resets: this._resetsUsed });
    return true;
  }

  restart() {
    if (this.freeFlight) return this.startFreeFlight();
    if (this.mission) return this.start(this.mission.id, { assist: this.flight.assistLevel });
    return false;
  }

  abort() {
    this._teardownRival();
    this.state = MISSION_STATE.IDLE;
    this.mission = null;
    this.freeFlight = false;
    this.checkpoints.clear();
    this.score.enabled = false;
  }

  update(dt) {
    if (this.state === MISSION_STATE.COUNTDOWN) {
      this.countdown -= dt;
      this.bus.emit('mission:countdown', { remaining: Math.max(0, this.countdown) });
      if (this.countdown <= 0) {
        this.state = MISSION_STATE.RUNNING;
        this.score.enabled = true;
        this.bus.emit('mission:go', {});
      }
      return;
    }
    if (this.state !== MISSION_STATE.RUNNING) return;

    this.time += dt;
    if (this.mission?.timeLimit) {
      this.timeRemaining = Math.max(0, this.mission.timeLimit - this.time);
      if (this.timeRemaining <= 0) {
        this._fail('OUT OF TIME');
        return;
      }
    }

    if (this.rival) this.rival.update(dt, this.time);
    if (!this.freeFlight) this._checkRules(dt);

    // Takeoff missions fail if you never actually leave the ground.
    if (this.mission?.rules?.requireTakeoff && !this._tookOff && this.time > 40) {
      this._fail('FAILED TO GET AIRBORNE');
    }
  }

  /** Altitude ceilings and floors, with a grace period before they bite (§111). */
  _checkRules(dt) {
    const rules = this.mission?.rules ?? {};
    const alt = this.flight.position.y;
    let violation = null;

    if (rules.maxAltitude && alt > rules.maxAltitude) violation = 'TOO HIGH — GET BACK DOWN';
    if (rules.minAltitude && alt < rules.minAltitude) violation = 'TOO LOW — CLIMB';

    if (violation) {
      this._violationTimer += dt;
      if (this._violation !== violation) {
        this._violation = violation;
        this.bus.emit('mission:warning', { text: violation });
      }
      if (this._violationTimer > 6) this._fail(violation.split(' —')[0]);
    } else if (this._violation) {
      this._violation = null;
      this._violationTimer = 0;
      this.bus.emit('mission:warning', { text: null });
    }
  }

  _succeed() {
    if (this._finishing) return;
    this._finishing = true;
    this.state = MISSION_STATE.SUCCESS;

    const beatRival = this.rival ? (!this.rival.finished || this.rival.lapTime > this.time) : false;
    const summary = this.score.finalise({
      timeRemaining: this.timeRemaining,
      perfectEligible: true,
    });

    const result = {
      completed: true,
      missionId: this.mission.id,
      name: this.mission.name,
      time: this.time,
      timeRemaining: this.timeRemaining,
      score: summary.score,
      summary,
      beatRival,
      rivalTime: this.rival?.finished ? this.rival.lapTime : null,
      rivalName: this.rival?.name ?? null,
      landedWell: !!this._landed && this._landed.quality > 0.6,
      landing: this._landed ?? null,
      perfect: summary.perfect && this._resetsUsed === 0,
      resets: this._resetsUsed,
      damageTaken: summary.damageTaken,
      topSpeed: summary.topSpeed,
    };
    result.stars = gradeMission(this.mission, result);
    this.result = result;
    this.bus.emit('mission:complete', result);
  }

  _fail(reason) {
    if (this._finishing) return;
    this._finishing = true;
    this.state = MISSION_STATE.FAILED;
    const summary = this.score.summary();
    this.result = {
      completed: false,
      missionId: this.mission?.id ?? null,
      name: this.mission?.name ?? 'FREE FLIGHT',
      reason,
      time: this.time,
      score: summary.score,
      summary,
      stars: 0,
      checkpointsPassed: this.checkpoints.index,
      checkpointsTotal: this.checkpoints.total,
    };
    this.bus.emit('mission:failed', this.result);
  }

  /** HUD snapshot. */
  status() {
    const nav = this.checkpoints.navInfo(this.flight.position);
    let rivalGap = null;
    if (this.rival) {
      const g = this.rival.gapTo(this.checkpoints.index, this.flight.position);
      rivalGap = { ...g, finished: this.rival.finished, name: this.rival.name };
    }
    return {
      state: this.state,
      name: this.mission?.name ?? (this.freeFlight ? 'FREE FLIGHT' : ''),
      type: this.mission?.type ?? (this.freeFlight ? 'EXPLORE' : ''),
      objective: this.freeFlight ? 'Fly wherever you like' : this._objectiveText(),
      time: this.time,
      timeRemaining: this.timeRemaining,
      hasTimeLimit: this.hasTimeLimit,
      checkpointIndex: this.checkpoints.index,
      checkpointTotal: this.checkpoints.total,
      nav,
      rivalGap,
      freeFlight: this.freeFlight,
      countdown: this.state === MISSION_STATE.COUNTDOWN ? Math.max(0, this.countdown) : 0,
    };
  }

  _teardownRival() {
    if (this.rival) {
      this.rival.dispose();
      this.rival = null;
    }
  }

  dispose() {
    this._teardownRival();
    for (const u of this._unsubs) u?.();
  }
}
