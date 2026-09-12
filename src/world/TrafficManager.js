import * as THREE from 'three';
import { damp } from '../core/MathUtils.js';
import { Rng } from '../core/Rng.js';
import { PERIOD } from './CityGenerator.js';
import { terrainHeight, isWater } from './Terrain.js';
import { RUNWAY } from '../data/regions.js';

/**
 * Ground and air traffic (spec §27-29).
 *
 * Purpose is scale: a city with nothing moving in it reads as a model, and the one
 * thing that tells you how big a building is, is a bus next to it. So the budget goes
 * on vehicles near the player and nowhere else — ground traffic only exists within a
 * radius of the camera and is recycled, never spawned and forgotten.
 *
 * Air traffic is a small fixed cast on waypoint loops. It is solid: hitting an
 * airliner is a real collision, tested directly against the handful of aircraft
 * rather than through the static grid.
 */

const GROUND_RADIUS = 1250;

function vehicleGeometry() {
  // One merged mesh per vehicle class, all instanced.
  const car = new THREE.BoxGeometry(2.0, 1.5, 4.4);
  const bus = new THREE.BoxGeometry(2.5, 3.1, 11.5);
  const truck = new THREE.BoxGeometry(2.5, 3.4, 15.5);
  return { car, bus, truck };
}

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
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3(1, 1, 1);
    this._up = new THREE.Vector3(0, 1, 0);

    this.ground = [];
    this.air = [];
    this._buildGround();
    this._buildAir();
  }

  _buildGround() {
    const density = this.settings.preset.trafficDensity ?? 1;
    const counts = {
      car: Math.round(230 * density),
      bus: Math.round(26 * density),
      truck: Math.round(34 * density),
    };
    const geos = vehicleGeometry();
    const palettes = {
      car: [0xd8dee4, 0x2b2f36, 0xb2372e, 0x24486e, 0xa8a093, 0x2e6e4c],
      bus: [0xd8b32a, 0xd8dee4, 0x2d6ea8],
      truck: [0xd8dee4, 0x35507a, 0x8a3b2c],
    };
    this.groundMeshes = {};
    for (const kind of ['car', 'bus', 'truck']) {
      const mat = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.35 });
      const mesh = new THREE.InstancedMesh(geos[kind], mat, Math.max(1, counts[kind]));
      mesh.name = `traffic:${kind}`;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.frustumCulled = false;
      this.group.add(mesh);
      this.groundMeshes[kind] = mesh;
      for (let i = 0; i < counts[kind]; i++) {
        mesh.setColorAt(i, new THREE.Color(this.rng.pick(palettes[kind])));
        this.ground.push({
          kind, index: i, mesh,
          x: 0, z: 0, dir: 0, speed: 0, axis: 0, active: false,
        });
      }
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
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

  /** Places a ground vehicle on a random street line near the player. */
  _respawn(v, center) {
    const r = this.rng;
    for (let attempt = 0; attempt < 6; attempt++) {
      // Pick a lane on the street grid, then a point along it.
      const axis = r.bool() ? 0 : 1;
      const lane = Math.round((center[axis === 0 ? 'z' : 'x'] + r.range(-GROUND_RADIUS, GROUND_RADIUS)) / PERIOD) * PERIOD;
      const along = center[axis === 0 ? 'x' : 'z'] + r.range(-GROUND_RADIUS, GROUND_RADIUS);
      const x = axis === 0 ? along : lane + (r.bool() ? 5 : -5);
      const z = axis === 0 ? lane + (r.bool() ? 5 : -5) : along;
      if (isWater(x, z)) continue;
      v.x = x;
      v.z = z;
      v.axis = axis;
      v.dir = r.bool() ? 1 : -1;
      v.speed = (v.kind === 'car' ? r.range(11, 19) : r.range(7, 13)) * v.dir;
      v.active = true;
      return;
    }
    v.active = false;
  }

  update(dt, cameraPosition, elapsed) {
    // --- ground vehicles
    for (const v of this.ground) {
      if (!v.active) {
        this._respawn(v, cameraPosition);
        if (!v.active) continue;
      }
      if (v.axis === 0) v.x += v.speed * dt;
      else v.z += v.speed * dt;

      const dx = v.x - cameraPosition.x;
      const dz = v.z - cameraPosition.z;
      if (dx * dx + dz * dz > GROUND_RADIUS * GROUND_RADIUS) {
        this._respawn(v, cameraPosition);
        continue;
      }

      const y = terrainHeight(v.x, v.z) + 1;
      const heading = v.axis === 0 ? (v.speed > 0 ? Math.PI / 2 : -Math.PI / 2) : (v.speed > 0 ? 0 : Math.PI);
      this._p.set(v.x, y, v.z);
      this._q.setFromAxisAngle(this._up, heading);
      this._m.compose(this._p, this._q, this._s);
      v.mesh.setMatrixAt(v.index, this._m);
    }
    for (const mesh of Object.values(this.groundMeshes)) mesh.instanceMatrix.needsUpdate = true;

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
