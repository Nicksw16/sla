import * as THREE from 'three';
import { clamp, clamp01, lerp, smoothstep } from '../core/MathUtils.js';
import { Rng, fbm2D } from '../core/Rng.js';
import { REGIONS, REGION_ORDER, TILE } from '../data/regions.js';
import { terrainHeight, isWater, isAirportClearZone } from './Terrain.js';

/**
 * Procedural city.
 *
 * Two rules drive the whole generator:
 *
 * 1. No repeated cubes (spec §156). Every building is composed from two to four
 *    stacked masses with setbacks, and optionally a spire, so silhouettes vary
 *    even though all of it draws from three instanced meshes.
 * 2. District identity has to survive being seen from 600 m up (§23). Height
 *    range, footprint size, density, palette and building *type* all change per
 *    district, so you can name where you are from the shape of the roofline.
 */

// Real downtown blocks are around 100 m across. Anything much larger and the
// core stops feeling dense no matter how many buildings you put in it.
export const BLOCK = 112;
export const ROAD = 36;
export const PERIOD = BLOCK + ROAD;

/** Procedural facade material: windows in the shader, lit on demand at night. */
function facadeMaterial() {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.72, metalness: 0.12, vertexColors: false,
  });
  mat.userData.uniforms = {
    uNight: { value: 0 },
    uWindowWarm: { value: new THREE.Color(0xffd49a) },
  };
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = mat.userData.uniforms.uNight;
    shader.uniforms.uWindowWarm = mat.userData.uniforms.uWindowWarm;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float aSeed;
        attribute vec3 aSize;
        attribute float aGlass;
        varying vec3 vLocal;
        varying float vSeed;
        varying float vGlass;
        varying vec3 vFaceNormal;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vLocal = position * aSize;
        vSeed = aSeed;
        vGlass = aGlass;
        vFaceNormal = normal;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uNight;
        uniform vec3 uWindowWarm;
        varying vec3 vLocal;
        varying float vSeed;
        varying float vGlass;
        varying vec3 vFaceNormal;
        float hash12(vec2 p) {
          vec3 p3 = fract(vec3(p.xyx) * 0.1031);
          p3 += dot(p3, p3.yzx + 33.33);
          return fract((p3.x + p3.y) * p3.z);
        }`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        vec3 an = abs(vFaceNormal);
        if (an.y < 0.5) {
          // Pick the facade plane, then lay a window grid on it in metres so the
          // windows are the same size on a 20 m shed and a 300 m tower.
          vec2 uvw = an.x > an.z ? vec2(vLocal.z, vLocal.y) : vec2(vLocal.x, vLocal.y);
          vec2 cellSize = vec2(4.2, 3.7);
          vec2 cell = floor(uvw / cellSize);
          vec2 f = fract(uvw / cellSize);
          float frame = step(0.16, f.x) * step(f.x, 0.84) * step(0.2, f.y) * step(f.y, 0.8);
          float r = hash12(cell + vec2(vSeed * 37.0, vSeed * 91.0));
          // Slight vertical banding so floors read as floors.
          diffuseColor.rgb *= 0.92 + 0.08 * hash12(vec2(cell.y, vSeed));
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.55, frame * vGlass);
          float lit = step(0.52, r) * uNight * frame;
          totalEmissiveRadiance += uWindowWarm * lit * 1.35;
          // Daytime glass catches light instead of glowing.
          diffuseColor.rgb += vGlass * frame * (1.0 - uNight) * 0.06;
        } else {
          diffuseColor.rgb *= 0.82; // roofs are grubbier than facades
        }`);
  };
  return mat;
}

function simpleMaterial(color, { rough = 0.8, metal = 0.1 } = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });
}

/** Accumulates instance transforms, then bakes them into one InstancedMesh. */
class InstanceBatch {
  constructor(geometry, material, { facade = false } = {}) {
    this.geometry = geometry;
    this.material = material;
    this.facade = facade;
    this.items = [];
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3();
  }

  add(x, y, z, sx, sy, sz, rotY, color, glass = 0) {
    this.items.push({ x, y, z, sx, sy, sz, rotY, color, glass });
  }

  build(name) {
    const n = this.items.length;
    if (n === 0) return null;
    const mesh = new THREE.InstancedMesh(this.geometry, this.material, n);
    mesh.name = name;
    const seeds = this.facade ? new Float32Array(n) : null;
    const sizes = this.facade ? new Float32Array(n * 3) : null;
    const glass = this.facade ? new Float32Array(n) : null;

    for (let i = 0; i < n; i++) {
      const it = this.items[i];
      this._p.set(it.x, it.y, it.z);
      this._q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), it.rotY);
      this._s.set(it.sx, it.sy, it.sz);
      this._m.compose(this._p, this._q, this._s);
      mesh.setMatrixAt(i, this._m);
      mesh.setColorAt(i, it.color);
      if (this.facade) {
        seeds[i] = (i * 0.6180339887) % 1 * 100;
        sizes[i * 3] = it.sx;
        sizes[i * 3 + 1] = it.sy;
        sizes[i * 3 + 2] = it.sz;
        glass[i] = it.glass;
      }
    }
    if (this.facade) {
      mesh.geometry = mesh.geometry.clone();
      mesh.geometry.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 1));
      mesh.geometry.setAttribute('aSize', new THREE.InstancedBufferAttribute(sizes, 3));
      mesh.geometry.setAttribute('aGlass', new THREE.InstancedBufferAttribute(glass, 1));
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = true;
    mesh.computeBoundingSphere?.();
    this.items.length = 0;
    return mesh;
  }
}

/**
 * Spatial hash of building bounding boxes.
 *
 * Boxes are registered in every cell they touch, so a collision query only has to
 * look at the cells the aircraft's sphere overlaps — a handful of candidates out of
 * thousands of buildings, which is what keeps collision off the frame budget (§89).
 */
export class ObstacleGrid {
  constructor(cellSize = 220) {
    this.cellSize = cellSize;
    this.cells = new Map();
    this.boxes = [];
  }

  _key(cx, cz) {
    return cx * 100000 + cz;
  }

  add(minX, maxX, minZ, maxZ, base, top, kind = 'building') {
    const idx = this.boxes.length;
    this.boxes.push({ minX, maxX, minZ, maxZ, base, top, kind });
    const c = this.cellSize;
    for (let cx = Math.floor(minX / c); cx <= Math.floor(maxX / c); cx++) {
      for (let cz = Math.floor(minZ / c); cz <= Math.floor(maxZ / c); cz++) {
        const k = this._key(cx, cz);
        let list = this.cells.get(k);
        if (!list) this.cells.set(k, (list = []));
        list.push(idx);
      }
    }
    return idx;
  }

  *candidates(x, z, radius) {
    const c = this.cellSize;
    const seen = new Set();
    for (let cx = Math.floor((x - radius) / c); cx <= Math.floor((x + radius) / c); cx++) {
      for (let cz = Math.floor((z - radius) / c); cz <= Math.floor((z + radius) / c); cz++) {
        const list = this.cells.get(this._key(cx, cz));
        if (!list) continue;
        for (const i of list) {
          if (seen.has(i)) continue;
          seen.add(i);
          yield this.boxes[i];
        }
      }
    }
  }

  /**
   * Sphere-vs-box test. Returns the shallowest separating axis, which is what
   * makes a clipped wingtip push you sideways instead of stopping you dead.
   */
  sample(position, radius, out) {
    const { x, y, z } = position;
    let best = null;
    for (const b of this.candidates(x, z, radius)) {
      if (y > b.top + radius || y < b.base - radius) continue;
      const dx = Math.max(b.minX - x, 0, x - b.maxX);
      const dz = Math.max(b.minZ - z, 0, z - b.maxZ);
      if (dx * dx + dz * dz > radius * radius) continue;

      // Depth along each candidate escape direction.
      const pxMin = x - b.minX + radius;
      const pxMax = b.maxX - x + radius;
      const pzMin = z - b.minZ + radius;
      const pzMax = b.maxZ - z + radius;
      const pyTop = b.top - y + radius;

      let pen = pxMin, nx = -1, ny = 0, nz = 0;
      if (pxMax < pen) { pen = pxMax; nx = 1; nz = 0; }
      if (pzMin < pen) { pen = pzMin; nx = 0; nz = -1; }
      if (pzMax < pen) { pen = pzMax; nx = 0; nz = 1; }
      if (pyTop < pen) { pen = pyTop; nx = 0; ny = 1; nz = 0; }
      if (pen <= 0) continue;
      if (!best || pen < best.penetration) {
        best = { penetration: pen, nx, ny, nz, box: b };
      }
    }
    if (!best) return null;
    out = out ?? { normal: new THREE.Vector3(), point: new THREE.Vector3() };
    out.penetration = best.penetration;
    out.normal.set(best.nx, best.ny, best.nz);
    out.point.set(x, y, z).addScaledVector(out.normal, -best.penetration);
    out.kind = best.box.kind;
    return out;
  }

  /** Closest surface within maxDist, for near-miss scoring. */
  nearest(position, maxDist) {
    const { x, y, z } = position;
    let bestDist = Infinity;
    let bestKind = null;
    for (const b of this.candidates(x, z, maxDist)) {
      const dx = Math.max(b.minX - x, 0, x - b.maxX);
      const dz = Math.max(b.minZ - z, 0, z - b.maxZ);
      const dy = Math.max(b.base - y, 0, y - b.top);
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d < bestDist) { bestDist = d; bestKind = b.kind; }
    }
    return bestDist <= maxDist ? { distance: bestDist, kind: bestKind } : null;
  }

  get count() {
    return this.boxes.length;
  }
}

/** One building: stacked masses, optional spire, registered for collision. */
function addBuilding(ctx, opts) {
  const { box, cyl, cone, roof, grid } = ctx;
  const { x, z, w, d, height, rot, palette, glass, rng, type } = opts;
  const base = terrainHeight(x, z) - 2;
  const color = new THREE.Color(palette[rng.int(0, palette.length - 1)]);
  color.offsetHSL(0, 0, rng.range(-0.05, 0.05));

  let top = base;

  if (type === 'silo') {
    const r = Math.min(w, d) * 0.42;
    cyl.add(x, base + height / 2, z, r, height, r, rot, color);
    top = base + height;
  } else if (type === 'stack') {
    const r = Math.min(w, d) * 0.16;
    cyl.add(x, base + height / 2, z, r, height, r, rot, color.clone().multiplyScalar(0.8));
    // A banded collar so stacks read as stacks from a distance.
    cyl.add(x, base + height * 0.86, z, r * 1.5, height * 0.06, r * 1.5, rot, new THREE.Color(0xd04a2a));
    top = base + height;
  } else if (type === 'house') {
    const h = height;
    box.add(x, base + h / 2, z, w, h, d, rot, color, 0.1);
    // A pyramid sized to the box's own half-diagonal and turned 45 degrees sits on
    // the walls instead of hanging over them like a hat.
    const roofR = Math.hypot(w, d) * 0.5 * 1.04;
    const roofH = h * 0.5;
    roof.add(x, base + h + roofH / 2, z, roofR, roofH, roofR, rot + Math.PI / 4,
      color.clone().multiplyScalar(0.78));
    top = base + h + roofH;
  } else if (type === 'shed') {
    box.add(x, base + height / 2, z, w, height, d, rot, color, 0.05);
    // Roof vents / skylights.
    if (rng.bool(0.5)) {
      box.add(x, base + height + 1.2, z, w * 0.55, 2.4, d * 0.3, rot, color.clone().multiplyScalar(0.75), 0);
    }
    top = base + height + 3;
  } else {
    // Tower: successive setbacks, each smaller and shorter than the last.
    const stages = height > 150 ? rng.int(2, 3) : height > 60 ? rng.int(1, 2) : 1;
    let y = base;
    let cw = w, cd = d;
    let remaining = height;
    for (let s = 0; s < stages; s++) {
      const share = s === stages - 1 ? remaining : remaining * rng.range(0.45, 0.72);
      box.add(x, y + share / 2, z, cw, share, cd, rot, color, glass);
      y += share;
      remaining -= share;
      cw *= rng.range(0.62, 0.84);
      cd *= rng.range(0.62, 0.84);
    }
    top = y;
    // Crown: spire, mast or rooftop plant.
    if (rng.next() < opts.spireChance) {
      const spireH = height * rng.range(0.12, 0.34);
      cone.add(x, top + spireH / 2, z, Math.min(cw, cd) * 0.42, spireH, Math.min(cw, cd) * 0.42, rot, new THREE.Color(0x99a4b0));
      top += spireH;
    } else if (rng.bool(0.55)) {
      const boxH = rng.range(3, 9);
      box.add(x + rng.range(-cw * 0.2, cw * 0.2), top + boxH / 2, z, cw * 0.45, boxH, cd * 0.45, rot, color.clone().multiplyScalar(0.8), 0);
      top += boxH;
    }
  }

  const halfW = Math.max(w, d) * 0.5;
  grid.add(x - halfW, x + halfW, z - halfW, z + halfW, base, top, 'building');
  return top;
}

function buildingTypeFor(region, rng) {
  const b = region.buildings;
  if (b.industrial) return rng.pick(['shed', 'shed', 'silo', 'stack', 'tower']);
  if (b.rural) return rng.pick(['house', 'house', 'shed']);
  if (region.id === 'residential') return rng.next() < 0.62 ? 'house' : 'tower';
  if (b.docks) return rng.pick(['shed', 'shed', 'tower', 'silo']);
  if (region.id === 'airport') return rng.pick(['shed', 'shed', 'tower']);
  return 'tower';
}

/**
 * Generates every district. Returns the scene group, the collision grid, and the
 * per-tile urbanisation values the ground shader uses to paint streets.
 */
export function generateCity({ seed = 20260912, detail = 1 } = {}) {
  const group = new THREE.Group();
  group.name = 'city';
  const grid = new ObstacleGrid(220);

  const facade = facadeMaterial();
  const roofMat = simpleMaterial(0xb0b4ba, { rough: 0.9, metal: 0.05 });
  const ctx = {
    box: new InstanceBatch(new THREE.BoxGeometry(1, 1, 1), facade, { facade: true }),
    cyl: new InstanceBatch(new THREE.CylinderGeometry(1, 1, 1, 12), facade, { facade: true }),
    cone: new InstanceBatch(new THREE.ConeGeometry(1, 1, 8), roofMat),
    // Four-sided, so a house gets a pitched roof rather than an octagonal hat.
    roof: new InstanceBatch(new THREE.ConeGeometry(1, 1, 4), roofMat),
    grid,
  };

  const urban = new Float32Array(9);
  const perRegion = {};
  let placed = 0;

  REGION_ORDER.forEach((id, tileIndex) => {
    const region = REGIONS[id];
    const b = region.buildings;
    const rng = new Rng(seed).fork(id);
    urban[tileIndex] = clamp01(b.density);
    let regionCount = 0;

    const half = TILE / 2;
    const blocks = Math.floor(TILE / PERIOD);
    const start = region.cx - half + PERIOD / 2;
    const startZ = region.cz - half + PERIOD / 2;

    for (let i = 0; i < blocks; i++) {
      for (let j = 0; j < blocks; j++) {
        const bx = start + i * PERIOD;
        const bz = startZ + j * PERIOD;
        if (isWater(bx, bz)) continue;
        if (isAirportClearZone(bx, bz)) continue;

        // Density varies inside a district so it never looks stamped out.
        const localDensity = b.density * (0.65 + 0.5 * fbm2D(bx * 0.0011, bz * 0.0011, 2, 7));
        if (rng.next() > localDensity * detail) continue;

        // Distance from the district centre drives height: cores are tall, edges low.
        const distFromCore = Math.hypot(bx - region.cx, bz - region.cz) / half;
        const coreBias = 1 - smoothstep(0.1, 1.05, distFromCore) * 0.62;

        // How many buildings fit in a block depends on how big they are. A district of
        // houses with one house per 112 m block reads as litter scattered on a street
        // grid rather than as a neighbourhood, so small footprints get a sub-grid.
        const avgFoot = (b.footprint[0] + b.footprint[1]) * 0.5;
        const perBlock = avgFoot > 70 ? 1 : clamp(Math.round((BLOCK * 0.85) / avgFoot), 1, 4);
        const cells = perBlock > 1 ? Math.ceil(Math.sqrt(perBlock)) : 1;
        const cellSize = BLOCK / cells;

        for (let k = 0; k < perBlock; k++) {
          const maxFoot = cellSize * 0.9;
          const shrink = perBlock > 1 ? Math.sqrt(perBlock) * 0.72 : 1;
          const fw = Math.min(maxFoot, rng.range(b.footprint[0], b.footprint[1]) / shrink);
          const fd = Math.min(maxFoot, fw * rng.range(0.7, 1.35));
          // Lay them out on the sub-grid, then jitter inside their own cell, so they
          // spread across the block instead of piling up in the middle.
          const cx = (k % cells) - (cells - 1) / 2;
          const cz = Math.floor(k / cells) - (cells - 1) / 2;
          const jitter = Math.max(0, (cellSize - Math.max(fw, fd)) * 0.4);
          const x = bx + cx * cellSize + rng.range(-jitter, jitter);
          const z = bz + cz * cellSize + rng.range(-jitter, jitter);
          if (isWater(x, z) || isAirportClearZone(x, z)) continue;

          const type = buildingTypeFor(region, rng);
          let height = lerp(b.minH, b.maxH, Math.pow(rng.next(), 1.7)) * coreBias;
          if (type === 'house') height = rng.range(6, 13);
          if (type === 'stack') height = rng.range(44, 96);
          if (type === 'silo') height = rng.range(18, 46);
          if (type === 'shed') height = rng.range(10, 26);
          height = Math.max(6, height);

          addBuilding(ctx, {
            x, z, w: fw, d: fd, height, rot: rng.bool(0.12) ? rng.range(0, Math.PI) : 0,
            palette: b.palette, glass: b.glass, rng, type, spireChance: b.spireChance,
          });
          placed++;
          regionCount++;
        }
      }
    }
    perRegion[id] = regionCount;
  });

  const boxes = ctx.box.build('city:boxes');
  const cyls = ctx.cyl.build('city:cylinders');
  const cones = ctx.cone.build('city:cones');
  const roofs = ctx.roof.build('city:roofs');
  for (const m of [boxes, cyls, cones, roofs]) if (m) group.add(m);

  group.userData.facadeUniforms = facade.userData.uniforms;
  group.userData.urban = urban;
  group.userData.stats = { buildings: placed, colliders: grid.count, perRegion };
  group.userData.dispose = () => {
    for (const m of [boxes, cyls, cones, roofs]) m?.geometry.dispose();
    facade.dispose();
    roofMat.dispose();
  };
  return { group, grid, urban, stats: group.userData.stats };
}
