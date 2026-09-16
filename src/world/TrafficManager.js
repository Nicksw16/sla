import * as THREE from 'three';
import { clamp, damp } from '../core/MathUtils.js';
import { Rng } from '../core/Rng.js';
import { RUNWAY } from '../data/regions.js';
import { BRIDGE_LINE, BRIDGE_SPAN, lineAt, lineIndexNear, roadSurfaceAt } from './Roads.js';
import { PAINT, LIVERY, VEHICLE_CLASSES, VEHICLE_ORDER, vehicleMaterial } from './Vehicles.js';
import {
  BEHAVIOUR_RADIUS, applyTurn, chooseTurn, follow, gapAhead, laneClear, laneKey,
  laneOffsetsFor, mustYield, nextJunction, oncomingClear, oncomingKey, roadExists,
  spawnState, surfaceUnder, vehicleHeading, wantsOvertake,
} from './Traffic.js';

/**
 * Ground and air traffic (spec §27-29).
 *
 * Purpose is scale: a city with nothing moving in it reads as a model, and the one
 * thing that tells you how big a building is, is a bus next to it. So the budget goes
 * on vehicles near the player and nowhere else — ground traffic only exists within a
 * radius of the camera and is recycled, never spawned and forgotten.
 *
 * This file owns the meshes and the recycling. What a vehicle is made of is in
 * Vehicles.js and what it does is in Traffic.js, because the driving is the part worth
 * testing and none of it needs a GPU to check.
 *
 * Air traffic is a small fixed cast on waypoint loops. It is solid: hitting an
 * airliner is a real collision, tested directly against the handful of aircraft
 * rather than through the static grid.
 */

/**
 * How far out the traffic exists, and how much of it there is.
 *
 * These two numbers are one decision. Three hundred vehicles spread over a 1250 m bubble
 * is eighty-five kilometres of road with a car every two hundred and sixty metres on it,
 * which from the air is not a city with traffic in it - it is a city with the occasional
 * car. Pulling the bubble in concentrates the same budget where it can actually be seen:
 * a four-metre car at eight hundred metres is six pixels, so nothing is lost at the edge,
 * and the streets underneath get the density that makes them read as streets.
 */
const GROUND_RADIUS = 820;

/** Corner duration is a function of the corner, so a bus swings wider than a hatch. */
const TURN_ARC = 26;

function airlinerGeometry() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(2.6, 28, 6, 10),
    new THREE.MeshStandardMaterial({ color: 0xeef2f6, roughness: 0.45, metalness: 0.3 }),
  );
  body.rotation.x = Math.PI / 2;
  g.add(body);
  const wingMat = new THREE.MeshStandardMaterial({ color: 0xdde4ea, roughness: 0.5, metalness: 0.3 });
  const wing = new THREE.Mesh(new THREE.BoxGeometry(38, 0.7, 5.5), wingMat);
  wing.position.set(0, -0.6, 2);
  g.add(wing);
  const tail = new THREE.Mesh(new THREE.BoxGeometry(13, 0.6, 3.4), wingMat);
  tail.position.set(0, 2.2, 15);
  g.add(tail);
  const fin = new THREE.Mesh(new THREE.BoxGeometry(0.6, 7, 4.4), wingMat);
  fin.position.set(0, 4.4, 15);
  g.add(fin);
  for (const side of [-1, 1]) {
    const eng = new THREE.Mesh(
      new THREE.CylinderGeometry(1.7, 1.5, 5.4, 8),
      new THREE.MeshStandardMaterial({ color: 0x9aa4ae, roughness: 0.4, metalness: 0.6 }),
    );
    eng.rotation.x = Math.PI / 2;
    eng.position.set(side * 11, -1.9, 1);
    g.add(eng);
  }
  return g;
}

function helicopterGeometry() {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0x2f4a6b, roughness: 0.5, metalness: 0.3 });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(1.8, 6, 5, 8), mat);
  body.rotation.x = Math.PI / 2;
  g.add(body);
  const boom = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.25, 8, 6), mat);
  boom.rotation.x = Math.PI / 2;
  boom.position.z = 6.5;
  g.add(boom);
  const rotor = new THREE.Mesh(
    new THREE.BoxGeometry(19, 0.16, 0.9),
    new THREE.MeshStandardMaterial({ color: 0x23282e, roughness: 0.7 }),
  );
  rotor.position.y = 2.4;
  g.add(rotor);
  const tailRotor = new THREE.Mesh(new THREE.BoxGeometry(0.14, 4.4, 0.5), new THREE.MeshStandardMaterial({ color: 0x23282e }));
  tailRotor.position.set(0.6, 1.2, 10);
  g.add(tailRotor);
  g.userData.rotor = rotor;
  g.userData.tailRotor = tailRotor;
  return g;
}

export class TrafficManager {
  constructor({ scene, settings, seed = 99 }) {
    this.scene = scene;
    this.settings = settings;
    this.rng = new Rng(seed);
    this.group = new THREE.Group();
    this.group.name = 'traffic';
    scene.add(this.group);

    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._qp = new THREE.Quaternion();
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3(1, 1, 1);
    this._up = new THREE.Vector3(0, 1, 0);
    this._right = new THREE.Vector3(1, 0, 0);
    this._surface = {};
    this._lanes = new Map();
    this._elapsed = 0;

    this.ground = [];
    this.air = [];
    this._buildGround();
    this._buildAir();
  }

  /**
   * One instanced mesh per class, sized by the quality preset.
   *
   * Paint is per instance and weighted the way a real car park is, so a street is
   * mostly white, silver and black with colour as the minority - and the finish varies
   * with it, because a city where every car has the same showroom lacquer is as
   * uniform as one where they are all the same shape.
   */
  _buildGround() {
    const density = this.settings.preset.trafficDensity ?? 1;
    const total = Math.round(520 * density);
    const paintTotal = PAINT.reduce((a, p) => a + p.weight, 0);
    this.groundMeshes = {};
    this.vehicleMaterials = [];

    for (const kind of VEHICLE_ORDER) {
      const spec = VEHICLE_CLASSES[kind];
      const count = Math.max(1, Math.round(total * spec.share));
      const geo = spec.geometry();
      const mat = vehicleMaterial();
      this.vehicleMaterials.push(mat);
      const mesh = new THREE.InstancedMesh(geo, mat, count);
      mesh.name = `traffic:${kind}`;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.frustumCulled = false;

      // Per-instance paint finish and indicator state, alongside the body colour.
      const finish = new THREE.InstancedBufferAttribute(new Float32Array(count), 1);
      const signal = new THREE.InstancedBufferAttribute(new Float32Array(count), 1);
      signal.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('aFinish', finish);
      geo.setAttribute('aSignal', signal);

      this.group.add(mesh);
      this.groundMeshes[kind] = mesh;

      for (let i = 0; i < count; i++) {
        const paint = this._paintFor(kind, paintTotal);
        mesh.setColorAt(i, new THREE.Color(paint.color));
        finish.setX(i, clamp(paint.metal + this.rng.range(-0.18, 0.18), 0, 1));
        this.ground.push({
          kind, index: i, mesh, signalAttr: signal,
          length: spec.length, accel: spec.accel, brake: spec.brake,
          cruiseRange: spec.cruise,
          axis: 0, line: 0, side: 1, lane: 0, s: 0,
          speed: 0, cruise: 0, signal: 0, turning: null, active: false,
        });
      }
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      finish.needsUpdate = true;
    }
  }

  /** Livery where the colour is what the vehicle is, weighted paint otherwise. */
  _paintFor(kind, paintTotal) {
    const livery = LIVERY[kind];
    if (Array.isArray(livery)) return this.rng.pick(livery);
    if (livery) return livery;
    let roll = this.rng.next() * paintTotal;
    for (const p of PAINT) {
      roll -= p.weight;
      if (roll <= 0) return p;
    }
    return PAINT[0];
  }

  _buildAir() {
    // Fixed cast: two airliners on approach/departure, two helicopters over the city.
    const routes = [
      { kind: 'airliner', alt: 620, speed: 78, loop: [[-4200, 2400], [1200, 3400], [RUNWAY.x - 1600, RUNWAY.z - 40], [5200, 2600], [4200, -2200], [-2400, -1800]] },
      { kind: 'airliner', alt: 880, speed: 92, loop: [[4600, -3800], [-1200, -4200], [-4400, -600], [-2200, 3600], [3200, 4200]] },
      { kind: 'heli', alt: 260, speed: 32, loop: [[300, 500], [-900, 1100], [-2400, 200], [-600, -900], [900, -300]] },
      { kind: 'heli', alt: 190, speed: 28, loop: [[2800, 900], [3600, -400], [2400, -1200], [1800, 200]] },
    ];
    const airlinerProto = airlinerGeometry();
    const heliProto = helicopterGeometry();

    for (const r of routes) {
      const obj = r.kind === 'airliner' ? airlinerProto.clone(true) : heliProto.clone(true);
      if (r.kind === 'heli') {
        // clone() loses the userData refs on children, so re-find them.
        obj.userData.rotor = obj.children[2];
        obj.userData.tailRotor = obj.children[3];
      }
      this.group.add(obj);
      this.air.push({
        ...r, obj, leg: 0, t: this.rng.next(),
        position: new THREE.Vector3(), hitRadius: r.kind === 'airliner' ? 20 : 10,
        light: 0,
      });
    }
  }


  /**
   * Places a ground vehicle on a lane near the player.
   *
   * The lane has to be a road that exists: the street grid is painted over the whole
   * world, water included, so a lane picked without asking puts a car on the harbour
   * bed. The one road allowed over water is the bridge, and roadExists knows it.
   */
  _respawn(v, center) {
    const r = this.rng;
    // Is the bridge in range? It is the only crossing of the channel, so it carries
    // far more than its share of anything nearby - and a bridge with no traffic on it
    // is the thing a player notices from the air.
    const bridgeNear = Math.abs(center.x - BRIDGE_SPAN.x) < GROUND_RADIUS + BRIDGE_SPAN.half
      && Math.abs(center.z - BRIDGE_SPAN.z) < GROUND_RADIUS;

    for (let attempt = 0; attempt < 8; attempt++) {
      const onBridge = bridgeNear && r.next() < 0.35;
      const axis = onBridge ? 0 : (r.bool() ? 0 : 1);
      const cross = axis === 0 ? center.z : center.x;
      const along = axis === 0 ? center.x : center.z;
      const line = onBridge ? BRIDGE_LINE
        : lineIndexNear(cross + r.range(-GROUND_RADIUS, GROUND_RADIUS));
      const s = onBridge
        ? BRIDGE_SPAN.x + r.range(-BRIDGE_SPAN.half, BRIDGE_SPAN.half)
        : along + r.range(-GROUND_RADIUS, GROUND_RADIUS);
      if (!roadExists(axis, line, s)) continue;
      const lanes = laneOffsetsFor(line, s, axis);
      spawnState(v, {
        axis, line, s,
        side: r.bool() ? 1 : -1,
        lane: Math.floor(r.next() * lanes.length),
        cruise: r.range(v.cruiseRange[0], v.cruiseRange[1]),
      });
      return;
    }
    v.active = false;
  }

  /** Lamps come on with the city (spec §63). */
  setNight(night) {
    for (const mat of this.vehicleMaterials ?? []) mat.userData.uniforms.uNight.value = night;
  }

  /**
   * Group the active vehicles by the lane they are in and sort each along its
   * direction of travel, so every driver can be handed the one in front of it. Three
   * hundred vehicles make this far cheaper than asking each car to search.
   */
  _buildLanes() {
    const lanes = this._lanes;
    for (const arr of lanes.values()) arr.length = 0;
    for (const v of this.ground) {
      if (!v.active || v.turning) continue;
      const key = laneKey(v);
      let arr = lanes.get(key);
      if (!arr) lanes.set(key, (arr = []));
      arr.push(v);
    }
    for (const arr of lanes.values()) {
      if (arr.length > 1) arr.sort((a, b) => (a.s - b.s) * a.side);
    }
    return lanes;
  }

  update(dt, cameraPosition, elapsed) {
    this._elapsed = elapsed ?? this._elapsed + dt;
    for (const mat of this.vehicleMaterials ?? []) {
      mat.userData.uniforms.uTime.value = this._elapsed;
    }

    for (const v of this.ground) {
      if (!v.active) this._respawn(v, cameraPosition);
    }
    const lanes = this._buildLanes();

    for (const v of this.ground) {
      if (!v.active) continue;
      this._drive(v, dt, cameraPosition, lanes);
      this._place(v);
    }
    for (const mesh of Object.values(this.groundMeshes)) {
      mesh.instanceMatrix.needsUpdate = true;
    }

    // --- air traffic on waypoint loops
    for (const a of this.air) {
      const from = a.loop[a.leg];
      const to = a.loop[(a.leg + 1) % a.loop.length];
      const segLen = Math.hypot(to[0] - from[0], to[1] - from[1]);
      a.t += (a.speed * dt) / Math.max(1, segLen);
      if (a.t >= 1) {
        a.t -= 1;
        a.leg = (a.leg + 1) % a.loop.length;
      }
      const x = from[0] + (to[0] - from[0]) * a.t;
      const z = from[1] + (to[1] - from[1]) * a.t;
      const heading = Math.atan2(to[0] - from[0], -(to[1] - from[1]));
      a.position.set(x, a.alt, z);
      a.obj.position.copy(a.position);
      a.obj.rotation.y = damp(a.obj.rotation.y, heading, 2, dt);
      if (a.kind === 'heli' && a.obj.userData.rotor) {
        a.obj.userData.rotor.rotation.y += dt * 34;
        a.obj.userData.tailRotor.rotation.x += dt * 48;
      }
    }
  }

  /**
   * One vehicle's decisions for one step.
   *
   * Beyond the behaviour radius a driver still follows the car in front - traffic that
   * passes through itself in the middle distance is worse than traffic that runs a red
   * nobody can see - but stops paying for signals, turns and overtaking.
   */
  _drive(v, dt, cameraPosition, lanes) {
    if (v.turning) return this._corner(v, dt);

    const near = (() => {
      const dx = (v.axis === 0 ? v.s : lineAt(v.line)) - cameraPosition.x;
      const dz = (v.axis === 0 ? lineAt(v.line) : v.s) - cameraPosition.z;
      if (dx * dx + dz * dz > GROUND_RADIUS * GROUND_RADIUS) { v.active = false; return false; }
      return dx * dx + dz * dz < BEHAVIOUR_RADIUS * BEHAVIOUR_RADIUS;
    })();
    if (!v.active) return;

    const queue = lanes.get(laneKey(v));
    const leader = queue ? queue[queue.indexOf(v) + 1] : null;
    const junction = near ? nextJunction(v) : null;
    const { gap, leadSpeed } = gapAhead(v, leader, junction, this._elapsed);

    // Overtake rather than sit behind something slow, where the road allows it.
    if (near && !v.turning && wantsOvertake(v, gap, leadSpeed)) {
      const lanesHere = laneOffsetsFor(v.line, v.s, v.axis);
      const target = v.lane === 0 ? 1 : 0;
      if (target < lanesHere.length && laneClear(v, target, lanes.get(laneKey({ ...v, lane: target })) ?? [])) {
        v.lane = target;
        v.signal = target > 0 ? 1 : -1;
        v.signalUntil = this._elapsed + 1.6;
      }
    }

    v.speed = Math.max(0, v.speed + follow(v, gap, leadSpeed) * dt);
    v.s += v.speed * v.side * dt;

    // At the junction: go straight on, or take the corner if one was chosen.
    if (near && junction && junction.distance <= 1.5 && v.speed > 0.4) {
      const turn = chooseTurn(v, junction, this.rng);
      if (!turn) { v.active = false; return; }
      if (turn.turn !== 0) {
        if (v.speed > 9) {
          // Too fast for the corner; take it next time round rather than on two wheels.
          v.speed = Math.min(v.speed, 9);
        } else if (mustYield(v, turn.turn)
          && !oncomingClear(v, junction, lanes.get(oncomingKey(v)) ?? [])) {
          v.speed = Math.min(v.speed, 1.5);
        } else {
          this._beginCorner(v, junction, turn.turn);
        }
      }
    }

    if (v.signalUntil && this._elapsed > v.signalUntil) { v.signal = 0; v.signalUntil = 0; }
    if (!roadExists(v.axis, v.line, v.s)) v.active = false;
  }

  /** Start a corner: remember where it began, and where it comes out. */
  _beginCorner(v, junction, turn) {
    const from = { axis: v.axis, line: v.line, side: v.side, lane: v.lane, s: v.s };
    const entry = surfaceUnder(v, {});
    applyTurn(v, junction, turn);
    const exit = surfaceUnder(v, {});
    v.turning = {
      t: 0,
      duration: Math.max(0.9, TURN_ARC / Math.max(v.speed, 3)),
      fromX: entry.x, fromZ: entry.z,
      toX: exit.x, toZ: exit.z,
      pivotX: from.axis === 0 ? lineAt(junction.index) : lineAt(from.line),
      pivotZ: from.axis === 0 ? lineAt(from.line) : lineAt(junction.index),
      fromHeading: vehicleHeading(from),
      toHeading: vehicleHeading(v),
    };
    v.signal = turn;
    v.signalUntil = 0;
  }

  /**
   * Drive the corner itself.
   *
   * A quadratic through the junction centre, which is the shape a car actually takes,
   * and the heading follows the tangent rather than snapping at the end - a vehicle
   * that changes facing in one frame at a junction is the thing that reads as a glitch
   * from any altitude.
   */
  _corner(v, dt) {
    const c = v.turning;
    c.t += dt / c.duration;
    const t = Math.min(1, c.t);
    const u = 1 - t;
    const x = u * u * c.fromX + 2 * u * t * c.pivotX + t * t * c.toX;
    const z = u * u * c.fromZ + 2 * u * t * c.pivotZ + t * t * c.toZ;
    const dx = 2 * u * (c.pivotX - c.fromX) + 2 * t * (c.toX - c.pivotX);
    const dz = 2 * u * (c.pivotZ - c.fromZ) + 2 * t * (c.toZ - c.pivotZ);
    v.cornerX = x;
    v.cornerZ = z;
    v.cornerHeading = Math.atan2(dx, -dz);
    v.speed = Math.max(3.5, v.speed - v.brake * 0.35 * dt);
    if (t >= 1) {
      v.turning = null;
      v.cornerX = undefined;
      v.signal = 0;
    }
  }

  /** Write the vehicle's transform into its instanced mesh. */
  _place(v) {
    let x; let z; let heading;
    if (v.turning) {
      x = v.cornerX; z = v.cornerZ; heading = v.cornerHeading;
      const surf = roadSurfaceAt(x, z);
      this._p.set(x, surf.y + 0.08, z);
      this._q.setFromAxisAngle(this._up, heading);
    } else {
      const surf = surfaceUnder(v, this._surface);
      x = surf.x; z = surf.z;
      this._p.set(x, surf.y + 0.08, z);
      this._q.setFromAxisAngle(this._up, vehicleHeading(v));
      // Lean with the road. This is what a car climbing the bridge approach looks like.
      if (surf.pitch) {
        this._qp.setFromAxisAngle(this._right, surf.pitch);
        this._q.multiply(this._qp);
      }
    }
    this._m.compose(this._p, this._q, this._s);
    v.mesh.setMatrixAt(v.index, this._m);
    if (v.signalAttr.getX(v.index) !== v.signal) {
      v.signalAttr.setX(v.index, v.signal);
      v.signalAttr.needsUpdate = true;
    }
  }

  /** Dynamic obstacles: only a handful, so a direct loop beats a spatial index. */
  sampleAir(position, radius) {
    for (const a of this.air) {
      const d = a.position.distanceTo(position);
      const limit = a.hitRadius + radius;
      if (d < limit) {
        const normal = position.clone().sub(a.position).normalize();
        return { penetration: limit - d, normal, point: a.position.clone(), kind: 'aircraft' };
      }
    }
    return null;
  }

  nearestAir(position, maxDist) {
    let best = Infinity;
    for (const a of this.air) {
      const d = a.position.distanceTo(position) - a.hitRadius;
      if (d < best) best = d;
    }
    return best <= maxDist ? { distance: Math.max(0, best), kind: 'aircraft' } : null;
  }

  dispose() {
    this.scene.remove(this.group);
    this.group.traverse((o) => {
      if (o.isMesh) {
        o.geometry?.dispose?.();
        if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose?.());
        else o.material?.dispose?.();
      }
    });
  }
}
