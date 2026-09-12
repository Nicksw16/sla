import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
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

/**
 * Vehicles.
 *
 * Each class is a handful of primitives merged into a single geometry, so a bus with
 * six wheels and a window band still costs one instanced draw call for the whole city.
 * Every vertex carries a part code, which is what lets one material paint a tyre black,
 * a window dark, and a headlight bright while the instance colour only ever touches
 * the bodywork.
 */
const PART = { BODY: 0, GLASS: 1, HEAD: 2, TAIL: 3, TYRE: 4, TRIM: 5 };

function tagged(geo, code, { x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0 } = {}) {
  if (rx || ry || rz) geo.rotateX(rx), geo.rotateY(ry), geo.rotateZ(rz);
  geo.translate(x, y, z);
  const n = geo.attributes.position.count;
  geo.setAttribute('aPart', new THREE.BufferAttribute(new Float32Array(n).fill(code), 1));
  return geo;
}

/** Four wheels at the corners of a wheelbase, or six for the longer classes. */
function wheels(radius, width, halfTrack, positions) {
  return positions.map((z) => [1, -1].map((side) => tagged(
    new THREE.CylinderGeometry(radius, radius, width, 6),
    PART.TYRE,
    { x: side * halfTrack, y: radius, z, rz: Math.PI / 2 },
  ))).flat();
}

function carGeometry() {
  const parts = [
    tagged(new THREE.BoxGeometry(1.94, 0.66, 4.3), PART.BODY, { y: 0.66 }),
    tagged(new THREE.BoxGeometry(1.74, 0.58, 2.2), PART.BODY, { y: 1.26, z: 0.1 }),
    tagged(new THREE.BoxGeometry(1.78, 0.4, 2.06), PART.GLASS, { y: 1.3, z: 0.1 }),
    tagged(new THREE.BoxGeometry(1.3, 0.16, 0.1), PART.HEAD, { y: 0.78, z: -2.16 }),
    tagged(new THREE.BoxGeometry(1.3, 0.16, 0.1), PART.TAIL, { y: 0.82, z: 2.16 }),
    ...wheels(0.33, 0.24, 0.92, [-1.42, 1.42]),
  ];
  return mergeGeometries(parts, false);
}

function busGeometry() {
  const parts = [
    tagged(new THREE.BoxGeometry(2.5, 2.5, 11.4), PART.BODY, { y: 1.7 }),
    tagged(new THREE.BoxGeometry(2.3, 0.3, 10.8), PART.TRIM, { y: 3.02 }),
    tagged(new THREE.BoxGeometry(2.54, 0.92, 9.6), PART.GLASS, { y: 2.4 }),
    tagged(new THREE.BoxGeometry(2.2, 0.9, 0.1), PART.GLASS, { y: 2.4, z: -5.72 }),
    tagged(new THREE.BoxGeometry(1.7, 0.2, 0.1), PART.HEAD, { y: 1.0, z: -5.72 }),
    tagged(new THREE.BoxGeometry(1.7, 0.2, 0.1), PART.TAIL, { y: 1.1, z: 5.72 }),
    ...wheels(0.52, 0.3, 1.14, [-3.9, 3.1, 4.3]),
  ];
  return mergeGeometries(parts, false);
}

function truckGeometry() {
  const parts = [
    tagged(new THREE.BoxGeometry(2.46, 2.3, 4.4), PART.BODY, { y: 1.7, z: -5.2 }),
    tagged(new THREE.BoxGeometry(2.5, 0.9, 0.12), PART.GLASS, { y: 2.5, z: -7.36 }),
    tagged(new THREE.BoxGeometry(2.6, 3.0, 10.2), PART.TRIM, { y: 2.3, z: 2.2 }),
    tagged(new THREE.BoxGeometry(0.5, 1.6, 0.4), PART.BODY, { x: 1.1, y: 2.6, z: -2.8 }),
    tagged(new THREE.BoxGeometry(1.6, 0.22, 0.12), PART.HEAD, { y: 0.9, z: -7.42 }),
    tagged(new THREE.BoxGeometry(2.0, 0.22, 0.12), PART.TAIL, { y: 1.0, z: 7.36 }),
    ...wheels(0.56, 0.32, 1.12, [-6.1, 4.6, 6.0]),
  ];
  return mergeGeometries(parts, false);
}

function vehicleGeometry() {
  return { car: carGeometry(), bus: busGeometry(), truck: truckGeometry() };
}

/**
 * One material for every vehicle. The part code decides what each surface is: the
 * instance colour paints the bodywork only, tyres stay black whatever colour the car
 * is, glass darkens, and the lamps come on with the city.
 */
function vehicleMaterial() {
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0.35 });
  mat.userData.uniforms = { uNight: { value: 0 } };
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = mat.userData.uniforms.uNight;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float aPart;
        varying float vPart;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vPart = aPart;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uNight;
        varying float vPart;`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        if (vPart > 3.5 && vPart < 4.5) {
          diffuseColor.rgb = vec3(0.045, 0.048, 0.052);   // tyre
        } else if (vPart > 0.5 && vPart < 1.5) {
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.05, 0.08, 0.11), 0.82); // glass
        } else if (vPart > 4.5) {
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.82, 0.84, 0.86), 0.7);  // trim
        } else if (vPart > 1.5 && vPart < 2.5) {
          diffuseColor.rgb = vec3(0.85, 0.86, 0.8);
          totalEmissiveRadiance += vec3(1.0, 0.95, 0.82) * (0.25 + uNight * 2.2);
        } else if (vPart > 2.5 && vPart < 3.5) {
          diffuseColor.rgb = vec3(0.32, 0.05, 0.05);
          totalEmissiveRadiance += vec3(1.0, 0.13, 0.08) * (0.3 + uNight * 1.6);
        }`);
  };
  return mat;
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
    this.vehicleMaterials = [];
    for (const kind of ['car', 'bus', 'truck']) {
      const mat = vehicleMaterial();
      this.vehicleMaterials.push(mat);
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

  /** Lamps come on with the city (spec §63). */
  setNight(night) {
    for (const mat of this.vehicleMaterials ?? []) mat.userData.uniforms.uNight.value = night;
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

      // The geometries stand on their wheels, so the road surface is the origin.
      const y = terrainHeight(v.x, v.z) + 0.08;
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
