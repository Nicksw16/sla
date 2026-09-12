import * as THREE from 'three';
import { clamp, clamp01, lerp, smoothstep } from '../core/MathUtils.js';
import { fbm2D } from '../core/Rng.js';
import { COAST_Z, RUNWAY, WORLD_FAR, WORLD_HALF } from '../data/regions.js';

/**
 * The terrain is a pure function of (x, z) — no stored heightmap.
 *
 * That matters because the same function has to serve three consumers that must
 * never disagree: the visible mesh, the flight collision floor, and the mission
 * authoring tools that place checkpoints at a height above ground. One function,
 * one answer (spec §92: data and rules, not duplicated tables).
 */

const SEABED = -42;

/** Water south of the coast, plus the harbour channel the bridge spans. */
export const INLET = { minX: 260, maxX: 1180, minZ: 3150, maxZ: COAST_Z };

export function isWater(x, z) {
  if (z > COAST_Z) return true;
  return x > INLET.minX && x < INLET.maxX && z > INLET.minZ;
}

/** Ridged noise: sharp crests instead of rounded blobs. */
function ridged(x, z, seed) {
  return 1 - Math.abs(fbm2D(x, z, 4, seed) * 2 - 1);
}

/** How mountainous a point is, 0..1. */
function mountainMask(x, z) {
  // The North Ridge itself, in the north-west district.
  const d = Math.hypot(x + 3000, z + 3000);
  let m = smoothstep(2500, 800, d);
  // A far ridge beyond the map edge, so the horizon is never an empty line (§87).
  m = Math.max(m, smoothstep(-4300, -6400, z) * 0.92);
  m = Math.max(m, smoothstep(-4300, -6400, x) * 0.55);
  return clamp01(m);
}

/** Distance outside the runway rectangle, 0 when on it. */
function runwayDistance(x, z) {
  const dx = Math.abs(x - RUNWAY.x) - RUNWAY.length / 2;
  const dz = Math.abs(z - RUNWAY.z) - RUNWAY.width / 2;
  return Math.hypot(Math.max(dx, 0), Math.max(dz, 0));
}

/** Ground elevation in metres. Cheap enough to call per frame for collision. */
export function terrainHeight(x, z) {
  // Gentle inland undulation, kept non-negative so the collision floor and the
  // water surface never contradict each other.
  let h = fbm2D(x * 0.00022, z * 0.00022, 3, 11) * 22;

  // Rolling ground rising toward the north.
  h += smoothstep(-1200, -4400, z) * 88;

  // The North Ridge.
  const mtn = mountainMask(x, z);
  if (mtn > 0.001) {
    const r = ridged(x * 0.00042, z * 0.00042, 71);
    h += Math.pow(r, 1.35) * 980 * mtn;
  }

  // Hills rise again past the city limits so the world does not end in a wall (§87).
  const outward = Math.max(Math.abs(x), Math.abs(z));
  h += smoothstep(WORLD_HALF, WORLD_HALF + 3200, outward) * 220;

  // The airport apron is graded flat, or nothing could ever land on it.
  const rwDist = runwayDistance(x, z);
  if (rwDist < 900) {
    h = lerp(RUNWAY.elevation, h, smoothstep(120, 900, rwDist));
  }

  // Beach slope into the sea, then the seabed.
  if (z > COAST_Z - 420) {
    const t = smoothstep(COAST_Z - 420, COAST_Z + 700, z);
    h = lerp(h, SEABED, t);
  }
  // The harbour channel is dredged.
  if (x > INLET.minX - 90 && x < INLET.maxX + 90 && z > INLET.minZ - 140) {
    const edge =
      smoothstep(INLET.minX - 90, INLET.minX + 40, x) *
      (1 - smoothstep(INLET.maxX - 40, INLET.maxX + 90, x)) *
      smoothstep(INLET.minZ - 140, INLET.minZ + 60, z);
    h = lerp(h, -24, edge);
  }

  return h;
}

/** The surface an aircraft collides with: the ground, or the sea surface over water. */
export function collisionHeight(x, z) {
  return Math.max(terrainHeight(x, z), 0);
}

/**
 * The airport's movement area: runway, taxiway and apron.
 *
 * The city generator must leave this alone. It has no knowledge of the airport, so
 * without this exclusion it happily drops a shed across the runway and the takeoff
 * and landing missions become unflyable — which is exactly what the content tests
 * caught. The airport's own buildings are placed deliberately by Landmarks.
 */
/** Central Park, kept clear of buildings so it stays the green void it is meant to be. */
export const PARK = { x: -620, z: 640, radius: 250 };

export function isParkZone(x, z) {
  return Math.hypot(x - PARK.x, z - PARK.z) < PARK.radius;
}

export function isAirportClearZone(x, z) {
  const dx = Math.abs(x - RUNWAY.x);
  const dz = z - RUNWAY.z;
  return dx < RUNWAY.length / 2 + 180 && dz > -460 && dz < 160;
}

export function isOnRunway(x, z) {
  const dx = Math.abs(x - RUNWAY.x);
  const dz = Math.abs(z - RUNWAY.z);
  return dx < RUNWAY.length / 2 && dz < RUNWAY.width / 2 + 12;
}

/**
 * Builds a square ring of terrain. Concentric rings at coarsening resolution give
 * mountains real definition up close while still drawing a horizon, for a fraction
 * of the triangles a uniform grid would need (spec §88-89).
 */
function buildRing(innerHalf, outerHalf, step, material) {
  const positions = [];
  const normals = [];
  const uvs = [];
  const cols = Math.ceil((outerHalf * 2) / step);
  const h = (x, z) => terrainHeight(x, z);

  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < cols; j++) {
      const x0 = -outerHalf + i * step;
      const z0 = -outerHalf + j * step;
      const x1 = x0 + step;
      const z1 = z0 + step;
      // Skip quads wholly inside the hole this ring wraps around.
      if (innerHalf > 0 &&
          Math.abs(x0) < innerHalf && Math.abs(x1) <= innerHalf &&
          Math.abs(z0) < innerHalf && Math.abs(z1) <= innerHalf) continue;

      const y00 = h(x0, z0), y10 = h(x1, z0), y01 = h(x0, z1), y11 = h(x1, z1);
      // Counter-clockwise seen from above, so the ground faces the sky. Wound the
      // other way the whole world is back-face culled from every altitude the player
      // ever occupies, and computeVertexNormals lights it from underneath.
      positions.push(x0, y00, z0, x1, y11, z1, x1, y10, z0);
      positions.push(x0, y00, z0, x0, y01, z1, x1, y11, z1);
      for (let k = 0; k < 6; k++) normals.push(0, 1, 0);
      uvs.push(0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  const mesh = new THREE.Mesh(geo, material);
  mesh.matrixAutoUpdate = false;
  return mesh;
}

/**
 * Ground material.
 *
 * Terrain colour comes from height and slope (sand, grass, dry scrub, rock, snow),
 * and the street grid is drawn in the same shader from world coordinates, masked by
 * an urbanisation texture. Painting streets rather than building them costs zero
 * extra triangles for something covering 80 square kilometres, and it means the
 * roads follow the terrain exactly instead of hovering over it (spec §89).
 *
 * The avenues are deliberately wider than the side streets: from altitude they are
 * the lines the player actually navigates by (§24, §26).
 */
function groundMaterial(urbanTexture, period, roadWidth) {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.94, metalness: 0, fog: true,
  });
  mat.userData.uniforms = {
    uUrban: { value: urbanTexture },
    uWorldExtent: { value: WORLD_FAR },
    uNight: { value: 0 },
    uPeriod: { value: period },
    uRoad: { value: roadWidth },
  };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, mat.userData.uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        varying float vHeight;
        varying float vSlope;
        varying vec2 vWorldXZ;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vHeight = position.y;
        vSlope = 1.0 - abs(normalize(objectNormal).y);
        vWorldXZ = (modelMatrix * vec4(position, 1.0)).xz;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D uUrban;
        uniform float uWorldExtent;
        uniform float uNight;
        uniform float uPeriod;
        uniform float uRoad;
        varying float vHeight;
        varying float vSlope;
        varying vec2 vWorldXZ;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        vec3 sand  = vec3(0.80, 0.73, 0.55);
        vec3 grass = vec3(0.33, 0.42, 0.24);
        vec3 dry   = vec3(0.47, 0.47, 0.31);
        vec3 rock  = vec3(0.37, 0.35, 0.33);
        vec3 snow  = vec3(0.92, 0.94, 0.97);
        vec3 c = mix(sand, grass, smoothstep(2.0, 46.0, vHeight));
        c = mix(c, dry, smoothstep(120.0, 380.0, vHeight));
        c = mix(c, rock, smoothstep(0.30, 0.62, vSlope));
        c = mix(c, snow, smoothstep(560.0, 760.0, vHeight) * (1.0 - smoothstep(0.55, 0.8, vSlope)));

        // --- urban overlay
        vec2 uv = vWorldXZ / (uWorldExtent * 2.0) + 0.5;
        float urban = texture2D(uUrban, uv).r;
        urban *= 1.0 - smoothstep(0.34, 0.62, vSlope); // no streets up a cliff face

        if (urban > 0.01) {
          vec2 gd = abs(fract(vWorldXZ / uPeriod + 0.5) - 0.5) * uPeriod;
          float street = 1.0 - smoothstep(uRoad * 0.40, uRoad * 0.50, min(gd.x, gd.y));
          float avenueSpacing = uPeriod * 4.0;
          vec2 ad = abs(fract(vWorldXZ / avenueSpacing + 0.5) - 0.5) * avenueSpacing;
          float avenue = 1.0 - smoothstep(26.0, 33.0, min(ad.x, ad.y));
          float paved = max(street, avenue);
          float sidewalk = (1.0 - smoothstep(uRoad * 0.50, uRoad * 0.64, min(gd.x, gd.y))) - paved;

          vec3 asphalt = vec3(0.115, 0.125, 0.140);
          vec3 kerb = vec3(0.44, 0.44, 0.45);
          vec3 lot = vec3(0.30, 0.30, 0.29);
          c = mix(c, lot, urban * 0.55);
          c = mix(c, kerb, clamp(sidewalk, 0.0, 1.0) * urban);
          c = mix(c, asphalt, paved * urban);

          // Centre line on the avenues only, so it reads as a main road.
          float centre = (1.0 - smoothstep(0.7, 1.1, min(ad.x, ad.y))) * avenue * urban;
          c = mix(c, vec3(0.72, 0.62, 0.22), centre);
          // Sodium street lighting after dark.
          totalEmissiveRadiance += vec3(1.0, 0.72, 0.34) * paved * urban * uNight * 0.24;
        }

        // Central Park: a green void in the middle of the densest district (§25).
        float park = 1.0 - smoothstep(190.0, 265.0, length(vWorldXZ - vec2(-620.0, 640.0)));
        c = mix(c, vec3(0.27, 0.40, 0.20), park * 0.92);

        diffuseColor.rgb *= c;`);
  };
  return mat;
}

/**
 * Small texture describing how built-up each part of the world is. Built on the
 * CPU from the same district data and the same noise the building placement uses,
 * so the painted streets land where the buildings actually are.
 */
export function createUrbanTexture(regions, regionOrder, tile) {
  const size = 128;
  const data = new Uint8Array(size * size);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const x = ((i + 0.5) / size - 0.5) * WORLD_FAR * 2;
      const z = ((j + 0.5) / size - 0.5) * WORLD_FAR * 2;
      let v = 0;
      for (const id of regionOrder) {
        const r = regions[id];
        const b = r.buildings;
        if (b.rural || b.mountainous) continue;
        // Soft square falloff per district, so neighbours blend at the border.
        const dx = Math.abs(x - r.cx) / (tile / 2);
        const dz = Math.abs(z - r.cz) / (tile / 2);
        const inside = (1 - smoothstep(0.82, 1.04, dx)) * (1 - smoothstep(0.82, 1.04, dz));
        v = Math.max(v, inside * clamp01(b.density * 1.15));
      }
      const n = fbm2D(x * 0.0009, z * 0.0009, 2, 23);
      v *= 0.72 + n * 0.5;
      // No streets over water, and none across the airport: the movement area is
      // concrete, and a road grid painted over the apron reads as a mistake.
      if (isWater(x, z) || isAirportClearZone(x, z)) v = 0;
      data[j * size + i] = Math.round(clamp01(v) * 255);
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RedFormat);
  tex.needsUpdate = true;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

export function createTerrain({ urbanTexture, period = 148, roadWidth = 36 } = {}) {
  const group = new THREE.Group();
  group.name = 'terrain';
  const mat = groundMaterial(urbanTexture, period, roadWidth);

  // Inner ring: the city floor, fine enough for streets to read.
  const inner = buildRing(0, 3000, 60, mat);
  // Mid ring: the rest of the districts and the near mountains.
  const mid = buildRing(3000, 6400, 150, mat);
  // Outer ring: horizon only.
  const outer = buildRing(6400, WORLD_FAR, 520, mat);
  inner.receiveShadow = true;
  mid.receiveShadow = true;
  for (const m of [inner, mid, outer]) group.add(m);

  group.userData.uniforms = mat.userData.uniforms;
  group.userData.dispose = () => {
    for (const m of [inner, mid, outer]) m.geometry.dispose();
    mat.dispose();
  };
  return group;
}

/** Ocean surface plus the dredged harbour channel, as one non-overlapping mesh. */
export function createWater() {
  const seam = COAST_Z + 40;
  const shapes = [
    { minX: -WORLD_FAR, maxX: WORLD_FAR, minZ: seam, maxZ: WORLD_FAR * 1.6 },
    { minX: -WORLD_FAR, maxX: WORLD_FAR, minZ: COAST_Z - 340, maxZ: seam },
    { minX: INLET.minX, maxX: INLET.maxX, minZ: INLET.minZ, maxZ: COAST_Z - 340 },
  ];
  const positions = [];
  const uvs = [];
  for (const s of shapes) {
    const steps = 10;
    for (let i = 0; i < steps; i++) {
      for (let j = 0; j < steps; j++) {
        const x0 = lerp(s.minX, s.maxX, i / steps), x1 = lerp(s.minX, s.maxX, (i + 1) / steps);
        const z0 = lerp(s.minZ, s.maxZ, j / steps), z1 = lerp(s.minZ, s.maxZ, (j + 1) / steps);
        positions.push(x0, 0, z0, x1, 0, z0, x1, 0, z1, x0, 0, z0, x1, 0, z1, x0, 0, z1);
        uvs.push(x0, z0, x1, z0, x1, z1, x0, z0, x1, z1, x0, z1);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.computeVertexNormals();

  const uniforms = {
    uTime: { value: 0 },
    uShallow: { value: new THREE.Color(0x2e6f80) },
    uDeep: { value: new THREE.Color(0x0e2a3c) },
    uSky: { value: new THREE.Color(0x88b8d8) },
    uSun: { value: new THREE.Vector3(0.4, 0.7, 0.2) },
    uChop: { value: 1 },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, uniforms]),
    fog: true,
    vertexShader: `
      #include <fog_pars_vertex>
      uniform float uTime;
      uniform float uChop;
      varying vec3 vWorld;
      varying float vWave;
      void main() {
        vec3 p = position;
        // Two crossing swells: enough motion to read as sea from the air.
        float w = sin(p.x * 0.0142 + uTime * 1.15) * cos(p.z * 0.0118 - uTime * 0.92);
        float w2 = sin(p.x * 0.051 - uTime * 2.1) * 0.35;
        p.y += (w + w2) * 1.5 * uChop;
        vWave = w;
        // Must be called mvPosition: three's fog_vertex chunk below reads that exact
        // name, and naming it anything else fails to compile the whole shader, which
        // silently removes the ocean from the world.
        vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
        vWorld = (modelMatrix * vec4(p, 1.0)).xyz;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: `
      #include <fog_pars_fragment>
      uniform vec3 uShallow;
      uniform vec3 uDeep;
      uniform vec3 uSky;
      uniform vec3 uSun;
      uniform float uTime;
      varying vec3 vWorld;
      varying float vWave;
      void main() {
        float depth = smoothstep(4200.0, 6400.0, vWorld.z);
        vec3 base = mix(uShallow, uDeep, depth);
        // Fresnel-ish sky tint at grazing angles, which is most of what you see.
        vec3 viewDir = normalize(cameraPosition - vWorld);
        float fres = pow(1.0 - clamp(viewDir.y, 0.0, 1.0), 3.0);
        vec3 col = mix(base, uSky, fres * 0.75);
        // A cheap specular streak toward the sun.
        float spec = pow(max(dot(normalize(uSun), viewDir), 0.0), 24.0);
        col += vec3(1.0, 0.95, 0.85) * spec * 0.5;
        col += vWave * 0.035;
        gl_FragColor = vec4(col, 1.0);
        #include <fog_fragment>
      }`,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'water';
  mesh.matrixAutoUpdate = false;
  mesh.userData.uniforms = mat.uniforms;
  mesh.userData.dispose = () => { geo.dispose(); mat.dispose(); };
  return mesh;
}
