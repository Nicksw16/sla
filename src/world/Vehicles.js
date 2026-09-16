import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * What the traffic is made of (spec §27).
 *
 * Each class is a handful of primitives merged into a single geometry, so a bus with
 * six wheels and a window band still costs one instanced draw call for the whole city.
 * Every vertex carries a part code, which is what lets one material paint a tyre black,
 * a window dark and a headlamp bright while the instance colour only ever touches the
 * bodywork.
 *
 * Seven classes rather than one. A street where every vehicle is the same box with a
 * different colour on it reads as a car park being dragged along, and the give-away is
 * the silhouette, not the paint: what makes traffic look like traffic from the air is
 * that a van is taller than a hatchback and a pickup has a gap in the middle of it.
 */
export const PART = { BODY: 0, GLASS: 1, HEAD: 2, TAIL: 3, TYRE: 4, TRIM: 5, SIGNAL: 6 };

function tagged(geo, code, { x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0 } = {}) {
  if (rx || ry || rz) geo.rotateX(rx), geo.rotateY(ry), geo.rotateZ(rz);
  geo.translate(x, y, z);
  const n = geo.attributes.position.count;
  geo.setAttribute('aPart', new THREE.BufferAttribute(new Float32Array(n).fill(code), 1));
  return geo;
}

/** Wheels at the corners of a wheelbase, or six for the longer classes. */
function wheels(radius, width, halfTrack, positions) {
  return positions.map((z) => [1, -1].map((side) => tagged(
    new THREE.CylinderGeometry(radius, radius, width, 6),
    PART.TYRE,
    { x: side * halfTrack, y: radius, z, rz: Math.PI / 2 },
  ))).flat();
}

/** Indicators, one at each corner, so a turn can be signalled. */
function indicators(halfW, y, front, back) {
  const out = [];
  for (const side of [-1, 1]) {
    for (const [z, w] of [[front, 0.16], [back, 0.16]]) {
      out.push(tagged(new THREE.BoxGeometry(0.18, 0.12, w), PART.SIGNAL,
        { x: side * halfW, y, z }));
    }
  }
  return out;
}

/** Lamps: a bar across the front and one across the back. */
function lamps(w, yHead, yTail, front, back) {
  return [
    tagged(new THREE.BoxGeometry(w, 0.16, 0.1), PART.HEAD, { y: yHead, z: front }),
    tagged(new THREE.BoxGeometry(w, 0.16, 0.1), PART.TAIL, { y: yTail, z: back }),
  ];
}

function sedanGeometry() {
  return mergeGeometries([
    tagged(new THREE.BoxGeometry(1.86, 0.62, 4.52), PART.BODY, { y: 0.62 }),
    tagged(new THREE.BoxGeometry(1.7, 0.54, 2.0), PART.BODY, { y: 1.18, z: 0.18 }),
    tagged(new THREE.BoxGeometry(1.74, 0.38, 1.88), PART.GLASS, { y: 1.22, z: 0.18 }),
    tagged(new THREE.BoxGeometry(1.8, 0.1, 0.6), PART.TRIM, { y: 0.32, z: -2.1 }),
    ...lamps(1.24, 0.74, 0.78, -2.26, 2.26),
    ...indicators(0.94, 0.72, -2.1, 2.1),
    ...wheels(0.32, 0.22, 0.9, [-1.48, 1.44]),
  ], false);
}

function hatchGeometry() {
  return mergeGeometries([
    tagged(new THREE.BoxGeometry(1.74, 0.66, 3.74), PART.BODY, { y: 0.6 }),
    tagged(new THREE.BoxGeometry(1.62, 0.58, 1.94), PART.BODY, { y: 1.2, z: 0.34 }),
    tagged(new THREE.BoxGeometry(1.66, 0.42, 1.8), PART.GLASS, { y: 1.24, z: 0.34 }),
    ...lamps(1.1, 0.72, 0.84, -1.87, 1.87),
    ...indicators(0.88, 0.7, -1.74, 1.74),
    ...wheels(0.3, 0.2, 0.84, [-1.2, 1.22]),
  ], false);
}

function taxiGeometry() {
  return mergeGeometries([
    tagged(new THREE.BoxGeometry(1.9, 0.64, 4.66), PART.BODY, { y: 0.64 }),
    tagged(new THREE.BoxGeometry(1.74, 0.58, 2.16), PART.BODY, { y: 1.22, z: 0.12 }),
    tagged(new THREE.BoxGeometry(1.78, 0.4, 2.02), PART.GLASS, { y: 1.26, z: 0.12 }),
    // The roof sign is the whole point of a taxi at a distance.
    tagged(new THREE.BoxGeometry(0.7, 0.24, 0.3), PART.TRIM, { y: 1.63, z: 0.1 }),
    tagged(new THREE.BoxGeometry(1.92, 0.22, 2.3), PART.TRIM, { y: 0.5, z: 0.1 }),
    ...lamps(1.26, 0.76, 0.8, -2.33, 2.33),
    ...indicators(0.96, 0.74, -2.16, 2.16),
    ...wheels(0.32, 0.22, 0.92, [-1.52, 1.48]),
  ], false);
}

function vanGeometry() {
  return mergeGeometries([
    tagged(new THREE.BoxGeometry(2.0, 1.86, 5.3), PART.BODY, { y: 1.34 }),
    tagged(new THREE.BoxGeometry(1.92, 0.56, 1.1), PART.GLASS, { y: 1.86, z: -2.0 }),
    tagged(new THREE.BoxGeometry(2.04, 0.5, 1.5), PART.GLASS, { y: 1.8, z: -0.7 }),
    tagged(new THREE.BoxGeometry(2.02, 0.12, 4.6), PART.TRIM, { y: 0.52 }),
    ...lamps(1.3, 0.72, 1.6, -2.66, 2.66),
    ...indicators(1.01, 0.7, -2.5, 2.5),
    ...wheels(0.36, 0.24, 0.94, [-1.66, 1.72]),
  ], false);
}

function pickupGeometry() {
  return mergeGeometries([
    tagged(new THREE.BoxGeometry(1.94, 0.6, 2.5), PART.BODY, { y: 0.78, z: -1.1 }),
    tagged(new THREE.BoxGeometry(1.78, 0.62, 1.5), PART.BODY, { y: 1.34, z: -1.2 }),
    tagged(new THREE.BoxGeometry(1.82, 0.44, 1.4), PART.GLASS, { y: 1.38, z: -1.2 }),
    // The bed: a floor and four low sides, so there is a hole in the middle of it.
    tagged(new THREE.BoxGeometry(1.94, 0.24, 2.6), PART.BODY, { y: 0.72, z: 1.2 }),
    tagged(new THREE.BoxGeometry(0.14, 0.46, 2.6), PART.BODY, { x: 0.9, y: 1.02, z: 1.2 }),
    tagged(new THREE.BoxGeometry(0.14, 0.46, 2.6), PART.BODY, { x: -0.9, y: 1.02, z: 1.2 }),
    tagged(new THREE.BoxGeometry(1.94, 0.46, 0.14), PART.BODY, { y: 1.02, z: 2.44 }),
    ...lamps(1.2, 0.82, 0.92, -2.4, 2.5),
    ...indicators(0.98, 0.8, -2.24, 2.34),
    ...wheels(0.38, 0.26, 0.92, [-1.5, 1.42]),
  ], false);
}

function busGeometry() {
  return mergeGeometries([
    tagged(new THREE.BoxGeometry(2.5, 2.5, 11.4), PART.BODY, { y: 1.7 }),
    tagged(new THREE.BoxGeometry(2.3, 0.3, 10.8), PART.TRIM, { y: 3.02 }),
    tagged(new THREE.BoxGeometry(2.54, 0.92, 9.6), PART.GLASS, { y: 2.4 }),
    tagged(new THREE.BoxGeometry(2.2, 0.9, 0.1), PART.GLASS, { y: 2.4, z: -5.72 }),
    ...lamps(1.7, 1.0, 1.1, -5.72, 5.72),
    ...indicators(1.26, 1.0, -5.5, 5.5),
    ...wheels(0.52, 0.3, 1.14, [-3.9, 3.1, 4.3]),
  ], false);
}

function truckGeometry() {
  return mergeGeometries([
    tagged(new THREE.BoxGeometry(2.46, 2.3, 4.4), PART.BODY, { y: 1.7, z: -5.2 }),
    tagged(new THREE.BoxGeometry(2.5, 0.9, 0.12), PART.GLASS, { y: 2.5, z: -7.36 }),
    tagged(new THREE.BoxGeometry(2.6, 3.0, 10.2), PART.TRIM, { y: 2.3, z: 2.2 }),
    tagged(new THREE.BoxGeometry(0.5, 1.6, 0.4), PART.BODY, { x: 1.1, y: 2.6, z: -2.8 }),
    ...lamps(1.8, 0.9, 1.0, -7.42, 7.36),
    ...indicators(1.26, 0.9, -7.2, 7.2),
    ...wheels(0.56, 0.32, 1.12, [-6.1, 4.6, 6.0]),
  ], false);
}

/**
 * The catalogue.
 *
 * `length` is what the following model keeps its distance from, `cruise` the speed
 * range in metres per second, and `accel`/`brake` how urgently the class gets there -
 * a loaded truck pulling away from a light is not a hatchback, and at a junction that
 * difference is the whole character of the street.
 */
export const VEHICLE_CLASSES = {
  sedan: { geometry: sedanGeometry, length: 4.6, cruise: [12, 17], accel: 2.4, brake: 5.0, share: 0.3 },
  hatch: { geometry: hatchGeometry, length: 3.8, cruise: [11, 16], accel: 2.6, brake: 5.2, share: 0.24 },
  taxi: { geometry: taxiGeometry, length: 4.7, cruise: [12, 18], accel: 2.8, brake: 5.4, share: 0.12 },
  van: { geometry: vanGeometry, length: 5.4, cruise: [10, 14], accel: 1.9, brake: 4.4, share: 0.14 },
  pickup: { geometry: pickupGeometry, length: 5.0, cruise: [11, 15], accel: 2.1, brake: 4.6, share: 0.1 },
  bus: { geometry: busGeometry, length: 11.6, cruise: [8, 12], accel: 1.2, brake: 3.4, share: 0.05 },
  truck: { geometry: truckGeometry, length: 15.0, cruise: [8, 12], accel: 1.0, brake: 3.0, share: 0.05 },
};

export const VEHICLE_ORDER = Object.keys(VEHICLE_CLASSES);

/**
 * Paint.
 *
 * Weighted the way a real car park is: most of it is white, silver, grey and black, and
 * the colours are the minority that makes the rest read as individual cars. A palette
 * of six evenly-picked primaries looks like a toy shop from five hundred metres up.
 */
export const PAINT = [
  { color: 0xe8ebee, weight: 14, metal: 0.25 },  // white
  { color: 0xb9bfc6, weight: 12, metal: 0.75 },  // silver
  { color: 0x7d838b, weight: 9, metal: 0.7 },    // grey
  { color: 0x2a2e34, weight: 11, metal: 0.55 },  // near-black
  { color: 0x16181c, weight: 5, metal: 0.3 },    // matte black
  { color: 0x8d2f28, weight: 5, metal: 0.6 },    // deep red
  { color: 0xc23a2b, weight: 4, metal: 0.45 },   // red
  { color: 0x1f4f86, weight: 5, metal: 0.65 },   // blue
  { color: 0x3f7fb5, weight: 3, metal: 0.55 },   // light blue
  { color: 0x1f5c46, weight: 3, metal: 0.6 },    // racing green
  { color: 0x6b6250, weight: 3, metal: 0.4 },    // beige
  { color: 0x8c6a2f, weight: 2, metal: 0.5 },    // bronze
  { color: 0x2f3f52, weight: 3, metal: 0.65 },   // slate blue
  { color: 0xd8b32a, weight: 2, metal: 0.4 },    // yellow
];

/** Classes that do not get a random colour, because the colour is what they are. */
export const LIVERY = {
  taxi: { color: 0xf2b417, metal: 0.35 },
  bus: [{ color: 0xd8b32a, metal: 0.3 }, { color: 0xe8ebee, metal: 0.3 }, { color: 0x2d6ea8, metal: 0.35 }],
  truck: [{ color: 0xe8ebee, metal: 0.4 }, { color: 0x35507a, metal: 0.45 }, { color: 0x8a3b2c, metal: 0.4 }],
};

/**
 * One material for every vehicle.
 *
 * The part code decides what each surface is; the instance colour paints the bodywork
 * only. Two per-instance attributes go with it: how metallic this particular car's
 * paint is, so the street is not uniformly showroom-fresh, and which way it is
 * indicating, so the amber corner lamps can blink on the car that is actually turning.
 */
export function vehicleMaterial() {
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0.35 });
  mat.userData.uniforms = { uNight: { value: 0 }, uTime: { value: 0 } };
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = mat.userData.uniforms.uNight;
    shader.uniforms.uTime = mat.userData.uniforms.uTime;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float aPart;
        attribute float aFinish;
        attribute float aSignal;
        varying float vPart;
        varying float vFinish;
        varying float vSignal;
        varying float vSide;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vPart = aPart;
        vFinish = aFinish;
        vSignal = aSignal;
        // Which side of the car this vertex is on, so only the indicators on the side
        // being signalled light up.
        vSide = sign(transformed.x);`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uNight;
        uniform float uTime;
        varying float vPart;
        varying float vFinish;
        varying float vSignal;
        varying float vSide;`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        if (vPart > 3.5 && vPart < 4.5) {
          diffuseColor.rgb = vec3(0.045, 0.048, 0.052);                             // tyre
        } else if (vPart > 0.5 && vPart < 1.5) {
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.05, 0.08, 0.11), 0.82);   // glass
        } else if (vPart > 4.5 && vPart < 5.5) {
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.82, 0.84, 0.86), 0.7);    // trim
        } else if (vPart > 5.5) {
          // Indicator. Amber, and only alight on the side being signalled.
          float on = step(0.5, vSignal * vSide) * step(0.5, fract(uTime * 1.4));
          diffuseColor.rgb = mix(vec3(0.35, 0.2, 0.05), vec3(1.0, 0.6, 0.1), on);
          totalEmissiveRadiance += vec3(1.0, 0.52, 0.06) * on * (1.2 + uNight * 2.0);
        } else if (vPart > 1.5 && vPart < 2.5) {
          diffuseColor.rgb = vec3(0.85, 0.86, 0.8);
          totalEmissiveRadiance += vec3(1.0, 0.95, 0.82) * (0.25 + uNight * 2.2);
        } else if (vPart > 2.5 && vPart < 3.5) {
          diffuseColor.rgb = vec3(0.32, 0.05, 0.05);
          totalEmissiveRadiance += vec3(1.0, 0.13, 0.08) * (0.3 + uNight * 1.6);
        }`)
      // Paint finish varies per car: the same shape is a showroom saloon or a dusty
      // workhorse depending on this one number.
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        if (vPart < 0.5) roughnessFactor = mix(0.68, 0.16, vFinish);`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
        if (vPart < 0.5) metalnessFactor = mix(0.1, 0.85, vFinish);`);
  };
  return mat;
}
